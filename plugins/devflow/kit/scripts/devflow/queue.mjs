#!/usr/bin/env node
// Mechanical part of the /devflow:queue skill: a shared task queue in <main checkout>/.claude/task-queue.md.
//
// The queue is an INDEX, not the details:
//   - small task  → lives on its branch (one worktree per task)
//   - big task    → lives in openspec/changes/<name>/ (checklist in tasks.md)
//   - session state → handoff note (.claude/handoff/<branch>.md)
// The queue only answers: what is left, what can be done now, what is stuck.
//
// One file for everyone: it sits in the main checkout and is gitignored, so every task worktree and
// session sees the same queue and editing it never dirties a branch. Writes hold a lock file.
//
// Conventions (also in the file's header comment):
//   - IDs are T-NNN, handed out ONLY by `queue.mjs add` (never hand-pick).
//   - A task is "ready" when every ID in its `blocked by:` is done.
//   - Order inside ## Ready is priority order and is owned by the human; the agent never reorders.
//   - Claim = `start <id> --branch <type/scope-desc>`: marks the task In progress and creates the
//     task's branch + worktree (flow.mjs task). A second claim of the same task is refused.
// Usage:
//   queue.mjs                                    → compact status
//   queue.mjs ready                              → tasks with no open blockers, priority order
//   queue.mjs next                               → the single top ready task (for "give me work")
//   queue.mjs add --title "..." [--size small|large] [--blocked-by T-1,T-2]
//                  [--change openspec/changes/x] [--branch feat/y] [--wait "reason"]
//   queue.mjs start <id> [--branch feat/y] [--force]  → claim: In progress + worktree
//   queue.mjs block <id> --reason "..."         → move to Waiting
//   queue.mjs unblock <id>                       → Waiting → end of Ready
//   queue.mjs done <id>                          → move to Done (dated)
//   queue.mjs prune [--days 7]                   → drop Done items older than N days
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckout } from './config.mjs';
import {
  SECTIONS, queueFile, load, save, withLock, itemsOf, findItem, nextId, openBlocker, readyItems, describe,
} from './queue-lib.mjs';

const MAIN_ROOT = mainCheckout();
if (!MAIN_ROOT) {
  console.error('not inside a git repository');
  process.exit(2);
}
const FILE = queueFile();
const FLOW = join(dirname(fileURLToPath(import.meta.url)), 'flow.mjs');
const BRANCH_RE = /^[a-z]+\/[a-z0-9][a-z0-9._-]*$/;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

/** Abort inside a mutate() callback: throws so the lock is released, then mutate() dies. */
const fail = msg => { throw new Error(msg); };

const branchExists = b => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: MAIN_ROOT }).status === 0;

/** load → fn(state) → save, under the queue lock. fn may fail() before anything is written. */
function mutate(fn) {
  try {
    return withLock(FILE, () => {
      const state = load(FILE);
      const out = fn(state);
      save(FILE, state);
      return out;
    });
  } catch (e) {
    die(e.message);
  }
}

// ---------- args ----------

function parseArgs(argv) {
  const opts = { flags: {} };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      opts.flags[k] = argv[i + 1]?.startsWith('--') || i + 1 >= argv.length ? true : argv[++i];
    } else positional.push(a);
  }
  return { opts, positional };
}
const str = v => (v && v !== true ? v : null);

// ---------- commands ----------

