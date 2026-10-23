// devflow self-tests: `npm run devflow-test` (node --test) in any repo with devflow installed.
// Covers the guard rules (unit) and the CLI scripts (hard-rules, flow task/ship/check/land/promote,
// doctor) end-to-end on throwaway git repos under the OS temp dir.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCommand } from '../../../hooks/guard-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOW = join(HERE, 'flow.mjs');
const HARD_RULES = join(HERE, 'hard-rules.mjs');
const QUEUE = join(HERE, 'queue.mjs');
const WCLEAN = join(HERE, 'worktrees-clean.mjs');
const HOOKS = join(HERE, '..', '..', '..', 'hooks');
const node = process.execPath;
const ctx = (current, guard = {}) => ({
  dev: 'dev', main: 'main', current,
  guard: { blockSkipTests: true, blockManualPush: true, blockGhPr: true, blockBranchMoves: true, blockDestructiveSql: true, ...guard },
});
const blocked = (cmd, current = 'feat/x', guard) => checkCommand(cmd, ctx(current, guard)) !== null;

describe('guard rules', () => {
  it('blocks the dangerous commands, allows the normal ones', () => {
    assert.equal(blocked('git push origin dev', 'dev'), true);
    assert.equal(blocked('git push', 'feat/x'), true);
    assert.equal(blocked('npm run land', 'feat/x'), false);
    assert.equal(blocked('./mvnw -B test -DskipTests'), true);
    assert.equal(blocked('pytest --no-tests'), true);
    assert.equal(blocked('npm test'), false);
    assert.equal(blocked('gh pr create'), true);
    assert.equal(blocked('git branch -D dev'), true);
    assert.equal(blocked('git branch -f main abc1234'), true);
    assert.equal(blocked('git checkout -B dev'), true);
    assert.equal(blocked('git switch -C main'), true);
    assert.equal(blocked('git checkout -b feat/new'), false);
    assert.equal(blocked('git merge feat/x', 'dev'), true);
    assert.equal(blocked('git merge --no-ff feat/x'), true);
    assert.equal(blocked('git reset --hard', 'dev'), true);
    assert.equal(blocked('git reset --hard dev', 'feat/x'), true);
    assert.equal(blocked('git reset --hard HEAD~1', 'feat/x'), false);
    assert.equal(blocked('psql -c "drop table users"'), true);
    assert.equal(blocked('mysql -e "delete from t"'), true);
    assert.equal(blocked('rm -rf /tmp/build'), false);
    assert.equal(blocked('rm -rf /'), true);
    assert.equal(blocked('echo "git push origin"'), false);
    assert.equal(blocked('git commit -m "wip: git push later"'), false);
  });

  it('is fully disabled when the repo opts out via guard flags', () => {
    const off = { blockSkipTests: false, blockManualPush: false, blockGhPr: false, blockBranchMoves: false, blockDestructiveSql: false };
    assert.equal(blocked('git push', 'x', off), false);
    assert.equal(blocked('git merge x', 'x', off), false);
    assert.equal(blocked('rm -rf /', 'x', off), true); // rm -rf / is always blocked
  });
});

// ---------- e2e on throwaway repos ----------

const roots = [];
function mkRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-test-'));
  roots.push(root);
  const git = (args, opts = {}) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 'T']);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: initial']);
  git(['branch', 'dev', 'main']);
  const run = (script, args, opts = {}) => spawnSync(node, [script, ...args],
    { cwd: root, encoding: 'utf8', ...opts });
  return { root, git, run };
}

after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const DEV_FLOW_JSON = {
  integrationBranch: 'dev', releaseBranch: 'main', remote: null, commitlint: false,
  areas: [{ name: 't', paths: [''], commands: [{ label: 't', run: 'node -e "process.exit(0)"' }] }],
};

