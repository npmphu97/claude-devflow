#!/usr/bin/env node
// Remove task worktrees (git registration + the folder under .claude/worktrees/) when the usual
// `npm run untask` / ExitWorktree cannot: leftover folder after a "Permission denied", an
// ExitWorktree "No-op" because the worktree came from an earlier session, or a folder git no longer knows.
//
// Usage (from the main checkout, or anywhere outside the folders being removed):
//   npm run worktrees:clean                      list every worktree and what would happen (changes nothing)
//   npm run worktrees:clean -- --yes             remove the safe ones: branch already in the integration
//                                                branch + clean tree, orphan folders, stale registrations
//   npm run worktrees:clean -- --yes <name>...   only those (branch name or folder name)
//   npm run worktrees:clean -- --yes --force     also remove ones with uncommitted changes or a branch
//                                                not in the integration branch (DISCARDS that work;
//                                                the branch is deleted with -D)
// The shell/editor must not be standing inside a folder being removed (Windows locks it): the script
// moves itself to the main checkout, but close other terminals/IDE windows opened there if it still fails.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync, rmdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig, mainCheckout } from './config.mjs';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const force = args.includes('--force');
const names = args.filter(a => !a.startsWith('--'));

function git(a, { cwd, allowFail = false } = {}) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.error) die(`git not runnable: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) die(`git ${a.join(' ')}\n${r.stderr || r.stdout}`);
  return r.status === 0 ? r.stdout.trim() : null;
}
function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

const mainRoot = mainCheckout(); // also from inside a worktree
if (!mainRoot) die('not inside a git repository');
const DEV = loadConfig(mainRoot).integrationBranch;
process.chdir(mainRoot); // never stand inside a folder we are about to delete
const treesDir = join(mainRoot, '.claude', 'worktrees');

// ---- what git knows ----
const registered = []; // {path, branch, prunable}
{
  let cur = null;
  for (const line of git(['worktree', 'list', '--porcelain'], { cwd: mainRoot }).split('\n')) {
    if (line.startsWith('worktree ')) registered.push((cur = { path: resolve(line.slice(9)), branch: null, prunable: false }));
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice(18);
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
}
const inTrees = p => resolve(p).startsWith(treesDir + sep);
const tasks = registered.filter(w => inTrees(w.path));
const known = new Set(tasks.map(w => w.path.toLowerCase()));
const orphans = existsSync(treesDir)
  ? readdirSync(treesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(treesDir, e.name)).filter(p => !known.has(resolve(p).toLowerCase()))
  : [];

const merged = b => b && git(['merge-base', '--is-ancestor', b, DEV], { cwd: mainRoot, allowFail: true }) !== null;
const dirty = p => (existsSync(p) ? git(['-C', p, 'status', '--porcelain'], { allowFail: true }) || '' : '');
const wanted = (label, path) => !names.length || names.some(n => n === label || n === basename(path));

// ---- plan ----
const plan = [];
for (const w of tasks) {
  const gone = !existsSync(w.path);
  const d = gone ? '' : dirty(w.path);
  const inDev = w.branch ? merged(w.branch) : true;
  const safe = gone || w.prunable || (!d && inDev);
  const why = gone || w.prunable ? 'folder missing (stale registration)' : d ? 'uncommitted changes' : !inDev ? `branch ${w.branch} not in ${DEV}` : `branch in ${DEV}, clean`;
  plan.push({ kind: 'worktree', label: w.branch ?? basename(w.path), path: w.path, branch: w.branch, safe, why });
}
for (const p of orphans) plan.push({ kind: 'orphan folder', label: basename(p), path: p, branch: null, safe: true, why: 'not a git worktree' });

if (!plan.length) {
  console.log('No worktrees under .claude/worktrees.');
  process.exit(0);
}
console.log(`Main checkout: ${mainRoot}\n`);
for (const x of plan) console.log(`  ${x.safe ? '✔ safe ' : '! risky'}  ${x.kind.padEnd(13)} ${x.label}  — ${x.why}\n          ${x.path}`);
if (!yes) {
  console.log('\nDry run. Add --yes to remove the safe ones (and --force for the risky ones).');
  process.exit(0);
}

// ---- act ----
/** Unlink junctions/symlinks (node_modules, .husky/_ ...) so nothing follows them into the main checkout. */
function unlinkLinks(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.name === '.git') continue;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { unlinkSync(p); } catch { try { rmdirSync(p); } catch { /* handled by the final rm */ } }
    } else if (st.isDirectory()) unlinkLinks(p, depth + 1);
  }
}
function removeFolder(p) {
  if (!existsSync(p)) return true;
  unlinkLinks(p);
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (e) {
    console.log(`  ! could not delete ${p}: ${e.code ?? e.message}`);
  }
  return !existsSync(p);
}

let failed = 0;
for (const x of plan) {
  if (!wanted(x.label, x.path)) continue;
  if (!x.safe && !force) { console.log(`\n- skip ${x.label} (${x.why}); use --force to discard it`); continue; }
  console.log(`\n▶ remove ${x.kind} ${x.label}`);
  if (x.kind === 'worktree' && existsSync(x.path)) {
    unlinkLinks(x.path);
    git(['worktree', 'remove', '--force', x.path], { cwd: mainRoot, allowFail: true }); // may leave the folder behind on Windows
  }
  if (!removeFolder(x.path)) { failed++; continue; }
  git(['worktree', 'prune'], { cwd: mainRoot, allowFail: true });
  if (x.branch && git(['rev-parse', '--verify', '--quiet', `refs/heads/${x.branch}`], { cwd: mainRoot, allowFail: true }) !== null) {
    const inDev = merged(x.branch);
    if (!inDev && !force) {
      console.log(`  kept branch ${x.branch}`);
    } else {
      // -D is safe here when inDev (DEV already contains every commit of the branch).
      // Plain -d would wrongly refuse whenever HEAD is behind DEV, which is the normal state.
      const ok = git(['branch', '-D', x.branch], { cwd: mainRoot, allowFail: true }) !== null;
      console.log(ok ? `  deleted branch ${x.branch}${inDev ? '' : ` (was NOT in ${DEV})`}` : `  ! could not delete branch ${x.branch}`);
    }
  }
  console.log('  done');
}
git(['worktree', 'prune'], { cwd: mainRoot, allowFail: true });
if (failed) {
  console.log(`\n✖ ${failed} folder(s) could not be deleted (EPERM = some process still has the folder as its current directory,\n  typically a terminal, IDE window or Claude Code session opened there). Close it and run again.`);
  process.exit(1);
}
