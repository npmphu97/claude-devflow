#!/usr/bin/env node
// Numbers for the /retro skill, computed from git history so the agent only has to interpret them.
// Usage: retro.mjs [<days>] [--ref <branch=HEAD>] [--json]
import { spawnSync } from 'node:child_process';
import { repoRoot, loadConfig } from './config.mjs';

const root = repoRoot();
const cfg = loadConfig(root);
const args = process.argv.slice(2);
const days = Number(args.find(a => /^\d+$/.test(a)) ?? cfg.retro.days);
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'HEAD';
const asJson = args.includes('--json');
const FIX_WINDOW_DAYS = cfg.retro.fixWindowDays;
const BIG_COMMIT_LINES = cfg.retro.bigCommitLines;
const testRes = cfg.testPaths.map(p => new RegExp(p));
const isTest = f => testRes.some(r => r.test(f));
const CODE_EXT = new RegExp(`\\.(${cfg.retro.codeExtensions})$`);

const r = spawnSync('git', ['-c', 'core.quotepath=off', 'log', ref, '--no-merges', `--since=${days} days ago`, '--numstat',
  '--format=%x1e%h%x1f%ct%x1f%s'], { cwd: root ?? process.cwd(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}

const HEADER = /^([a-z]+)(?:\(([^)]*)\))?!?: /;
const commits = r.stdout.split('\x1e').filter(s => s.trim()).map(block => {
  const [head, ...rest] = block.split('\n');
  const [sha, ts, subject] = head.split('\x1f');
  const m = subject.match(HEADER);
  let lines = 0, code = 0, test = 0;
  for (const l of rest) {
    const [add, del, file] = l.split('\t');
    if (!file || add === '-') continue; // binary
    const n = Number(add) + Number(del);
    lines += n;
    if (CODE_EXT.test(file)) {
      code += n;
      if (isTest(file)) test += n;
    }
  }
  return { sha, time: Number(ts) * 1000, subject, type: m?.[1] ?? '(non-conventional)', scope: m?.[2] ?? '', lines, code, test };
}).sort((a, b) => a.time - b.time); // oldest first

const countBy = key => commits.reduce((acc, c) => ((acc[c[key] || '(none)'] = (acc[c[key] || '(none)'] ?? 0) + 1), acc), {});
const byType = countBy('type');
const byScope = countBy('scope');

// fix(scope) landing within FIX_WINDOW_DAYS after a feat(scope) of the same scope.
const feats = commits.filter(c => c.type === 'feat');
const fixesAfterFeat = commits.filter(c => c.type === 'fix' && c.scope &&
  feats.some(f => f.scope === c.scope && c.time > f.time && c.time - f.time <= FIX_WINDOW_DAYS * 86400_000));
const fixAfterFeatRatio = feats.length ? fixesAfterFeat.length / feats.length : null;

const codeLines = commits.reduce((s, c) => s + c.code, 0);
const testLines = commits.reduce((s, c) => s + c.test, 0);
const testRatio = codeLines ? testLines / codeLines : null;

const biggest = [...commits].sort((a, b) => b.lines - a.lines).slice(0, 5);

// Runs of >= 2 consecutive fix commits within one scope (scope's own commit sequence).
const chains = [];
for (const scope of Object.keys(byScope).filter(s => s !== '(none)')) {
  let run = [];
  for (const c of commits.filter(x => x.scope === scope)) {
    if (c.type === 'fix') run.push(c);
    else {
      if (run.length >= 2) chains.push({ scope, commits: run });
      run = [];
    }
  }
  if (run.length >= 2) chains.push({ scope, commits: run });
}

const result = {
  days, ref, commits: commits.length, byType, byScope,
  feats: feats.length, fixesAfterFeat: fixesAfterFeat.map(c => `${c.sha} ${c.subject}`), fixAfterFeatRatio,
  codeLines, testLines, testRatio,
  biggest: biggest.map(c => ({ sha: c.sha, lines: c.lines, subject: c.subject, overLimit: c.lines > BIG_COMMIT_LINES })),
  fixChains: chains.map(ch => ({ scope: ch.scope, commits: ch.commits.map(c => `${c.sha} ${c.subject}`) })),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const pct = x => (x === null ? 'n/a' : `${(x * 100).toFixed(0)} %`);
const table = (obj, top = Infinity) => {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const rest = rows.slice(top).reduce((s, [, v]) => s + v, 0);
  return rows.slice(0, top).map(([k, v]) => `| ${k} | ${v} |`)
    .concat(rest ? [`| (${rows.length - top} scope khác) | ${rest} |`] : []).join('\n');
};
console.log(`## Retro: ${commits.length} commit (không tính merge) trong ${days} ngày trên ${ref}

### Theo type
| Type | Commit |
|---|---|
${table(byType)}

### Theo scope
| Scope | Commit |
|---|---|
${table(byScope, 15)}

### Chỉ số
| Chỉ số | Giá trị | Mục tiêu |
|---|---|---|
| Tỉ lệ fix bám feat (fix cùng scope trong ${FIX_WINDOW_DAYS} ngày sau feat) | ${fixesAfterFeat.length} / ${feats.length} = ${pct(fixAfterFeatRatio)} | giảm dần theo tuần |
| Dòng test / dòng code thay đổi | ${testLines} / ${codeLines} = ${pct(testRatio)} | ≥ 20 % |

### Commit lớn nhất
| Commit | Dòng | Subject |
|---|---|---|
${biggest.map(c => `| ${c.sha} | ${c.lines}${c.lines > BIG_COMMIT_LINES ? ' ⚠' : ''} | ${c.subject} |`).join('\n') || '| - | - | - |'}

### Chuỗi ≥ 2 fix liên tiếp cùng scope
${chains.length ? chains.map(ch => `- **${ch.scope}**: ${ch.commits.map(c => `${c.sha} ${c.subject}`).join(' → ')}`).join('\n') : '- (không có)'}
`);
