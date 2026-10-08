#!/usr/bin/env node
// Machine check of the project's hard rules on the lines a branch adds or removes vs a base branch
// (committed + uncommitted + untracked). ERROR = definite violation; WARN = suspect the agent/verifier
// must look at (heuristic, may be a false positive).
// Built-in rules are stack-neutral (disabled / deleted tests, hand-edited versions, hardcoded secrets);
// project rules come from .devflow.json ("rules", "rulesModule").
// Usage: hard-rules.mjs [--base <branch>] [--strict]   (--strict: exit 1 when there is an ERROR)
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot, loadConfig } from './config.mjs';

const args = process.argv.slice(2);
const root = repoRoot();
if (!root) {
  console.error('not inside a git repository');
  process.exit(2);
}
const cfg = loadConfig(root);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : cfg.integrationBranch;
const strict = args.includes('--strict');

function git(a) {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`git ${a.join(' ')}\n${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}
const mergeBase = git(['merge-base', base, 'HEAD']).trim();

// ---- collect added/removed lines per file ----
/** @type {Map<string, {added: {n:number,text:string}[], removed: {n:number,text:string}[], isNew: boolean}>} */
const files = new Map();
const entry = f => files.get(f) ?? (files.set(f, { added: [], removed: [], isNew: false }), files.get(f));

// A deleted file shows as `+++ /dev/null`: keep its old path so its removed lines (tests, assertions)
// are still checked.
let cur = null, oldPath = null, newLine = 0, oldLine = 0;
for (const line of git(['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', mergeBase]).split('\n')) {
  if (line.startsWith('diff --git')) cur = null;
  else if (line.startsWith('--- ')) oldPath = line === '--- /dev/null' ? null : line.slice(6);
  else if (line.startsWith('+++ ')) {
    cur = line === '+++ /dev/null' ? oldPath : line.slice(6);
    if (cur && oldPath === null) entry(cur).isNew = true;
  } else if (line.startsWith('@@')) {
    const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    oldLine = Number(m[1]);
    newLine = Number(m[2]);
  } else if (cur && line.startsWith('+')) entry(cur).added.push({ n: newLine++, text: line.slice(1) });
  else if (cur && line.startsWith('-')) entry(cur).removed.push({ n: oldLine++, text: line.slice(1) });
}
for (const f of git(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
  const e = entry(f);
  e.isNew = true;
  try {
    e.added = readFileSync(join(root, f), 'utf8').split('\n').map((text, i) => ({ n: i + 1, text }));
  } catch { /* unreadable / binary */ }
}

// ---- helpers ----
const findings = [];
const add = (level, file, n, msg) => findings.push({ level, file, n, msg });
const isCode = t => !/^\s*(\/\/|\*|\/\*|#(?!\[)|--|<!--)/.test(t); // skip comment lines
const testRes = cfg.testPaths.map(p => new RegExp(p));
const isTest = f => testRes.some(r => r.test(f));
const CODE_EXT = new RegExp(`\\.(${cfg.retro.codeExtensions})$`);

// ---- built-in rules ----
// Disabled / focused tests: hides failures or silently skips the rest of the suite.
const DISABLE = [
  [/^\s*@(Disabled|Ignore)\b/, '@Disabled / @Ignore'],
  [/\b(xit|xdescribe|xtest|fit|fdescribe)\(/, 'xit / xdescribe / fit / fdescribe'],
  [/\b(it|test|describe|context)\.(skip|only|todo)\(/, '.skip / .only'],
  [/@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\(|@unittest\.skip/, 'pytest / unittest skip'],
  [/\bt\.Skip(Now|f)?\(/, 'go t.Skip'],
  [/#\[ignore\]/, 'rust #[ignore]'],
];
const TEST_DECL = /^\s*(@(Test|ParameterizedTest|RepeatedTest)\b|(it|test)\s*\(|def\s+test_|func\s+Test[A-Z_]|#\[test\])/;
const ASSERT = /\b(assert\w*|expect|verify|should)\s*\(|\bassert\s/;

const versionFiles = cfg.versionFiles.map(v => (typeof v === 'string' ? { file: v, type: 'json' } : v));

for (const [f, { added, removed }] of files) {
  if (isTest(f)) {
    for (const l of added) for (const [re, what] of DISABLE) if (re.test(l.text)) add('ERROR', f, l.n, `${what}: never disable or focus tests`);
    const removedTests = removed.filter(l => TEST_DECL.test(l.text)).length;
    const addedTests = added.filter(l => TEST_DECL.test(l.text)).length;
    if (removedTests > addedTests) add('WARN', f, removed[0].n, `${removedTests - addedTests} test(s) removed — never delete existing tests (ignore if renamed/split)`);
    const removedAsserts = removed.filter(l => ASSERT.test(l.text)).length;
    const addedAsserts = added.filter(l => ASSERT.test(l.text)).length;
    if (removedAsserts > addedAsserts) add('WARN', f, removed[0].n, `${removedAsserts - addedAsserts} assertion(s) removed — never weaken tests to make them pass`);
  }

  const vf = versionFiles.find(v => v.file === f);
  if (vf && existsSync(join(root, f))) {
    if (vf.type === 'json') {
      for (const l of added) if (/"version"\s*:/.test(l.text)) add('ERROR', f, l.n, '"version" edited by hand — the version is the tag made by promote');
    } else if (vf.type === 'maven') {
      // The project's own <version> is the first one after </parent> (the parent block has its own).
      const pom = readFileSync(join(root, f), 'utf8').split('\n');
      const afterParent = pom.findIndex(t => /<\/parent>/.test(t)) + 1;
      const projectVersionLine = pom.findIndex((t, i) => i >= afterParent && /<version>/.test(t)) + 1;
      for (const l of added) if (l.n === projectVersionLine) add('ERROR', f, l.n, 'project <version> edited by hand — the version is the tag made by promote');
    } else if (vf.regex) {
      const re = new RegExp(vf.regex);
      for (const l of added) if (re.test(l.text)) add('ERROR', f, l.n, 'version edited by hand — the version is the tag made by promote');
    }
  }

  if (CODE_EXT.test(f) && !isTest(f)) {
    for (const l of added.filter(l => isCode(l.text))) {
      if (/(password|passwd|pwd|secret|api[_-]?key|token|private[_-]?key)\w*["']?\s*[:=]\s*["'][^"'\s$%{]{6,}["']/i.test(l.text)) {
        add('WARN', f, l.n, 'possible hardcoded password / secret — read it from env/config instead');
      }
    }
  }
}

// ---- project rules from .devflow.json ----
const changed = [...files.keys()];
for (const rule of cfg.rules) {
  if (rule.unlessChanged && changed.some(f => new RegExp(rule.unlessChanged).test(f))) continue;
  const fileRe = new RegExp(rule.files ?? '.');
  const skipComments = rule.skipComments !== false;
  let hits = 0;
  for (const [f, { added, removed, isNew }] of files) {
    if (!fileRe.test(f) || (rule.newFilesOnly && !isNew) || (rule.existingFilesOnly && isNew)) continue;
    for (const [kind, lines] of [['added', added], ['removed', removed]]) {
      if (!rule[kind]) continue;
      const re = new RegExp(rule[kind], rule.flags ?? '');
      for (const l of lines) {
        if (skipComments && !isCode(l.text)) continue;
        if (re.test(l.text) && (!rule.once || hits === 0)) {
          add(rule.level ?? 'WARN', f, l.n, rule.msg);
          hits++;
        }
      }
    }
    if (!rule.added && !rule.removed && (!rule.once || hits === 0)) {
      add(rule.level ?? 'WARN', f, 1, rule.msg); // file-level rule: matching path is the finding
      hits++;
    }
  }
}

if (cfg.rulesModule) {
  const mod = join(root, cfg.rulesModule);
  if (!existsSync(mod)) {
    console.error(`rulesModule ${cfg.rulesModule} not found`);
    process.exit(2);
  }
  const { default: run } = await import(pathToFileURL(mod).href);
  await run({ files, add, root, isCode, isTest, readFile: f => readFileSync(join(root, f), 'utf8') });
}

// ---- report ----
const errors = findings.filter(x => x.level === 'ERROR');
console.log(`hard-rules: ${files.size} file(s) changed vs ${base} (${mergeBase.slice(0, 7)}) — ${errors.length} ERROR, ${findings.length - errors.length} WARN`);
for (const x of findings) console.log(`  ${x.level.padEnd(5)} ${x.file}:${x.n}  ${x.msg}`);
if (strict && errors.length) process.exit(1);
