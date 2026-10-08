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
// The local clone is the source of truth: no PR, no CI. Integration/release branches only move by
// fast-forward and are pushed to the remote as a backup; task branches are never pushed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, loadConfig, commandHint } from './config.mjs';

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
  const mainRoot = git(['worktree', 'list', '--porcelain']).split('\n')[0].slice(9); // first entry = main checkout
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

/** ESLint errors+warnings of one file: current content, or its version at `baseRef`
 * (read from `baseFile` when the file was moved). */
function eslintCounts(eslintCwd, file, baseRef, baseFile = file) {
  const cwd = join(REPO_ROOT, eslintCwd);
  const rel = relative(cwd, join(REPO_ROOT, file)).replace(/\\/g, '/');
  const base = baseRef ? git(['show', `${baseRef}:${baseFile}`], { allowFail: true }) : null;
  if (baseRef && base === null) return { errors: 0, warnings: 0 }; // new file
  const bin = [join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js'), join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')]
    .find(existsSync);
  if (!bin) die(`eslint not installed in ${eslintCwd}/node_modules (needed by the gate's eslint check).`);
  const args = [bin, '-f', 'json'];
  const r = spawnSync(process.execPath, baseRef ? [...args, '--stdin', '--stdin-filename', rel] : [...args, rel],
    { cwd, encoding: 'utf8', input: base ?? undefined, maxBuffer: 64 * 1024 * 1024 });
  if (!r.stdout?.trim().startsWith('[')) die(`eslint could not run on ${file}:\n${r.stderr}`);
  return JSON.parse(r.stdout).reduce(
    (t, f) => ({ errors: t.errors + f.errorCount, warnings: t.warnings + f.warningCount }), { errors: 0, warnings: 0 });
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

/** Per area of .devflow.json touched by `files`: ESLint delta check (no errors, no new warnings vs the
 * integration branch), then the area's commands (build, unit tests, ...). */
function verify(files) {
  const touched = cfg.areas.map(a => ({ area: a, files: files.filter(f => a.paths.some(p => f.startsWith(p))) }))
    .filter(t => t.files.length);
  if (!cfg.areas.length) return console.log('\n▶ verify: no areas in .devflow.json — nothing to run');
  if (!touched.length) return console.log('\n▶ verify: no changed file belongs to a gate area — nothing to run');

  for (const { area, files: areaFiles } of touched) {
    step(`verify ${area.name}`);
    if (area.eslint) {
      const { cwd = '.', extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.html'] } = area.eslint;
      const prefix = cwd === '.' ? '' : `${cwd.replace(/\/$/, '')}/`;
      const renamed = renamedFromDev();
      for (const f of areaFiles.filter(f => f.startsWith(prefix) && extensions.some(e => f.endsWith(e)) && existsSync(join(REPO_ROOT, f)))) {
        const now = eslintCounts(cwd, f, null);
        const before = eslintCounts(cwd, f, DEV, renamed.get(f));
        const from = renamed.has(f) ? ` at ${renamed.get(f)}` : '';
        console.log(`  ${f}: ${now.errors} error(s), ${now.warnings} warning(s) (${DEV}${from}: ${before.warnings})`);
        if (now.errors > 0) die(`verify: ESLint errors in ${f}. Nothing was committed/merged.`);
        if (now.warnings > before.warnings) die(`verify: ESLint warnings increased in ${f}. Nothing was committed/merged.`);
      }
    }
    for (const c of area.commands ?? []) {
      const run = (isWin && c.runWin) || c.run;
      runLocal(c.label ?? run, run, [], join(REPO_ROOT, c.cwd ?? '.'), { shell: true });
    }
  }
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

function ship(opts) {
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

  if (opts.flags.has('verify')) verify(opts.paths.flatMap(p => changedFiles(toRepoPath(p))));

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

  if (opts.flags.has('land') || opts.flags.has('promote')) land();
  if (opts.flags.has('promote')) promote();
}

// ---------- gate: what land requires; `check` runs it alone ----------

/** commitlint on DEV..HEAD, hard rules (ERROR blocks), then per-area checks of every file changed vs
 * DEV — committed or not (land runs on a clean tree anyway). */
function gate() {
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
  verify([...new Set([...committed, ...changedFiles()])]);
}

function check() {
  requireBranch(DEV);
  gate();
  console.log(`\n  ✔ check passed (same gate as ${hint('land')}; nothing was committed or merged)`);
}

// ---------- land: task branch → DEV (fast-forward) ----------

function land() {
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

  gate();

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
}

// ---------- main ----------

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
if (!REPO_ROOT) die('not inside a git repository');
if (!cfg.found && command && command !== 'help') {
  console.log('  (no .devflow.json — using defaults: dev → main, origin backup, no gate areas)');
}

switch (command) {
  case 'ship': ship(opts); break;
  case 'land': land(); break;
  case 'check': check(); break;
  case 'promote': promote(); break;
  case 'sync': sync(); break;
  case 'backup': backup(); break;
  case 'task': task(opts); break;
  case 'untask': untask(opts); break;
  default:
    console.log(`Usage (add --dry-run to any command to only print mutating steps):
  ship -- (-m "feat(scope): subject" [-m "body"] | -F msg.txt) [--verify] [--land] [--promote] [--shared-ok] <file>...
  check                    run the land gate on the current branch, merge nothing
  land                     gate + fast-forward ${DEV} to the current task branch, push ${DEV}
  promote                  fast-forward ${MAIN} to ${DEV} + tag ${cfg.tagPrefix}X.Y.Z, push ${DEV}/${MAIN}/tag
  sync                     delete local branches already in ${DEV}
  backup                   push ${DEV}, ${MAIN} and tags to ${cfg.remote}
  task -- <type>/<desc>    new worktree from ${DEV} for one task/session
  untask -- <branch>       remove that worktree safely (run from the main checkout)`);
    process.exit(command && command !== 'help' ? 1 : 0);
}