describe('flow: task → ship → check → land → promote', () => {
  let repo;
  before(() => {
    repo = mkRepo({
      '.devflow.json': JSON.stringify(DEV_FLOW_JSON, null, 2),
      'a.txt': 'a\n',
    });
  });

  it('task creates a worktree on a new branch from dev', () => {
    const r = repo.run(FLOW, ['task', '--', 'feat/thing']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ready/);
    assert.equal(repo.git(['branch', '--show-current']), 'main');
    const wt = repo.git(['worktree', 'list', '--porcelain']).split('\n')[0].slice(9);
    assert.ok(wt.length > 0);
  });

  it('ship commits only the listed files with a conventional message', () => {
    const wt = join(repo.root, '.claude', 'worktrees', 'feat-thing');
    writeFileSync(join(wt, 'a.txt'), 'a\nb\n');
    const r = repo.run(FLOW, ['ship', '-m', 'feat(t): add thing', 'a.txt'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(repo.git(['log', 'feat/thing', '--format=%s', '-1']), 'feat(t): add thing');
  });

  it('ship rejects a non-conventional message', () => {
    const r = repo.run(FLOW, ['ship', '-m', 'oops no format', 'a.txt'], { cwd: join(repo.root, '.claude', 'worktrees', 'feat-thing') });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Conventional Commit/);
  });

  it('check runs the gate and land fast-forwards dev', () => {
    const wt = join(repo.root, '.claude', 'worktrees', 'feat-thing');
    let r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = repo.run(FLOW, ['land'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(repo.git(['rev-parse', 'dev']), repo.git(['rev-parse', 'feat/thing']));
  });

  it('promote fast-forwards main and tags a version', () => {
    const r = repo.run(FLOW, ['promote']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(repo.git(['rev-parse', 'main']), repo.git(['rev-parse', 'dev']));
    assert.equal(repo.git(['tag', '--list', 'v*']), 'v1.0.0');
  });

  it('untask removes the worktree safely', () => {
    const r = repo.run(FLOW, ['untask', '--', 'feat/thing']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(repo.git(['worktree', 'list']), /feat-thing/);
  });

  it('doctor reports a healthy repo', () => {
    const r = repo.run(FLOW, ['doctor']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /everything looks good/);
  });
});

describe('flow: gate cache, parallel areas, isolated ship, cloud-push', () => {
  const taskBranch = (repo, name) => {
    const r = repo.run(FLOW, ['task', '--', name]);
    assert.equal(r.status, 0, r.stderr);
    return join(repo.root, '.claude', 'worktrees', name.replace('/', '-'));
  };

  it('gate is skipped for the same HEAD on a clean tree; --no-cache reruns it', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON), 'a.txt': 'a\n' });
    const wt = taskBranch(repo, 'feat/cache');
    writeFileSync(join(wt, 'a.txt'), 'a\nb\n');
    assert.equal(repo.run(FLOW, ['ship', '-m', 'feat(t): cache', 'a.txt'], { cwd: wt }).status, 0);
    let r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /already passed/);
    r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.match(r.stdout, /already passed/);
    r = repo.run(FLOW, ['check', '--no-cache'], { cwd: wt });
    assert.doesNotMatch(r.stdout, /already passed/);
  });

  it('gate cache follows the content: uncommitted work checked once, committing it does not rerun', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON), 'a.txt': 'a\n' });
    const wt = taskBranch(repo, 'feat/dirty');
    const check = () => repo.run(FLOW, ['check'], { cwd: wt });
    writeFileSync(join(wt, 'a.txt'), 'a\nb\n');
    writeFileSync(join(wt, 'new.txt'), 'n\n');
    let r = check();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /already passed/);
    assert.match(check().stdout, /already passed/);
    writeFileSync(join(wt, 'new.txt'), 'n2\n'); // untracked file changed → rerun
    assert.doesNotMatch(check().stdout, /already passed/);
    assert.equal(repo.run(FLOW, ['ship', '-m', 'feat(t): dirty', 'a.txt', 'new.txt'], { cwd: wt }).status, 0);
    assert.match(check().stdout, /already passed/);
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }).stdout, ''); // real index untouched
  });

  it('gate output goes to a log file: one line when green, the tail when red', () => {
    const lines = n => `node -e "for(let i=1;i<=${n};i++)console.log('line-'+i)"`;
    const cfg = { ...DEV_FLOW_JSON, areas: [
      { name: 'ok', paths: ['a/'], commands: [{ label: 'chatty', run: lines(100) }] },
      { name: 'bad', paths: ['b/'], commands: [{ label: 'loud fail', run: `${lines(100)} && node -e "process.exit(3)"` }] },
    ] };
    const repo = mkRepo({ '.devflow.json': JSON.stringify(cfg), 'a/x.txt': 'x\n', 'b/y.txt': 'y\n' });
    const wt = taskBranch(repo, 'feat/logs');
    writeFileSync(join(wt, 'a/x.txt'), 'x2\n');
    let r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /line-50/);
    const okLog = r.stdout.match(/log: (.+ok-chatty\.log)\)/)[1];
    assert.match(readFileSync(okLog, 'utf8'), /line-1\n[\s\S]*line-100/);
    writeFileSync(join(wt, 'b/y.txt'), 'y2\n');
    r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.notEqual(r.status, 0);
    const out = r.stdout + r.stderr;
    assert.match(out, /exit 3 .*last 60 of 100 lines/);
    assert.match(out, /line-100/);
    assert.doesNotMatch(out, /line-40\n/);
    assert.match(out, /bad-loud-fail\.log/);
  });

  it('gate.maxParallel: 1 runs the areas one after another; default runs them side by side', () => {
    // Each command holds a lock file for 800 ms; a second command finding it taken fails.
    const lock = join(mkdtempSync(join(tmpdir(), 'devflow-lock-')), 'running').replace(/\\/g, '/');
    roots.push(dirname(lock));
    const hold = `node -e "const fs=require('fs');fs.writeFileSync('${lock}','',{flag:'wx'});` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);fs.unlinkSync('${lock}')"`;
    const areas = [
      { name: 'a', paths: ['a/'], commands: [{ label: 'hold', run: hold }] },
      { name: 'b', paths: ['b/'], commands: [{ label: 'hold', run: hold }] },
    ];
    const gateRun = gate => {
      const repo = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, areas, ...(gate && { gate }) }), 'a/x.txt': 'x\n', 'b/y.txt': 'y\n' });
      const wt = taskBranch(repo, 'feat/par');
      writeFileSync(join(wt, 'a/x.txt'), 'x2\n');
      writeFileSync(join(wt, 'b/y.txt'), 'y2\n');
      return repo.run(FLOW, ['check'], { cwd: wt });
    };
    let r = gateRun({ maxParallel: 1 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = gateRun(null);
    assert.notEqual(r.status, 0, 'areas should overlap by default');
    assert.match(r.stdout + r.stderr, /EEXIST/);
  });

  it('eslint base counts: one in-process run through the API, CLI per file when there is no API', () => {
    // Fake eslint: a warning per "WARN" in the text. The CLI records every --stdin call.
    const count = 't=>(t.match(/WARN/g)||[]).length';
    const bin = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const n=${count};
if(a.includes('--stdin')){fs.appendFileSync(path.join(__dirname,'stdin-calls'),'x');
  const f=a[a.indexOf('--stdin-filename')+1];
  console.log(JSON.stringify([{filePath:path.resolve(f),errorCount:0,warningCount:n(fs.readFileSync(0,'utf8'))}]));}
else console.log(JSON.stringify(a.filter(x=>!x.startsWith('-')&&x!=='json').map(f=>({filePath:path.resolve(f),errorCount:0,warningCount:n(fs.readFileSync(f,'utf8'))}))));`;
    const withApi = `const n=${count};class ESLint{async lintText(t,{filePath}){return[{filePath,errorCount:0,warningCount:n(t)}]}}module.exports={ESLint};`;
    const setup = api => {
      const cfg = { ...DEV_FLOW_JSON, areas: [{ name: 'web', paths: ['src/'], eslint: { cwd: '.', extensions: ['.js'] }, commands: [] }] };
      const repo = mkRepo({
        '.gitignore': 'node_modules/\n',
        '.devflow.json': JSON.stringify(cfg),
        'src/a.js': 'WARN WARN\n',
        'src/b.js': 'WARN\n',
        'node_modules/eslint/package.json': JSON.stringify({ name: 'eslint', main: 'lib/api.js' }),
        'node_modules/eslint/bin/eslint.js': bin,
        'node_modules/eslint/lib/api.js': api,
      });
      const wt = taskBranch(repo, 'feat/lint');
      return { repo, wt, calls: () => (existsSync(join(repo.root, 'node_modules/eslint/bin/stdin-calls'))
        ? readFileSync(join(repo.root, 'node_modules/eslint/bin/stdin-calls'), 'utf8').length : 0) };
    };

    let { repo, wt, calls } = setup(withApi);
    writeFileSync(join(wt, 'src/a.js'), 'WARN WARN\nmore\n');
    writeFileSync(join(wt, 'src/b.js'), 'WARN\nmore\n');
    let r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /src\/a\.js: 0 error\(s\), 2 warning\(s\) \(dev: 2\)/);
    assert.equal(calls(), 0, 'the API path must not spawn eslint per file');
    writeFileSync(join(wt, 'src/a.js'), 'WARN WARN WARN\n');
    r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /warnings increased in src\/a\.js/);

    ({ repo, wt, calls } = setup('module.exports={};'));
    writeFileSync(join(wt, 'src/a.js'), 'WARN WARN\nmore\n');
    writeFileSync(join(wt, 'src/b.js'), 'WARN\nmore\n');
    r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /src\/b\.js: 0 error\(s\), 1 warning\(s\) \(dev: 1\)/);
    assert.equal(calls(), 2, 'no API: one CLI run per file read from dev');
  });

  it('doctor rejects a bad gate.maxParallel', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, gate: { maxParallel: -1 } }), 'a.txt': 'a\n' });
    const r = repo.run(FLOW, ['doctor']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /gate\.maxParallel must be an integer/);
  });

  it('a failing area command stops the gate and prints its output', () => {
    const cfg = { ...DEV_FLOW_JSON, areas: [
      { name: 'ok', paths: ['a/'], commands: [{ label: 'ok', run: 'node -e "process.exit(0)"' }] },
      { name: 'bad', paths: ['b/'], commands: [{ label: 'bad', run: 'node -e "console.log(\'boom-output\');process.exit(1)"' }] },
    ] };
    const repo = mkRepo({ '.devflow.json': JSON.stringify(cfg), 'a/x.txt': 'x\n', 'b/y.txt': 'y\n' });
    const wt = taskBranch(repo, 'feat/areas');
    writeFileSync(join(wt, 'a/x.txt'), 'x2\n');
    writeFileSync(join(wt, 'b/y.txt'), 'y2\n');
    assert.equal(repo.run(FLOW, ['ship', '-m', 'feat(t): areas', 'a/x.txt', 'b/y.txt'], { cwd: wt }).status, 0);
    const r = repo.run(FLOW, ['check'], { cwd: wt });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /boom-output/);
    assert.match(r.stderr, /verify failed/);
  });

  it('ship on dev with other uncommitted files lands only the listed ones, via a temp worktree', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON), 'a.txt': 'a\n', 'other.txt': 'o\n' });
    repo.git(['switch', 'dev']);
    writeFileSync(join(repo.root, 'a.txt'), 'a\nfixed\n');
    writeFileSync(join(repo.root, 'other.txt'), 'o\nsomeone else\n');
    const r = repo.run(FLOW, ['ship', '-m', 'fix(t): isolated', '--land', 'a.txt']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(repo.git(['log', 'dev', '--format=%s', '-1']), 'fix(t): isolated');
    assert.equal(repo.git(['branch', '--show-current']), 'dev');
    assert.equal(readFileSync(join(repo.root, 'a.txt'), 'utf8').replace(/\r/g, ''), 'a\nfixed\n');
    assert.equal(readFileSync(join(repo.root, 'other.txt'), 'utf8').replace(/\r/g, ''), 'o\nsomeone else\n');
    assert.match(repo.git(['status', '--porcelain']), /^ ?M other\.txt$/);
    assert.doesNotMatch(repo.git(['worktree', 'list']), /fix-t-isolated/);
  });

  it('ship on another branch with other uncommitted files is still refused', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON), 'a.txt': 'a\n', 'other.txt': 'o\n' });
    repo.git(['switch', '-c', 'feat/x', 'dev']);
    writeFileSync(join(repo.root, 'a.txt'), 'a2\n');
    writeFileSync(join(repo.root, 'other.txt'), 'o2\n');
    const r = repo.run(FLOW, ['ship', '-m', 'fix(t): nope', 'a.txt']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /other uncommitted changes/);
  });

  it('cloud-push pushes a ccr-* branch to the remote and refuses any other branch', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, remote: 'origin' }), 'a.txt': 'a\n' });
    const bare = mkdtempSync(join(tmpdir(), 'devflow-bare-'));
    roots.push(bare);
    spawnSync('git', ['init', '-q', '--bare', bare]);
    repo.git(['remote', 'add', 'origin', bare]);
    let r = repo.run(FLOW, ['cloud-push']); // on main
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ccr-\*/);
    repo.git(['switch', '-c', 'ccr-abc123', 'dev']);
    writeFileSync(join(repo.root, 'a.txt'), 'a\ncloud\n');
    repo.git(['commit', '-qam', 'fix(t): from cloud']);
    r = repo.run(FLOW, ['cloud-push']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(spawnSync('git', ['rev-parse', 'ccr-abc123'], { cwd: bare, encoding: 'utf8' }).stdout.trim(), repo.git(['rev-parse', 'HEAD']));
  });
});

describe('hard-rules', () => {
  it('ERROR on disabled tests, --strict exits 1', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, commitlint: false }) });
    repo.git(['checkout', '-qb', 'feat/x']);
    writeFileSync(join(repo.root, 'a.test.js'), 'it.skip("s", () => {});\n');
    const r = repo.run(HARD_RULES, ['--strict']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ERROR/);
    assert.match(r.stdout, /never disable/);
  });

  it('WARN on removed assertion lines without --strict exits 0', () => {
    const repo = mkRepo({
      '.devflow.json': JSON.stringify(DEV_FLOW_JSON),
      // one assertion per line: the heuristic counts lines, not calls
      't.test.js': 'test("a", () => {\n  assert(x);\n  assert(y);\n});\n',
    });
    repo.git(['checkout', '-qb', 'feat/y']);
    writeFileSync(join(repo.root, 't.test.js'), 'test("a", () => {\n  assert(x);\n});\n');
    const r = repo.run(HARD_RULES, []);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /WARN/);
    assert.match(r.stdout, /assertion/);
  });

  it('ERROR on hand-edited version in package.json', () => {
    const repo = mkRepo({
      '.devflow.json': JSON.stringify(DEV_FLOW_JSON),
      'package.json': '{"name":"x","version":"1.0.0"}\n',
    });
    repo.git(['checkout', '-qb', 'feat/z']);
    writeFileSync(join(repo.root, 'package.json'), '{"name":"x","version":"1.0.1"}\n');
    const r = repo.run(HARD_RULES, ['--strict']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /edited by hand/);
  });
});

describe('doctor', () => {
  it('fails when the integration branch is missing', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    repo.git(['branch', '-D', 'dev']);
    const r = repo.run(FLOW, ['doctor']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not exist/);
  });

  it('warns on a non-executable husky hook', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    mkdirSync(join(repo.root, '.husky'));
    writeFileSync(join(repo.root, '.husky', 'commit-msg'), '#!/bin/sh\n');
    const r = repo.run(FLOW, ['doctor']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not executable/);
  });
});

describe('queue', () => {
  const q = (repo, args) => repo.run(QUEUE, args);
  const queueFile = repo => readFileSync(join(repo.root, '.claude', 'task-queue.md'), 'utf8');

  it('add hands out sequential IDs and appends to Ready', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    let r = q(repo, ['add', '--title', 'fix login-timeout', '--size', 'small']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T-001 → Ready/);
    r = q(repo, ['add', '--title', 'feat export', '--size', 'large']);
    assert.match(r.stdout, /T-002 → Ready/);
    assert.match(queueFile(repo), /- \[ \] T-001: fix login-timeout \(size: small\)/);
  });

  it('add --wait goes to Waiting, --blocked-by annotates the dependency', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'base']);
    let r = q(repo, ['add', '--title', 'waiting on user', '--wait', 'chờ user chốt']);
    assert.match(r.stdout, /T-002 → Waiting/);
    r = q(repo, ['add', '--title', 'needs base', '--blocked-by', 'T-001']);
    assert.match(queueFile(repo), /T-003: needs base \(blocked by: T-001\)/);
  });

  it('ready hides blocked tasks until their blockers are done', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'base']);
    q(repo, ['add', '--title', 'needs base', '--blocked-by', 'T-001']);
    let r = q(repo, ['ready']);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /T-002/);
    q(repo, ['done', 'T-001']);
    r = q(repo, ['ready']);
    assert.match(r.stdout, /T-002: needs base/);
  });

  it('next returns the top ready task; unknown blocker IDs stay blocked', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'first']);
    q(repo, ['add', '--title', 'orphan dep', '--blocked-by', 'T-999']);
    const r = q(repo, ['next']);
    assert.match(r.stdout, /T-001: first/);
  });

  it('start claims, block parks with a reason, done dates, prune drops old items', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'work']);
    q(repo, ['add', '--title', 'other']);
    let r = q(repo, ['start', 'T-001', '--branch', 'feat/work']);
    assert.match(r.stdout, /claimed → In progress/);
    assert.match(queueFile(repo), /## In progress\n\n- \[ \] T-001: work \(branch: feat\/work\)/);
    r = q(repo, ['block', 'T-001', '--reason', 'đợi API']);
    assert.match(r.stdout, /→ Waiting/);
    r = q(repo, ['done', 'T-001']);
    assert.match(r.stdout, /done \(20\d\d-\d\d-\d\d\)/);
    // backdate the done item, then prune
    const f = join(repo.root, '.claude', 'task-queue.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/done: 20\d\d-\d\d-\d\d/, 'done: 2020-01-01'));
    r = q(repo, ['prune', '--days', '7']);
    assert.match(r.stdout, /pruned 1/);
    assert.doesNotMatch(queueFile(repo), /T-001/);
  });

  it('status prints a compact overview', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'a']);
    const r = q(repo, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 ready/);
  });

  it('is one shared file in the main checkout, also when run from a task worktree', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'first']);
    let r = q(repo, ['start', 'T-001', '--branch', 'feat/first']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const wt = join(repo.root, '.claude', 'worktrees', 'feat-first');
    r = repo.run(QUEUE, ['add', '--title', 'from worktree'], { cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(queueFile(repo), /T-002: from worktree/);
    assert.ok(!existsSync(join(wt, '.claude', 'task-queue.md')), 'worktree must not get its own queue copy');
    assert.ok(!existsSync(join(repo.root, '.claude', 'task-queue.md.lock')), 'lock released');
  });

  it('start --branch claims with a worktree; a second claim or a blocked task is refused', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'base']);
    q(repo, ['add', '--title', 'needs base', '--blocked-by', 'T-001']);
    let r = q(repo, ['start', 'T-002', '--branch', 'feat/needs-base']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not ready: waits on T-001/);
    r = q(repo, ['start', 'T-001', '--branch', 'feat/base']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(repo.root, '.claude', 'worktrees', 'feat-base')), 'worktree created');
    assert.match(repo.git(['branch', '--list', 'feat/base']), /feat\/base/);
    r = q(repo, ['start', 'T-001', '--branch', 'feat/base-again']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already claimed \(branch feat\/base\)/);
    assert.ok(!existsSync(join(repo.root, '.claude', 'task-queue.md.lock')), 'lock released after a refused claim');
  });

  it('a failed worktree creation undoes the claim', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'x']);
    mkdirSync(join(repo.root, '.claude', 'worktrees', 'feat-x'), { recursive: true }); // flow task refuses an existing path
    const r = q(repo, ['start', 'T-001', '--branch', 'feat/x']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claim of T-001 undone/);
    assert.match(queueFile(repo), /## Ready\n\n- \[ \] T-001: x\n/);
  });

  it('unblock returns a Waiting task to the end of Ready; unknown --blocked-by is rejected', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    q(repo, ['add', '--title', 'waits', '--wait', 'chờ user']);
    q(repo, ['add', '--title', 'other']);
    let r = q(repo, ['unblock', 'T-001']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(queueFile(repo), /## Ready\n\n- \[ \] T-002: other\n- \[ \] T-001: waits\n/);
    r = q(repo, ['unblock', 'T-001']);
    assert.notEqual(r.status, 0);
    r = q(repo, ['add', '--title', 'typo dep', '--blocked-by', 'T-099']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no such task/);
    assert.doesNotMatch(queueFile(repo), /typo dep/);
  });
});

describe('status', () => {
  it('shows task worktrees vs dev, their queue task, and the next ready tasks', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    repo.run(QUEUE, ['add', '--title', 'claimed']);
    repo.run(QUEUE, ['add', '--title', 'still ready']);
    let r = repo.run(QUEUE, ['start', 'T-001', '--branch', 'feat/claimed']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const wt = join(repo.root, '.claude', 'worktrees', 'feat-claimed');
    writeFileSync(join(wt, 'n.txt'), 'n\n');
    repo.git(['add', 'n.txt'], { cwd: wt });
    repo.git(['commit', '-qm', 'feat: n'], { cwd: wt });
    writeFileSync(join(wt, 'dirty.txt'), 'd\n');
    r = repo.run(FLOW, ['status']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /feat\/claimed\s+\+1\/-0 · 1 uncommitted\s+\[T-001 claimed\]/);
    assert.match(r.stdout, /queue: 1 ready/);
    assert.match(r.stdout, /T-002: still ready/);
  });
});

describe('worktrees:clean', () => {
  /** repo with .claude/worktrees; wt(name, branch) creates a worktree on a branch from dev. */
  function mkWtRepo() {
    const repo = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON) });
    const wt = (name, branch) => {
      const p = join(repo.root, '.claude', 'worktrees', name);
      repo.git(['worktree', 'add', '-b', branch, p, 'dev']);
      return p;
    };
    return { repo, wt };
  }
  function commitWt(repo, p, msg) {
    repo.git(['add', '-A'], { cwd: p });
    repo.git(['commit', '-qm', msg], { cwd: p });
  }

  it('dry run lists safe/risky and changes nothing', () => {
    const { repo, wt } = mkWtRepo();
    const done = wt('feat-done', 'feat/done');
    writeFileSync(join(done, 'b.txt'), 'b\n');
    commitWt(repo, done, 'feat: done');
    repo.git(['checkout', '-q', 'dev']);
    repo.git(['merge', '-q', '--ff-only', 'feat/done']);
    const wip = wt('feat-wip', 'feat/wip');
    writeFileSync(join(wip, 'dirty.txt'), 'dirty\n');
    mkdirSync(join(repo.root, '.claude', 'worktrees', 'orphan'));
    const r = repo.run(WCLEAN, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /✔ safe.*feat\/done/);
    assert.match(r.stdout, /! risky.*feat\/wip/);
    assert.match(r.stdout, /orphan folder/);
    assert.match(r.stdout, /Dry run/);
    assert.ok(existsSync(done) && existsSync(wip), 'dry run must not delete anything');
  });

  it('--yes removes safe worktrees + orphans, keeps risky ones', () => {
    const { repo, wt } = mkWtRepo();
    const done = wt('feat-done', 'feat/done');
    writeFileSync(join(done, 'b.txt'), 'b\n');
    commitWt(repo, done, 'feat: done');
    repo.git(['checkout', '-q', 'dev']);
    repo.git(['merge', '-q', '--ff-only', 'feat/done']);
    const wip = wt('feat-wip', 'feat/wip');
    writeFileSync(join(wip, 'dirty.txt'), 'dirty\n');
    const orphan = join(repo.root, '.claude', 'worktrees', 'orphan');
    mkdirSync(orphan);
    const r = repo.run(WCLEAN, ['--', '--yes']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deleted branch feat\/done/);
    assert.ok(!existsSync(done) && !existsSync(orphan), 'safe worktree and orphan removed');
    assert.ok(existsSync(wip), 'risky worktree kept without --force');
    assert.equal(repo.git(['branch', '--list', 'feat/done']).trim(), '', 'merged branch really deleted');
    assert.ok(repo.git(['branch', '--list', 'feat/wip']).includes('feat/wip'), 'risky branch kept');
  });

  it('--force also removes risky worktrees and their branches', () => {
    const { repo, wt } = mkWtRepo();
    const wip = wt('feat-wip', 'feat/wip');
    writeFileSync(join(wip, 'dirty.txt'), 'dirty\n');
    const r = repo.run(WCLEAN, ['--', '--yes', '--force']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /deleted branch feat\/wip/);
    assert.ok(!existsSync(wip), 'risky worktree removed with --force');
    assert.equal(repo.git(['branch', '--list', 'feat/wip']).trim(), '', 'risky branch deleted with --force');
  });
});

describe('flow: archive', () => {
  // A stand-in OpenSpec CLI (tracked in the throwaway repo): `archive <name> -y` moves the change under archive/.
  const FAKE_CLI = `const { renameSync, mkdirSync } = require('node:fs');
mkdirSync('openspec/changes/archive', { recursive: true });
renameSync('openspec/changes/' + process.argv[3], 'openspec/changes/archive/' + process.argv[3]);
`;
  const repoWith = tasks => mkRepo({
    // a developer's global excludesFile may ignore these; re-include so the fixture is committed
    '.gitignore': '!openspec/\n!node_modules/\n',
    '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, linkDirs: [] }),
    'openspec/changes/foo/tasks.md': tasks,
    'node_modules/@fission-ai/openspec/bin/openspec.js': FAKE_CLI,
  });

  it('refuses when a task is not ticked, changing nothing', () => {
    const repo = repoWith('- [x] one\n- [ ] two\n');
    const r = repo.run(FLOW, ['archive', '--', 'foo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /1 of 2 task\(s\) not done/);
    assert.doesNotMatch(repo.git(['worktree', 'list']), /archive-foo/);
  });

  it('refuses a change that is not in dev', () => {
    const repo = repoWith('- [x] one\n');
    const r = repo.run(FLOW, ['archive', '--', 'nope']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not in dev/);
  });

  it('archives a fully ticked change, lands it in dev and removes the worktree', () => {
    const repo = repoWith('- [x] one\n- [x] two\n');
    const r = repo.run(FLOW, ['archive', '--', 'foo']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(repo.git(['log', 'dev', '--format=%s', '-1']), 'chore(openspec): archive foo');
    assert.equal(repo.git(['ls-tree', '--name-only', 'dev', 'openspec/changes/foo/tasks.md']), '');
    assert.doesNotMatch(repo.git(['worktree', 'list']), /archive-foo/);
  });
});

describe('hooks: stop gate, format on edit', () => {
  const hook = (repo, name, payload) => repo.run(join(HOOKS, name), [], { input: JSON.stringify(payload) });
  const blocks = r => (assert.equal(r.status, 0, r.stderr), /"decision":"block"/.test(r.stdout));

  it('stop gate blocks a task branch whose content has not passed check, once per stop', () => {
    const repo = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, stopGate: true }), 'a.txt': 'a\n' });
    assert.equal(repo.run(FLOW, ['task', '--', 'feat/stop']).status, 0);
    const wt = join(repo.root, '.claude', 'worktrees', 'feat-stop');
    assert.equal(blocks(hook(repo, 'stop-gate.mjs', { cwd: wt })), false); // nothing changed yet
    writeFileSync(join(wt, 'a.txt'), 'a\nb\n');
    assert.equal(blocks(hook(repo, 'stop-gate.mjs', { cwd: wt })), true);
    assert.equal(blocks(hook(repo, 'stop-gate.mjs', { cwd: wt, stop_hook_active: true })), false);
    assert.equal(repo.run(FLOW, ['check'], { cwd: wt }).status, 0);
    assert.equal(blocks(hook(repo, 'stop-gate.mjs', { cwd: wt })), false); // same content passed
    writeFileSync(join(wt, 'a.txt'), 'a\nc\n');
    assert.equal(blocks(hook(repo, 'stop-gate.mjs', { cwd: wt })), true); // content moved on
  });

  it('stop gate leaves dev / main and repos without stopGate alone', () => {
    const on = mkRepo({ '.devflow.json': JSON.stringify({ ...DEV_FLOW_JSON, stopGate: true }), 'a.txt': 'a\n' });
    on.git(['checkout', '-q', 'dev']);
    writeFileSync(join(on.root, 'a.txt'), 'dirty\n');
    assert.equal(blocks(hook(on, 'stop-gate.mjs', { cwd: on.root })), false);
    const off = mkRepo({ '.devflow.json': JSON.stringify(DEV_FLOW_JSON), 'a.txt': 'a\n' });
    off.git(['checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(off.root, 'a.txt'), 'dirty\n');
    assert.equal(blocks(hook(off, 'stop-gate.mjs', { cwd: off.root })), false);
  });

  it('format hook runs the owning area formatter on the edited file only', () => {
    const fmt = { cwd: 'web', run: `node -e "require('fs').appendFileSync(process.argv[1], 'fmt\\n')"`, extensions: ['.js'] };
    const cfg = { ...DEV_FLOW_JSON, areas: [{ name: 'web', paths: ['web/'], commands: [], format: fmt }] };
    const repo = mkRepo({ '.devflow.json': JSON.stringify(cfg), 'web/src/a.js': 'a\n', 'web/b.txt': 'b\n', 'c.js': 'c\n' });
    for (const f of ['web/src/a.js', 'web/b.txt', 'c.js']) {
      assert.equal(hook(repo, 'format-on-edit.mjs', { tool_name: 'Edit', tool_input: { file_path: join(repo.root, f) } }).status, 0);
    }
    assert.equal(readFileSync(join(repo.root, 'web/src/a.js'), 'utf8'), 'a\nfmt\n');
    assert.equal(readFileSync(join(repo.root, 'web/b.txt'), 'utf8'), 'b\n'); // extension not listed
    assert.equal(readFileSync(join(repo.root, 'c.js'), 'utf8'), 'c\n'); // no area owns it
  });
});
