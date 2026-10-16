#!/usr/bin/env node
// devflow — local-only git flow (vendored from the devflow plugin; config in .devflow.json):
//   task     worktree for one task, on a new branch from the integration branch (default dev)
//   ship     commit only the listed files
//   check    run the land gate (commitlint, hard rules, per-area lint/build/test), merge nothing
//   land     gate + fast-forward the integration branch to the task branch (rebasing first if it moved)
//   promote  fast-forward the release branch (default main) to the integration branch + version tag
//   sync     delete local branches already contained in the integration branch
//   backup   push integration/release branches + tags to the backup remote
//   untask   remove a task worktree safely
//   status   who works on what: task worktrees (ahead/behind, dirty, handoff) + queue, read-only
// The local clone is the source of truth: no PR, no CI. Integration/release branches only move by
// fast-forward and are pushed to the remote as a backup; task branches are never pushed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, lstatSync, unlinkSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, mainCheckout, loadConfig, commandHint } from './config.mjs';
import { queueFile, load as loadQueue, itemsOf, readyItems, describe as describeTask } from './queue-lib.mjs';

const REPO_ROOT = repoRoot();
const cfg = loadConfig(REPO_ROOT);
const DEV = cfg.integrationBranch;
const MAIN = cfg.releaseBranch;
const HERE = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const hint = name => commandHint(REPO_ROOT, name);

let dryRun = false;

// ---------- process helpers ----------

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function step(msg) {
  console.log(`\n▶ ${msg}`);
}

/** Read-only command: always runs, returns trimmed stdout (null on failure when allowFail). */
function capture(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT ?? process.cwd(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) die(`${cmd} not runnable: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) die(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Mutating command: printed and skipped under --dry-run. Returns true on success. */
function exec(cmd, args, { allowFail = false } = {}) {
  const shown = `${cmd} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`  [dry-run] ${shown}`);
    return true;
  }
  console.log(`  $ ${shown}`);
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.error) die(`${cmd} not runnable: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) die(`failed: ${shown}`);
  return r.status === 0;
}

function git(args, opts) {
  return capture('git', args, opts);
}

function currentBranch() {
  return git(['branch', '--show-current']);
}

function branchExists(b) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true }) !== null;
}

function requireBranch(b) {
  if (!branchExists(b)) die(`no local ${b} branch (create it once: git branch ${b} ${b === DEV ? MAIN : 'HEAD'}).`);
}

/** true when commit `a` is contained in `b` (b can fast-forward over a). */
function isAncestor(a, b) {
  return git(['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null;
}

// ---------- args ----------

function parseArgs(argv) {
  const opts = { messages: [], messageFile: null, paths: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m') opts.messages.push(argv[++i]);
    else if (a === '-F') opts.messageFile = argv[++i]; // multi-line message (npm on Windows cuts newlines in args)
    else if (a === '--') opts.paths.push(...argv.slice(i + 1)), (i = argv.length);
    else if (a.startsWith('--')) opts.flags.add(a.slice(2));
    else opts.paths.push(a);
  }
  dryRun = opts.flags.has('dry-run');
  return opts;
}

/** Changed (vs HEAD) and untracked files under a pathspec, repo-relative with '/'. */
function changedFiles(pathspec = '.') {
  const q = ['-c', 'core.quotepath=off'];
  return [
    git([...q, 'diff', '--name-only', 'HEAD', '--', pathspec]),
    git([...q, 'ls-files', '--others', '--exclude-standard', '--', pathspec]),
  ].join('\n').split('\n').filter(Boolean);
}

const toRepoPath = p => relative(REPO_ROOT, resolve(p)).replace(/\\/g, '/');

// ---------- worktrees: one per task/session ----------

/** Main checkout (shared by everyone) vs a linked worktree (private to one task/session). */
function isMainWorktree() {
  return resolve(REPO_ROOT, git(['rev-parse', '--git-dir'])) === resolve(REPO_ROOT, git(['rev-parse', '--git-common-dir']));
}

/** branch → worktree path, for every branch checked out somewhere. */
function worktreeBranches() {
  const map = new Map();
  let path = null;
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) map.set(line.slice(18), path);
  }
  return map;
}

/** Move local branch `target` forward to `source`. Refuses anything that is not a fast-forward.
 * A branch checked out in some worktree is moved inside that worktree (its files follow). */
function fastForward(target, source) {
  if (!dryRun && !isAncestor(target, source)) die(`${target} is not an ancestor of ${source}: not a fast-forward.`);
  const where = worktreeBranches().get(target);
  if (where) {
    if (!exec('git', ['-C', where, 'merge', '--ff-only', source], { allowFail: true })) {
      die(`could not fast-forward ${target} in ${where} (uncommitted changes there would be overwritten?).`);
    }
  } else {
    exec('git', ['update-ref', `refs/heads/${target}`, git(['rev-parse', source]), git(['rev-parse', target])]);
  }
}

/** Create <worktreeDir>/<branch> on a new branch from the integration branch. Gitignored tooling dirs
 * (linkDirs: node_modules, husky hooks, ...) are linked from the main checkout so hooks and the gate work. */
function task(opts) {
  const branch = opts.paths[0];
  if (!branch || !/^[a-z]+\/[a-z0-9][a-z0-9._-]*$/.test(branch)) {
    die(`usage: ${hint('task')} -- <type>/<scope>-<desc>   e.g. feat/billing-export-csv`);
  }
  requireBranch(DEV);
  const mainRoot = mainCheckout(REPO_ROOT);
  const path = join(mainRoot, ...cfg.worktreeDir.split('/'), branch.replace(/\//g, '-'));
  if (existsSync(path)) die(`${path} already exists — enter it instead.`);
  if (branchExists(branch)) die(`branch ${branch} already exists — use: git worktree add "${path}" ${branch}`);
  step(`worktree ${path} on new branch ${branch} from ${DEV}`);
  exec('git', ['worktree', 'add', '-b', branch, path, DEV]);
  for (const dir of cfg.linkDirs) {
    const target = join(mainRoot, dir);
    if (!existsSync(target)) continue;
    if (dryRun) console.log(`  [dry-run] link ${dir} → ${target}`);
    else symlinkSync(target, join(path, dir), isWin ? 'junction' : 'dir');
  }
  console.log(`\n  ✔ ready. Agent: EnterWorktree(path="${path}"). Human: cd "${path}"`);
}

/** Delete a local branch only when the integration branch already contains it. */
function deleteIfMerged(branch) {
  if (!isAncestor(branch, DEV)) return console.log(`  ! kept branch ${branch} (not in ${DEV} yet)`);
  exec('git', ['branch', '-D', branch]); // safe: checked above that DEV contains every commit of it
}

/** Remove a task worktree: links first (so nothing follows them into the main checkout's deps),
 * then `git worktree remove` without --force, then delete the branch if the integration branch has it. */
function untask(opts) {
  const branch = opts.paths[0];
  const path = branch && worktreeBranches().get(branch);
  if (!path) die(`usage: ${hint('untask')} -- <branch>   (a branch checked out in a ${cfg.worktreeDir}/ worktree)`);
  const marker = cfg.worktreeDir.split('/').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  if (!new RegExp(`[\\\\/]${marker}[\\\\/]`).test(path)) die(`${path} is not a task worktree; not touching it.`);
  if (resolve(REPO_ROOT) === resolve(path)) die('run untask from the main checkout, not from inside the worktree.');
  const dirty = git(['-C', path, 'status', '--porcelain']);
  if (dirty) die(`worktree has uncommitted changes — commit (ship) or discard them first:\n${dirty}`);

  step(`remove worktree ${path}`);
  for (const dir of cfg.linkDirs) {
    const link = join(path, dir);
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink()) continue;
    if (dryRun) console.log(`  [dry-run] unlink ${dir}`);
    else unlinkSync(link); // removes the junction/symlink itself, never its target
  }
  exec('git', ['worktree', 'remove', path]);
  deleteIfMerged(branch);
}

// ---------- verify (local gate, replaces CI) ----------

function runLocal(label, cmd, args, cwd, opts = {}) {
  console.log(`  $ ${label}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) die(`gate failed at: ${label}. Nothing was committed/merged.`);
}

