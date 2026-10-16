// Shared task-queue file handling for queue.mjs, `flow.mjs status` and the SessionStart hook.
//
// The queue lives in the MAIN checkout (<main>/.claude/task-queue.md) and is gitignored: every task
// worktree and every session reads and writes the same file, and editing it never dirties a branch.
// Long-term history is git log + archived OpenSpec changes, not this file.
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mainCheckout } from './config.mjs';

export const SECTIONS = ['In progress', 'Ready', 'Waiting', 'Done'];
const ID_RE = /\bT-(\d+)\b/;

export function queueFile(cwd = process.cwd()) {
  const main = mainCheckout(cwd);
  return main && join(main, '.claude', 'task-queue.md');
}

/** "- [ ] T-042: title (k: v; k2: v2)" → { done, id, title, meta } */
export function parseItem(line) {
  const m = line.match(/^- \[([ x])\]\s+(T-\d+)\s*:\s*(.+)$/);
  if (!m) return null;
  let rest = m[3].trim();
  const meta = {};
  const pm = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (pm && /^\s*[a-z][\w ]*\s*:/.test(pm[2])) {
    rest = pm[1].trim();
    for (const part of pm[2].split(';')) {
      const kv = part.match(/^\s*([a-z][\w ]*?)\s*:\s*(.+?)\s*$/);
      if (kv) meta[kv[1]] = kv[2];
    }
  }
  return { done: m[1] === 'x', id: m[2], title: rest, meta };
}

function renderItem(it) {
  const meta = Object.entries(it.meta ?? {});
  const suffix = meta.length ? ` (${meta.map(([k, v]) => `${k}: ${v}`).join('; ')})` : '';
  return `- [${it.done ? 'x' : ' '}] ${it.id}: ${it.title}${suffix}`;
}

/** Sections keep raw (non-item) lines so hand-written notes survive a rewrite. */
export function load(file) {
  const sections = new Map(SECTIONS.map(s => [s, []]));
  const head = [];
  if (!file || !existsSync(file)) return { head, sections, exists: false };
  let cur = null;
  for (const line of readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h && SECTIONS.includes(h[1])) {
      cur = h[1];
      continue;
    }
    if (cur === null) {
      head.push(line);
      continue;
    }
    if (line.trim() === '') continue; // save() re-adds the blank line after each header
    const item = parseItem(line);
    sections.get(cur).push(item ? { type: 'item', item } : { type: 'raw', line });
  }
  return { head, sections, exists: true };
}

export function save(file, { head, sections }) {
  mkdirSync(dirname(file), { recursive: true });
  const out = [...head];
  for (const s of SECTIONS) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`## ${s}`, '');
    for (const e of sections.get(s)) out.push(e.type === 'item' ? renderItem(e.item) : e.line);
  }
  writeFileSync(file, `${out.join('\n').replace(/\n+$/, '\n')}`);
}

/** Run fn() holding <file>.lock, so two sessions never interleave load → save. A lock older than
 * 30 s is left over from a crashed run and is taken over. */
export function withLock(file, fn) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; }
      } catch { continue; } // lock vanished between the calls: retry
      if (Date.now() > deadline) throw new Error(`queue is locked by another session (${lock}); retry, or delete the lock if no one is running queue.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

export const itemsOf = sections => SECTIONS.flatMap(s => sections.get(s).filter(e => e.type === 'item').map(e => ({ ...e.item, section: s })));
export const findItem = (sections, id) => itemsOf(sections).find(i => i.id === id);
export const isDoneItem = i => i.section === 'Done' || i.done;
export const blockersOf = it => (it.meta?.['blocked by'] ?? '').split(/[, ]+/).filter(Boolean);

export function nextId(sections) {
  let max = 0;
  for (const i of itemsOf(sections)) max = Math.max(max, Number(i.id.match(ID_RE)[1]));
  return `T-${String(max + 1).padStart(3, '0')}`;
}

/** First open blocker of `it` (unknown ids count as open — safe), or null. */
export function openBlocker(sections, it) {
  for (const dep of blockersOf(it)) {
    const depItem = findItem(sections, dep);
    if (!depItem || !isDoneItem(depItem)) return { id: dep, unknown: !depItem };
  }
  return null;
}

/** Ready = in ## Ready, not done, every `blocked by` id is done. */
export function readyItems(sections) {
  const warnings = [];
  const blocked = [];
  const ready = sections.get('Ready')
    .filter(e => e.type === 'item' && !e.item.done)
    .map(e => e.item)
    .filter(it => {
      const b = openBlocker(sections, it);
      if (!b) return true;
      if (b.unknown) warnings.push(`${it.id} references unknown ${b.id} — treated as blocked`);
      blocked.push({ ...it, waitingOn: b.id });
      return false;
    });
  return { ready, blocked, warnings };
}

/** "tasks 3/8" for an OpenSpec change pointer, best-effort. */
function changeProgress(root, change) {
  try {
    const tasks = readFileSync(join(root, change, 'tasks.md'), 'utf8');
    const done = (tasks.match(/^\s*- \[x\]/gim) || []).length;
    const total = (tasks.match(/^\s*- \[[ x]\]/gim) || []).length;
    return total ? `tasks ${done}/${total}` : null;
  } catch {
    return null;
  }
}

export function describe(it, { root, hideBlockedBy = false } = {}) {
  const bits = [];
  if (it.meta?.['blocked by'] && !hideBlockedBy) bits.push(`blocked by: ${it.meta['blocked by']}`);
  if (it.meta?.size) bits.push(it.meta.size);
  if (it.meta?.branch) bits.push(it.meta.branch);
  if (it.meta?.change) bits.push((root && changeProgress(root, it.meta.change)) ?? it.meta.change);
  if (it.meta?.reason) bits.push(`chờ: ${it.meta.reason}`);
  return `${it.id}: ${it.title}${bits.length ? ` (${bits.join('; ')})` : ''}`;
}