function cmdStatus() {
  const { sections, exists } = load(FILE);
  if (!exists) return console.log('no .claude/task-queue.md — add the first task with: npm run queue -- add --title "..."');
  const all = itemsOf(sections);
  const count = s => all.filter(i => i.section === s).length;
  console.log(`queue: ${count('In progress')} in progress · ${count('Ready')} ready · ${count('Waiting')} waiting · ${count('Done')} done`);
  for (const s of ['In progress', 'Waiting']) {
    const items = sections.get(s).filter(e => e.type === 'item').map(e => e.item);
    if (!items.length) continue;
    console.log(`\n## ${s}`);
    for (const it of items) {
      const gone = s === 'In progress' && it.meta?.branch && !branchExists(it.meta.branch);
      console.log(`  ${describe(it, { root: MAIN_ROOT })}${gone ? ' ! branch is gone — landed? run: queue done ' + it.id : ''}`);
    }
  }
  const { ready, blocked, warnings } = readyItems(sections);
  console.log(`\n## Ready (${ready.length} unblocked)`);
  for (const it of ready) console.log(`  ${describe(it, { root: MAIN_ROOT, hideBlockedBy: true })}`);
  for (const it of blocked) console.log(`  ${it.id}: ${it.title} (đợi ${it.waitingOn})`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

function cmdReady() {
  const { sections } = load(FILE);
  const { ready, warnings } = readyItems(sections);
  if (!ready.length) console.log('(no ready task — everything is blocked, waiting or done)');
  for (const it of ready) console.log(describe(it, { root: MAIN_ROOT, hideBlockedBy: true }));
  for (const w of warnings) console.error(`! ${w}`);
}

function cmdNext() {
  const { sections } = load(FILE);
  const { ready } = readyItems(sections);
  if (!ready.length) die('no ready task — nothing to pick up.');
  console.log(describe(ready[0], { root: MAIN_ROOT, hideBlockedBy: true }));
}

function cmdAdd({ opts }) {
  const title = str(opts.flags.title);
  if (!title) die('add needs --title "..."');
  const branch = str(opts.flags.branch);
  if (branch && !BRANCH_RE.test(branch)) die(`--branch must look like <type>/<scope>-<desc>, e.g. feat/billing-export-csv (got "${branch}")`);
  const { id, section } = mutate(({ sections }) => {
    const id = nextId(sections);
    const meta = {};
    for (const k of ['size', 'blocked by', 'change', 'branch']) {
      const v = str(opts.flags[k.replace(/ /g, '-')]);
      if (v) meta[k] = v;
    }
    // A new task cannot close a cycle (nobody depends on it yet); an unknown blocker is a typo.
    for (const dep of (meta['blocked by'] ?? '').split(/[, ]+/).filter(Boolean)) {
      if (!findItem(sections, dep)) fail(`--blocked-by ${dep}: no such task in the queue.`);
    }
    const wait = str(opts.flags.wait);
    const section = wait ? 'Waiting' : 'Ready';
    if (wait) meta.reason = wait;
    sections.get(section).push({ type: 'item', item: { done: false, id, title, meta } });
    return { id, section };
  });
  console.log(`✔ ${id} → ${section}: ${title}`);
}

/** Move `id` to `target` (appended, or at index `at`); returns the section it came from, or null. */
function moveTo(sections, id, target, change, at = null) {
  for (const s of SECTIONS) {
    const list = sections.get(s);
    const idx = list.findIndex(e => e.type === 'item' && e.item.id === id);
    if (idx >= 0) {
      const entry = list.splice(idx, 1)[0];
      if (change) change(entry.item);
      if (at === null) sections.get(target).push(entry);
      else sections.get(target).splice(at, 0, entry);
      return s;
    }
  }
  return null;
}

/** Claim: under the lock, refuse a task someone already holds (or that is not ready), mark it
 * In progress with its branch; then create the branch + worktree. If that fails, undo the claim. */
function cmdStart({ opts, positional }) {
  const id = positional[0];
  if (!id) die('usage: queue.mjs start <id> [--branch feat/y] [--force]');
  const force = opts.flags.force === true;
  const flagBranch = str(opts.flags.branch);
  if (flagBranch && !BRANCH_RE.test(flagBranch)) die(`--branch must look like <type>/<scope>-<desc>, e.g. feat/billing-export-csv (got "${flagBranch}")`);

  const claim = mutate(({ sections }) => {
    const it = findItem(sections, id);
    if (!it) fail(`no such task: ${id}`);
    if (it.section === 'In progress' && !force) fail(`${id} is already claimed${it.meta?.branch ? ` (branch ${it.meta.branch})` : ''} — pick another task, or --force if that claim is stale.`);
    if (it.section === 'Done') fail(`${id} is already done.`);
    const blocker = openBlocker(sections, it);
    if (blocker && !force) fail(`${id} is not ready: waits on ${blocker.id}${blocker.unknown ? ' (unknown id)' : ''}. Use --force to start anyway.`);
    const branch = flagBranch ?? it.meta?.branch ?? null;
    if (branch && branchExists(branch) && !force) fail(`branch ${branch} already exists — someone may be on it. Enter its worktree, or --force to claim with the existing branch.`);
    const at = sections.get(it.section).findIndex(e => e.type === 'item' && e.item.id === id);
    const prevMeta = { ...it.meta };
    const from = moveTo(sections, id, 'In progress', item => {
      if (branch) item.meta.branch = branch;
      delete item.meta.reason;
    });
    return { from, at, branch, prevMeta };
  });

  if (claim.branch && !branchExists(claim.branch)) {
    const r = spawnSync(process.execPath, [FLOW, 'task', '--', claim.branch], { cwd: MAIN_ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      mutate(({ sections }) => { moveTo(sections, id, claim.from, item => { item.meta = claim.prevMeta; }, claim.at); });
      die(`could not create the worktree for ${claim.branch} — claim of ${id} undone.`);
    }
  }
  console.log(`✔ ${id} claimed → In progress (was: ${claim.from})`);
  if (!claim.branch) console.log('  ! no branch: create the worktree yourself (npm run task -- <type>/<scope>-<desc>), or next time use --branch.');
}

function cmdBlock({ opts, positional }) {
  const id = positional[0];
  const reason = str(opts.flags.reason);
  if (!id || !reason) die('usage: queue.mjs block <id> --reason "..."');
  mutate(({ sections }) => {
    if (!moveTo(sections, id, 'Waiting', it => { it.meta.reason = reason; })) fail(`no such task: ${id}`);
  });
  console.log(`✔ ${id} → Waiting: ${reason}`);
}

function cmdUnblock({ positional }) {
  const id = positional[0];
  if (!id) die('usage: queue.mjs unblock <id>');
  mutate(({ sections }) => {
    const it = findItem(sections, id);
    if (!it) fail(`no such task: ${id}`);
    if (it.section !== 'Waiting') fail(`${id} is in ${it.section}, not Waiting.`);
    moveTo(sections, id, 'Ready', item => { delete item.meta.reason; });
  });
  console.log(`✔ ${id} → Ready (end of the list — the human reorders priority)`);
}

function cmdDone({ positional }) {
  const id = positional[0];
  if (!id) die('usage: queue.mjs done <id>');
  mutate(({ sections }) => {
    const from = moveTo(sections, id, 'Done', it => {
      it.done = true;
      it.meta.done = today();
      delete it.meta.reason;
    });
    if (!from) fail(`no such task: ${id}`);
  });
  console.log(`✔ ${id} done (${today()})`);
}

function cmdPrune({ opts }) {
  const days = Number(opts.flags.days ?? 7);
  const cutoff = new Date(today());
  const dropped = mutate(({ sections }) => {
    const list = sections.get('Done');
    const kept = list.filter(e => {
      if (e.type !== 'item') return true;
      const d = e.item.meta?.done;
      if (!d) return true; // undated: keep, cannot tell its age
      return Math.round((cutoff - new Date(d)) / 86400_000) <= days;
    });
    sections.set('Done', kept);
    return list.length - kept.length;
  });
  console.log(`✔ pruned ${dropped} done item(s) older than ${days} days`);
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
switch (command) {
  case undefined: cmdStatus(); break;
  case 'ready': cmdReady(); break;
  case 'next': cmdNext(); break;
  case 'add': cmdAdd(parsed); break;
  case 'start': cmdStart(parsed); break;
  case 'block': cmdBlock(parsed); break;
  case 'unblock': cmdUnblock(parsed); break;
  case 'done': cmdDone(parsed); break;
  case 'prune': cmdPrune(parsed); break;
  default:
    console.log(`Usage (queue file: ${FILE} — shared by every worktree, not committed):
  queue.mjs                                  compact status
  queue.mjs ready                            tasks with no open blockers, priority order
  queue.mjs next                             the single top ready task
  queue.mjs add --title "..." [--size small|large] [--blocked-by T-1,T-2]
               [--change openspec/changes/x] [--branch feat/y] [--wait "reason"]
  queue.mjs start <id> [--branch feat/y] [--force]
                                             claim (→ In progress) + create the branch's worktree
  queue.mjs block <id> --reason "..."        park a task (→ Waiting)
  queue.mjs unblock <id>                     Waiting → end of Ready
  queue.mjs done <id>                        mark landed (→ Done, dated)
  queue.mjs prune [--days 7]                 drop Done items older than N days`);
    process.exit(command && command !== 'help' ? 1 : 0);
}