/** Async run with output collected (not inherited), so gate areas can run side by side. */
function runCapture(cmd, args, { cwd, input, ...opts } = {}) {
  return new Promise(done => {
    const p = spawn(cmd, args, { cwd, ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.on('error', e => done({ status: -1, stdout, stderr: stderr + e.message }));
    p.on('close', status => done({ status, stdout, stderr }));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

const sumCounts = results => results.reduce(
  (t, f) => ({ errors: t.errors + f.errorCount, warnings: t.warnings + f.warningCount }), { errors: 0, warnings: 0 });

function eslintBin(eslintCwd) {
  const bin = [join(REPO_ROOT, eslintCwd, 'node_modules', 'eslint', 'bin', 'eslint.js'), join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')]
    .find(existsSync);
  if (!bin) die(`eslint not installed in ${eslintCwd}/node_modules (needed by the gate's eslint check).`);
  return bin;
}

/** ESLint errors+warnings of the current content of every given file, in ONE eslint run. */
async function eslintCurrent(eslintCwd, files) {
  const cwd = join(REPO_ROOT, eslintCwd);
  const rels = files.map(f => relative(cwd, join(REPO_ROOT, f)).replace(/\\/g, '/'));
  const r = await runCapture(process.execPath, [eslintBin(eslintCwd), '-f', 'json', ...rels], { cwd });
  if (!r.stdout?.trim().startsWith('[')) die(`eslint could not run:\n${r.stderr}`);
  const byFile = new Map(JSON.parse(r.stdout).map(res => [relative(cwd, res.filePath).replace(/\\/g, '/'), res]));
  return new Map(files.map((f, i) => [f, sumCounts(byFile.has(rels[i]) ? [byFile.get(rels[i])] : [])]));
}

/** ESLint errors+warnings of one file as it is at `baseRef` (read from `baseFile` when the file was moved). */
async function eslintBase(eslintCwd, file, baseRef, baseFile = file) {
  const cwd = join(REPO_ROOT, eslintCwd);
  const rel = relative(cwd, join(REPO_ROOT, file)).replace(/\\/g, '/');
  const base = git(['show', `${baseRef}:${baseFile}`], { allowFail: true });
  if (base === null) return { errors: 0, warnings: 0 }; // new file
  const r = await runCapture(process.execPath, [eslintBin(eslintCwd), '-f', 'json', '--stdin', '--stdin-filename', rel], { cwd, input: base });
  if (!r.stdout?.trim().startsWith('[')) die(`eslint could not run on ${file}:\n${r.stderr}`);
  return sumCounts(JSON.parse(r.stdout));
}

/** Files renamed vs the integration branch (committed or not): new path → old path. */
function renamedFromDev() {
  const renamed = new Map();
  for (const line of git(['-c', 'core.quotepath=off', 'diff', '-M', '--name-status', DEV]).split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R')) renamed.set(to, from);
  }
  return renamed;
}

/** One gate area: ESLint delta check (no errors, no new warnings vs the integration branch; the base
 * version is read only for files that have warnings), then the area's commands. Output is returned,
 * not printed, so areas can run in parallel. */
async function verifyArea(area, areaFiles) {
  let out = `\n▶ verify ${area.name}\n`;
  const fail = msg => ({ ok: false, out: out + msg });
  if (area.eslint) {
    const { cwd = '.', extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.html'] } = area.eslint;
    const prefix = cwd === '.' ? '' : `${cwd.replace(/\/$/, '')}/`;
    const renamed = renamedFromDev();
    const lintable = areaFiles.filter(f => f.startsWith(prefix) && extensions.some(e => f.endsWith(e)) && existsSync(join(REPO_ROOT, f)));
    const counts = lintable.length ? await eslintCurrent(cwd, lintable) : new Map();
    const befores = new Map(await Promise.all(lintable.filter(f => counts.get(f).warnings > 0)
      .map(async f => [f, await eslintBase(cwd, f, DEV, renamed.get(f))])));
    for (const f of lintable) {
      const now = counts.get(f);
      const from = renamed.has(f) ? ` at ${renamed.get(f)}` : '';
      const base = befores.has(f) ? befores.get(f).warnings : 0; // no warnings now → cannot have increased
      out += `  ${f}: ${now.errors} error(s), ${now.warnings} warning(s) (${DEV}${from}: ${befores.has(f) ? base : 'not read'})\n`;
      if (now.errors > 0) return fail(`verify: ESLint errors in ${f}. Nothing was committed/merged.`);
      if (now.warnings > base) return fail(`verify: ESLint warnings increased in ${f}. Nothing was committed/merged.`);
    }
  }
  for (const c of area.commands ?? []) {
    const run = (isWin && c.runWin) || c.run;
    out += `  $ ${c.label ?? run}\n`;
    const r = await runCapture(run, [], { cwd: join(REPO_ROOT, c.cwd ?? '.'), shell: true });
    out += r.stdout + r.stderr;
    if (r.status !== 0) return fail(`gate failed at: ${c.label ?? run}. Nothing was committed/merged.`);
  }
  return { ok: true, out };
}

/** Every area of .devflow.json touched by `files`, in parallel (areas are independent). */
async function verify(files) {
  const touched = cfg.areas.map(a => ({ area: a, files: files.filter(f => a.paths.some(p => f.startsWith(p))) }))
    .filter(t => t.files.length);
  if (!cfg.areas.length) return console.log('\n▶ verify: no areas in .devflow.json — nothing to run');
  if (!touched.length) return console.log('\n▶ verify: no changed file belongs to a gate area — nothing to run');

  const show = r => (process.stdout.write(`${r.out}\n`), r);
  const results = await Promise.all(touched.map(t => verifyArea(t.area, t.files).then(show)));
  if (results.some(r => !r.ok)) die('verify failed (see the output above). Nothing was committed/merged.');
  console.log('  ✔ verify passed');
}

// ---------- ship (commit only) ----------

const HEADER_RE = /^([a-z]+)(?:\(([\w.-]+)\))?!?: (.+)$/;

function slugify(text, maxLen = 50) {
  const s = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).replace(/-[^-]*$/, '');
}

function branchNameFor(header) {
  const [, type, scope, subject] = header.match(HEADER_RE);
  return `${type}/${scope ? `${scope}-` : ''}${slugify(subject)}`;
}

async function ship(opts) {
  if (opts.messageFile && opts.messages.length) die('use either -m or -F, not both');
  const header = opts.messageFile
    ? readFileSync(opts.messageFile, 'utf8').split(/\r?\n/)[0]
    : opts.messages[0];
  if (!header) die('commit message required: -m "feat(scope): ..." (repeat -m for body/footer paragraphs)');
  if (!HEADER_RE.test(header)) die(`not a Conventional Commit header: "${header}"`);
  if (opts.paths.length === 0) {
    die(`list the files of THIS task: ${hint('ship')} -- -m "..." <file> [file...]\n` +
        '  Other changes in the working tree (other tasks/sessions) are never staged.');
  }
  for (const p of opts.paths) {
    if (!git(['status', '--porcelain', '--', p])) die(`no changes in ${p} (typo, or already committed?)`);
  }

  // The main checkout is shared: a file may hold edits of several sessions, and git cannot tell
  // whose lines are whose. Only commit there when nothing else is dirty (or a human says so).
  if (isMainWorktree() && !opts.flags.has('shared-ok')) {
    const listed = new Set(opts.paths.flatMap(p => changedFiles(toRepoPath(p))));
    const others = changedFiles().filter(f => !listed.has(f));
    if (others.length && currentBranch() === DEV) return shipIsolated(opts, header);
    if (others.length) {
      die('main checkout has other uncommitted changes (maybe another session):\n' +
          others.map(f => `    ${f}`).join('\n') +
          `\n  Work in your own worktree (${hint('task')} -- <branch>), or, if you are a human and these are\n` +
          '  all yours / unrelated, rerun with --shared-ok.');
    }
  }

  let branch = currentBranch();
  if (!branch) die('detached HEAD — checkout a branch first.');
  if (branch === MAIN) die(`on ${MAIN}: it only moves by \`${hint('promote')}\`. Work on a task branch.`);

  if (opts.flags.has('verify')) await verify(opts.paths.flatMap(p => changedFiles(toRepoPath(p))));

  if (branch === DEV) {
    const newBranch = branchNameFor(header);
    if (branchExists(newBranch)) die(`branch ${newBranch} already exists — checkout it and ship again.`);
    step(`create branch ${newBranch}`);
    exec('git', ['switch', '-c', newBranch]);
    branch = newBranch;
  }

  step(`commit on ${branch} only: ${opts.paths.join(', ')}`);
  exec('git', ['add', '--', ...opts.paths]);
  // `git commit -- <paths>` commits exactly these paths, even if another session staged other files.
  const msgArgs = opts.messageFile ? ['-F', opts.messageFile] : opts.messages.flatMap(m => ['-m', m]);
  exec('git', ['commit', ...msgArgs, '--', ...opts.paths]);

  if (opts.flags.has('land') || opts.flags.has('promote')) await land();
  if (opts.flags.has('promote')) promote();
}

/** `ship` on the integration branch while the shared checkout holds other people's uncommitted files:
 * commit and land the listed files from a private task worktree, so the other files are never touched.
 * Flow: copy the listed files into a new worktree → `ship` there → put the listed files back to HEAD in
 * the main checkout (so the fast-forward of DEV can overwrite them) → `land` there (with --land) →
 * untask. A red gate leaves the commit on the task branch/worktree; the main checkout no longer has
 * those edits. */
function shipIsolated(opts, header) {
  if (opts.flags.has('promote')) die('--promote is not supported while other files are uncommitted; land first, promote from a clean checkout.');
  const files = [...new Set(opts.paths.flatMap(p => changedFiles(toRepoPath(p))))];
  const branch = branchNameFor(header);
  const wt = join(REPO_ROOT, ...cfg.worktreeDir.split('/'), branch.replace(/\//g, '-'));
  const land = opts.flags.has('land');
  step(`other files are uncommitted in the shared checkout: isolate ${files.length} file(s) in ${branch}`);
  if (dryRun) {
    console.log(`  [dry-run] worktree ${wt}; copy ${files.join(', ')}; ship${land ? '; land; untask' : ''}`);
    return;
  }
  task({ paths: [branch] });
  for (const f of files) {
    const src = join(REPO_ROOT, f);
    const dst = join(wt, f);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    } else if (existsSync(dst)) unlinkSync(dst); // deleted in the main checkout
  }
  const self = fileURLToPath(import.meta.url);
  const node = args => spawnSync(process.execPath, [self, ...args], { cwd: wt, stdio: 'inherit' }).status === 0;
  const shipArgs = [...(opts.messageFile ? ['-F', resolve(opts.messageFile)] : opts.messages.flatMap(m => ['-m', m])),
    ...(opts.flags.has('verify') ? ['--verify'] : []), ...(opts.flags.has('no-cache') ? ['--no-cache'] : []), ...files];
  if (!node(['ship', ...shipArgs])) die(`ship failed in ${wt}; the main checkout is untouched. Fix there, or untask -- ${branch}.`);
  if (!land) return console.log(`\n  ✔ committed on ${branch} (worktree ${wt}); main checkout untouched. Next: land from that worktree.`);

  step('restore listed files in the main checkout (their edits now live in the task commit)');
  for (const f of files) {
    if (git(['ls-files', '--error-unmatch', '--', f], { allowFail: true }) !== null) exec('git', ['checkout', 'HEAD', '--', f]);
    else if (existsSync(join(REPO_ROOT, f))) unlinkSync(join(REPO_ROOT, f));
  }
  if (!node(['land'])) die(`land failed (gate red?): the work is committed on ${branch} in ${wt}. Fix and ship/land there (skill steward); main checkout no longer has these edits.`);
  untask({ paths: [branch] });
}

// ---------- gate: what land requires; `check` runs it alone ----------

/** commitlint on DEV..HEAD, hard rules (ERROR blocks), then per-area checks of every file changed vs
 * DEV — committed or not (land runs on a clean tree anyway). */
async function gate() {
  // A gate that passed for this exact HEAD on a clean tree, with DEV unchanged, would give the same result.
  const key = git(['status', '--porcelain']) ? null : `${git(['rev-parse', 'HEAD'])} ${git(['rev-parse', DEV])}`;
  const cacheFile = join(git(['rev-parse', '--absolute-git-dir']), 'gate-passed');
  if (key && !opts.flags.has('no-cache') && existsSync(cacheFile) && readFileSync(cacheFile, 'utf8') === key) {
    return console.log(`\n▶ gate: already passed for this HEAD on this ${DEV} (clean tree) — skipped. --no-cache to rerun.`);
  }
  if (git(['rev-list', '--count', `${DEV}..HEAD`]) !== '0' && cfg.commitlint !== false) {
    const cli = join(REPO_ROOT, 'node_modules', '@commitlint', 'cli', 'cli.js');
    if (existsSync(cli)) {
      step(`gate: commitlint on ${DEV}..HEAD`);
      runLocal(`commitlint --from ${DEV} --to HEAD`, process.execPath, [cli, '--from', DEV, '--to', 'HEAD'], REPO_ROOT);
    } else if (cfg.commitlint === true) {
      die('commitlint is required by .devflow.json but node_modules/@commitlint/cli is missing (npm install).');
    } else {
      console.log('\n▶ gate: commitlint not installed — skipped (set "commitlint": true to require it)');
    }
  }
  step('gate: hard rules (ERROR blocks, WARN is for the verifier)');
  runLocal(`hard-rules --base ${DEV} --strict`, process.execPath,
    [join(HERE, 'hard-rules.mjs'), '--base', DEV, '--strict'], REPO_ROOT);
  const committed = git(['-c', 'core.quotepath=off', 'diff', '--name-only', `${DEV}...HEAD`]).split('\n').filter(Boolean);
  await verify([...new Set([...committed, ...changedFiles()])]);
  if (key && !dryRun) writeFileSync(cacheFile, key);
}

async function check() {
  requireBranch(DEV);
  await gate();
  console.log(`\n  ✔ check passed (same gate as ${hint('land')}; nothing was committed or merged)`);
}

// ---------- land: task branch → DEV (fast-forward) ----------

async function land() {
  const branch = currentBranch();
  if (!branch) die('detached HEAD — checkout the task branch first.');
  if ([DEV, MAIN].includes(branch)) die(`on ${branch}: run land from the task branch (its worktree); use promote for ${MAIN}.`);
  requireBranch(DEV);
  const dirty = git(['status', '--porcelain']);
  if (dirty && !dryRun) die(`uncommitted changes — ship or discard them first:\n${dirty}`);
  if (git(['rev-list', '--count', `${DEV}..HEAD`]) === '0' && !dryRun) die(`nothing to land: ${branch} has no commits beyond ${DEV}.`);

  if (!isAncestor(DEV, 'HEAD')) {
    step(`${DEV} moved on: rebase ${branch} onto ${DEV}`);
    if (!exec('git', ['rebase', DEV], { allowFail: true })) {
      exec('git', ['rebase', '--abort'], { allowFail: true });
      die(`rebase of ${branch} onto ${DEV} conflicts — aborted, branch unchanged.\n` +
          `  Resolve by hand: git rebase ${DEV}, fix conflicts, git rebase --continue, then land again.`);
    }
  }

  await gate();

  step(`fast-forward ${DEV} → ${branch}`);
  fastForward(DEV, branch);
  console.log(`  ✔ ${DEV} is now at ${git(['rev-parse', '--short', 'HEAD'])} (${branch})`);
  backup([DEV]);

  if (isMainWorktree()) {
    exec('git', ['switch', DEV]);
    deleteIfMerged(branch);
  } else {
    console.log(`  Next: leave this worktree (ExitWorktree keep), then from the main checkout: ${hint('untask')} -- ${branch}`);
  }
}

// ---------- promote: DEV → MAIN (fast-forward) + version tag ----------

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEMVER_TAG = new RegExp(`^${esc(cfg.tagPrefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`);

/** Highest stable tag contained in `ref` (prerelease tags such as v1.0.0-dev.2 are ignored). */
function lastReleaseTag(ref) {
  const tags = (git(['tag', '--merged', ref, '--list', `${cfg.tagPrefix}*`]) || '').split('\n').filter(t => SEMVER_TAG.test(t));
  const num = t => t.match(SEMVER_TAG).slice(1).map(Number);
  tags.sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return tags[0] ?? null;
}

/** semantic-release's default rules: breaking → major, feat → minor, fix/perf/revert → patch,
 * anything else → no release. Returns { version, notes } or null. */
function nextRelease(ref) {
  const last = lastReleaseTag(ref);
  const log = git(['log', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', last ? `${last}..${ref}` : ref]) || '';
  const sections = { breaking: [], feat: [], fix: [] };
  let bump = 0;
  for (const entry of log.split('\x1e').map(s => s.trim()).filter(Boolean)) {
    const [sha, subject, body = ''] = entry.split('\x1f');
    const m = subject.match(/^([a-z]+)(?:\(([^)]*)\))?(!?): (.+)$/);
    if (!m) continue;
    const [, type, scope, bang, text] = m;
    const line = `- ${scope ? `**${scope}:** ` : ''}${text} (${sha})`;
    if (bang || /^BREAKING[ -]CHANGE:/m.test(body)) {
      sections.breaking.push(line);
      bump = 3;
    }
    if (type === 'feat') {
      sections.feat.push(line);
      bump = Math.max(bump, 2);
    } else if (['fix', 'perf', 'revert'].includes(type)) {
      sections.fix.push(line);
      bump = Math.max(bump, 1);
    }
  }
  if (!bump) return null;
  let [major, minor, patch] = last ? last.match(SEMVER_TAG).slice(1).map(Number) : [0, 0, 0];
  if (!last) [major, minor, patch] = [1, 0, 0];
  else if (bump === 3) [major, minor, patch] = [major + 1, 0, 0];
  else if (bump === 2) [minor, patch] = [minor + 1, 0];
  else patch += 1;
  const version = `${cfg.tagPrefix}${major}.${minor}.${patch}`;
  const notes = [`${version}`, '']
    .concat(sections.breaking.length ? ['BREAKING CHANGES', ...sections.breaking, ''] : [])
    .concat(sections.feat.length ? ['Features', ...sections.feat, ''] : [])
    .concat(sections.fix.length ? ['Bug Fixes', ...sections.fix, ''] : [])
    .join('\n');
  return { version, notes };
}

function promote() {
  step(`promote ${DEV} → ${MAIN}`);
  requireBranch(DEV);
  requireBranch(MAIN);
  if (git(['rev-list', '--count', `${MAIN}..${DEV}`]) === '0') return console.log(`  nothing to promote: ${MAIN} already has everything in ${DEV}.`);
  if (!isAncestor(MAIN, DEV)) {
    die(`${MAIN} has commits that ${DEV} does not — cannot fast-forward. Ask the user how to bring them into ${DEV}.`);
  }

  const sha = git(['rev-parse', DEV]);
  const release = nextRelease(sha);
  fastForward(MAIN, sha);
  console.log(`  ✔ ${MAIN} is now at ${sha.slice(0, 7)}`);

  if (!release) {
    console.log('  no feat/fix/perf/revert/breaking commit since the last tag — no version tag.');
    return backup([DEV, MAIN]);
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${release.version}`], { allowFail: true }) !== null) {
    die(`tag ${release.version} already exists.`);
  }
  const notesFile = join(mkdtempSync(join(tmpdir(), 'devflow-')), 'notes.txt');
  if (dryRun) console.log(release.notes.replace(/^/gm, '    '));
  else writeFileSync(notesFile, release.notes);
  exec('git', ['tag', '-a', release.version, '-F', notesFile, sha]);
  console.log(`  ✔ tagged ${release.version} (release notes: git show ${release.version})`);
  backup([DEV, MAIN, release.version]);
}

// ---------- backup: DEV/MAIN/tags → remote ----------

/** Plain push (never forced): a rejected push means the remote diverged — warn, local stays as is. */
function backup(refs = [DEV, MAIN, '--tags']) {
  const remote = cfg.remote;
  if (!remote || git(['remote', 'get-url', remote], { allowFail: true }) === null) {
    return console.log(`\n  (no ${remote ?? 'backup'} remote — backup push skipped)`);
  }
  step(`backup: push ${refs.join(' ')} to ${remote}`);
  if (!exec('git', ['push', remote, ...refs], { allowFail: true })) {
    console.log(`  ! backup push failed (offline, or ${remote} has commits local does not). Local ${DEV}/${MAIN} are fine;\n` +
      `    retry later with: ${hint('backup')}. Never force-push to fix it — ask the user.`);
  }
}

// ---------- doctor: is this repo ready for the devflow loop? ----------

function doctor() {
  const problems = [];
  const notes = [];
  const ok = m => console.log(`  ✔ ${m}`);
  const warn = m => { notes.push(m); console.log(`  ! ${m}`); };
  const bad = m => { problems.push(m); console.log(`  ✖ ${m}`); };

  step('doctor: repo readiness');
  if (!cfg.found) warn('no .devflow.json — using defaults (dev → main, origin backup, no gate areas). Run /devflow:init to opt in.');
  for (const [label, b] of [['integration', DEV], ['release', MAIN]]) {
    if (!branchExists(b)) bad(`${label} branch '${b}' does not exist (create it: git branch ${b} ${b === DEV ? MAIN : 'HEAD'}).`);
    else ok(`${label} branch '${b}' exists`);
  }
  const id = (k) => git(['config', k], { allowFail: true });
  if (!id('user.name') || !id('user.email')) bad('git user.name / user.email not set — commits and tags need an identity.');
  else ok(`git identity: ${id('user.name')} <${id('user.email')}>`);

  if (!cfg.areas.length) warn('no gate areas in .devflow.json — land will run commitlint + hard rules only.');
  for (const a of cfg.areas) {
    for (const p of a.paths ?? []) {
      const full = join(REPO_ROOT, p);
      if (!existsSync(full)) bad(`area '${a.name}': path '${p || '.'}' does not exist.`);
    }
    if (a.eslint) {
      const cwd = join(REPO_ROOT, a.eslint.cwd ?? '.');
      const bin = [join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js'), join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')].find(existsSync);
      if (!existsSync(cwd)) bad(`area '${a.name}': eslint cwd '${a.eslint.cwd}' does not exist.`);
      else if (!bin) bad(`area '${a.name}': eslint not installed (needed by the gate) — npm install in ${a.eslint.cwd ?? '.'}.`);
      else ok(`area '${a.name}': eslint ready`);
    }
    for (const c of a.commands ?? []) {
      if (!c.run) bad(`area '${a.name}': a command has no 'run'.`);
      else ok(`area '${a.name}': gate command '${c.label ?? c.run}'`);
    }
  }
  if (cfg.commitlint === true && !existsSync(join(REPO_ROOT, 'node_modules', '@commitlint', 'cli', 'cli.js')))
    bad('commitlint is required by .devflow.json but node_modules/@commitlint/cli is missing (npm install).');
  else if (cfg.commitlint === 'auto' && !existsSync(join(REPO_ROOT, 'node_modules', '@commitlint', 'cli', 'cli.js')))
    warn('commitlint not installed — the gate will skip the commit-message check (set "commitlint": true to require it).');
  else ok('commitlint ready');

  const hookFile = join(REPO_ROOT, '.husky', 'commit-msg');
  if (existsSync(join(REPO_ROOT, '.husky'))) {
    if (!existsSync(hookFile)) warn('.husky/commit-msg missing — commit messages will not be linted locally.');
    else {
      let mode = 0;
      try { mode = statSync(hookFile).mode; } catch { /* unreadable */ }
      if (!(mode & 0o111)) bad('.husky/commit-msg is not executable — git will silently skip it (chmod +x .husky/commit-msg).');
      else ok('.husky/commit-msg executable');
    }
  }
  if (problems.length) die(`doctor: ${problems.length} problem(s) — fix them before relying on the gate.`);
  if (notes.length) console.log(`\n  ${notes.length} warning(s), no blockers.`);
  else console.log('\n  ✔ doctor: everything looks good.');
}

// ---------- status: who works on what (read-only) ----------

/** One line per task worktree (branch, ahead/behind DEV, dirty, handoff note, queue task), then the
 * top ready tasks. Git says who is working; the queue says what is left. */
function status() {
  requireBranch(DEV);
  const mainRoot = mainCheckout(REPO_ROOT);
  const queue = loadQueue(queueFile(REPO_ROOT));
  const tasks = itemsOf(queue.sections);
  const taskOf = b => tasks.find(t => t.meta?.branch === b && t.section !== 'Done');
  const marker = resolve(mainRoot, ...cfg.worktreeDir.split('/'));
  const trees = [...worktreeBranches()].filter(([, p]) => resolve(p).startsWith(marker));

  step(`task worktrees (${trees.length}) — vs ${DEV}`);
  if (!trees.length) console.log('  (none)');
  for (const [branch, path] of trees) {
    const [behind, ahead] = (git(['rev-list', '--left-right', '--count', `${DEV}...${branch}`], { allowFail: true }) ?? '0\t0').split(/\s+/);
    const dirty = git(['-C', path, 'status', '--porcelain'], { allowFail: true });
    const note = existsSync(join(path, ...cfg.handoff.dir.split('/'), `${branch.replace(/\//g, '-')}.md`));
    const t = taskOf(branch);
    const bits = [`+${ahead}/-${behind}`, dirty ? `${dirty.split('\n').length} uncommitted` : 'clean'];
    if (note) bits.push('handoff');
    // ahead 0 is either a fresh branch or one already landed; a branch that ever moved has > 1 reflog entry.
    const moved = (git(['reflog', 'show', '--format=%h', `refs/heads/${branch}`], { allowFail: true }) ?? '').split('\n').length > 1;
    if (ahead === '0' && moved) bits.push(`already in ${DEV} → untask`);
    console.log(`  ${branch.padEnd(32)} ${bits.join(' · ')}${t ? `   [${t.id} ${t.title}]` : ''}`);
  }
  const orphanClaims = tasks.filter(t => t.section === 'In progress' && t.meta?.branch && !trees.some(([b]) => b === t.meta.branch));
  for (const t of orphanClaims) {
    console.log(`  ! ${t.id} is In progress on ${t.meta.branch}, but no task worktree has it` +
      (branchExists(t.meta.branch) ? '' : ` (branch gone — landed? ${hint('queue')} -- done ${t.id})`));
  }

  if (!queue.exists) return;
  const { ready } = readyItems(queue.sections);
  step(`queue: ${ready.length} ready`);
  for (const it of ready.slice(0, 3)) console.log(`  ${describeTask(it, { root: mainRoot, hideBlockedBy: true })}`);
  if (ready.length > 3) console.log(`  … ${hint('queue')} -- ready`);
}

// ---------- cloud-push: back up a cloud session branch (ccr-*) to the remote ----------

const CLOUD_BRANCH = /^ccr-[\w.-]+$/;

/** The only push allowed from a cloud session (its container is thrown away). Plain push of the current
 * ccr-* branch: never DEV/MAIN/tags, never forced. Landing still happens locally via land. */
function cloudPush() {
  const remote = cfg.remote;
  if (!remote || git(['remote', 'get-url', remote], { allowFail: true }) === null) die(`no ${remote ?? 'backup'} remote.`);
  const branch = currentBranch();
  if (!branch || !CLOUD_BRANCH.test(branch)) die(`cloud-push only pushes a ccr-* session branch (current: ${branch || 'detached HEAD'}).`);
  if (git(['status', '--porcelain', '--untracked-files=no'])) die('tracked files have uncommitted changes — commit them first, or they are lost with the container.');

  step('hard rules (secrets etc.) before leaving the container');
  const base = branchExists(DEV) ? DEV : `${remote}/${DEV}`;
  if (spawnSync(process.execPath, [join(HERE, 'hard-rules.mjs'), '--strict', '--base', base], { cwd: REPO_ROOT, stdio: 'inherit' }).status !== 0) {
    die('hard-rules reported ERROR; fix it before cloud-push.');
  }

  step(`cloud-push: ${branch} → ${remote} (backup only, no force)`);
  if (!exec('git', ['push', remote, branch], { allowFail: true })) {
    die(`push rejected (${remote} has commits this branch lacks?). Do not force; ask the user.`);
  }
  console.log(`  ✔ pushed. Land locally: git fetch ${remote} ${branch} → ${hint('task')} (from ${branch}) → ${hint('land')}`);
}

// ---------- sync: drop local branches already in DEV ----------

function sync() {
  step(`delete local branches whose commits are all in ${DEV}`);
  requireBranch(DEV);
  const checkedOut = worktreeBranches();
  const merged = git(['for-each-ref', '--merged', DEV, '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
  for (const b of merged) {
    if ([DEV, MAIN].includes(b)) continue;
    const where = checkedOut.get(b);
    if (where) {
      console.log(`  ! kept ${b}: checked out in ${where}. When done there: leave it (ExitWorktree keep), ` +
        `then from the main checkout: ${hint('untask')} -- ${b}`);
      continue;
    }
    exec('git', ['branch', '-D', b]); // --merged DEV guarantees nothing is lost
  }
  // Cloud branches backed up to the remote and now in DEV: the user deletes them by hand
  // (the guard hook blocks git push, so the script does not delete remote branches).
  const remote = cfg.remote;
  const stale = ((remote && git(['for-each-ref', '--merged', DEV, '--format=%(refname:short)', `refs/remotes/${remote}/ccr-*`], { allowFail: true })) || '')
    .split('\n').filter(Boolean).map(r => r.slice(remote.length + 1));
  if (stale.length) console.log(`\n  Landed cloud branches still on ${remote} — delete by hand: git push ${remote} --delete ${stale.join(' ')}`);
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
if (!REPO_ROOT) die('not inside a git repository');
if (!cfg.found && command && command !== 'help') {
  console.log('  (no .devflow.json — using defaults: dev → main, origin backup, no gate areas)');
}

switch (command) {
  case 'ship': await ship(opts); break;
  case 'land': await land(); break;
  case 'check': await check(); break;
  case 'promote': promote(); break;
  case 'sync': sync(); break;
  case 'backup': backup(); break;
  case 'cloud-push': cloudPush(); break;
  case 'doctor': doctor(); break;
  case 'status': status(); break;
  case 'task': task(opts); break;
  case 'untask': untask(opts); break;
  default:
    console.log(`Usage (add --dry-run to any command to only print mutating steps):
  ship -- (-m "feat(scope): subject" [-m "body"] | -F msg.txt) [--verify] [--land] [--promote] [--shared-ok] [--no-cache] <file>...
  check                    run the land gate on the current branch, merge nothing
  land                     gate + fast-forward ${DEV} to the current task branch, push ${DEV}
  promote                  fast-forward ${MAIN} to ${DEV} + tag ${cfg.tagPrefix}X.Y.Z, push ${DEV}/${MAIN}/tag
  sync                     delete local branches already in ${DEV}
  backup                   push ${DEV}, ${MAIN} and tags to ${cfg.remote}
  cloud-push               cloud session only: push the current ccr-* branch to ${cfg.remote} as a backup
  status                   who works on what: task worktrees vs ${DEV} + top ready queue tasks
  doctor                   check the repo is ready for the devflow loop (branches, gate tooling, hooks)
  task -- <type>/<desc>    new worktree from ${DEV} for one task/session
  untask -- <branch>       remove that worktree safely (run from the main checkout)`);
    process.exit(command && command !== 'help' ? 1 : 0);
}
