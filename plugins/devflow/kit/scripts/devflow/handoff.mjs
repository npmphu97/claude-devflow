#!/usr/bin/env node
// Mechanical part of the /handoff skill: find the note of the current branch, pre-fill what git
// already knows (commits since the integration branch, changed files, OpenSpec task progress), and on
// resume report how stale the note is. The agent only writes the judgement fields.
// Usage: handoff.mjs            → create the note skeleton (or show the existing note)
//        handoff.mjs resume     → show the note + what changed since it was last committed
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot, loadConfig, commandHint } from './config.mjs';

function git(args, allowFail = false) {
  const r = spawnSync('git', args, { cwd: root ?? process.cwd(), encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    console.error(`git ${args.join(' ')}\n${r.stderr}`);
    process.exit(1);
  }
  return r.status === 0 ? r.stdout.trim() : null;
}

const root = repoRoot();
const cfg = loadConfig(root);
const DEV = cfg.integrationBranch;
const branch = git(['branch', '--show-current']);
if (!branch || [DEV, cfg.releaseBranch].includes(branch)) {
  console.error('✖ handoff notes belong to a task branch; checkout the task branch (its worktree) first.');
  process.exit(1);
}
const base = git(['rev-parse', '--verify', '--quiet', DEV], true) ? DEV : cfg.releaseBranch;

// OpenSpec change touched by this branch (not archived) → its handoff.md; otherwise <handoff.dir>/<branch>.md
const changesRel = cfg.handoff.openspecDir;
const changesDir = join(root, changesRel);
const touched = existsSync(changesDir)
  ? readdirSync(changesDir).filter(n => n !== 'archive' &&
      git(['log', '--oneline', `${base}..HEAD`, '--', `${changesRel}/${n}`], true))
  : [];
const change = touched[0] ?? null;
const rel = change ? `${changesRel}/${change}/handoff.md` : `${cfg.handoff.dir}/${branch.replace(/\//g, '-')}.md`;
const file = join(root, rel);

if (process.argv.includes('resume')) {
  if (!existsSync(file)) {
    console.log(`No handoff note for ${branch} (${rel}). Nothing to resume from — start from the plan / tasks.md.`);
    process.exit(0);
  }
  console.log(`=== ${rel} ===\n${readFileSync(file, 'utf8')}`);
  const noteCommit = git(['log', '-1', '--format=%h', '--', rel], true);
  if (!noteCommit) console.log('! note is not committed yet.');
  else {
    const newer = git(['log', '--oneline', `${noteCommit}..HEAD`]);
    console.log(newer
      ? `! ${newer.split('\n').length} commit(s) after the note was saved (${noteCommit}) — the note may be stale:\n${newer}`
      : `✔ no commits since the note was saved (${noteCommit}).`);
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty) console.log(`! uncommitted changes:\n${dirty}`);
  console.log('\nNext: rerun the note\'s "Lệnh test", then continue from "Tiếp theo". If the note disagrees with git/code, trust git/code and fix the note.');
  process.exit(0);
}

if (existsSync(file)) {
  console.log(`=== ${rel} already exists — update its fields in place ===\n${readFileSync(file, 'utf8')}`);
  process.exit(0);
}

const commits = git(['log', '--reverse', '--format=- %h %s', `${base}..HEAD`]) || '- (chưa có commit)';
const changed = [...new Set([
  ...(git(['-c', 'core.quotepath=off', 'diff', '--name-only', `${base}...HEAD`]) || '').split('\n'),
  ...(git(['-c', 'core.quotepath=off', 'status', '--porcelain']) || '').split('\n').map(l => l.slice(3)),
].filter(Boolean))];
let progress = '<bước dev-loop hoặc task số mấy trong tasks.md>';
if (change && existsSync(join(changesDir, change, 'tasks.md'))) {
  const tasks = readFileSync(join(changesDir, change, 'tasks.md'), 'utf8');
  const done = (tasks.match(/^\s*- \[x\]/gim) || []).length;
  const total = (tasks.match(/^\s*- \[[ x]\]/gim) || []).length;
  const next = tasks.split('\n').find(l => /^\s*- \[ \]/.test(l));
  progress = `tasks.md ${done}/${total}${next ? ` — task tiếp theo: ${next.replace(/^\s*- \[ \]\s*/, '')}` : ''}`;
}
const now = new Date();
const p2 = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;

const note = `# Handoff: ${branch} — ${stamp}
Task: <1 dòng, link issue / change${change ? ` — ${changesRel}/${change}` : ''}>
Đang ở: ${progress}
Đã xong:
${commits}
File đã đổi: ${changed.length ? changed.join(', ') : '(chưa có)'}
Tiếp theo: <1–3 việc cụ thể, việc đầu tiên làm ngay được>
Lệnh test: <lệnh đang dùng để kiểm>
Đang đỏ: <test nào, vì sao, đã thử gì>
Quyết định đã chốt: <chọn gì / bỏ gì / vì sao; ma trận test người dùng đã duyệt>
Chờ người dùng: <câu hỏi còn mở, dòng ví dụ \`chưa xác nhận\`>
Bẫy: <điều dễ sai trong vùng code này>
`;
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, note);
console.log(`✔ wrote ${rel} — fill the <...> fields (keep it ≤ ~30 lines), then commit it:\n` +
  `  ${commandHint(root, 'ship')} -- -m "chore: update handoff for ${branch}" ${rel}\n\n${note}`);
