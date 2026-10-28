// devflow config: defaults merged with <repo>/.devflow.json. Shared by flow / hard-rules / handoff /
// retro and by the plugin hooks. Everything project-specific (branches, gate commands, rules) lives in
// .devflow.json; the scripts themselves stay identical across projects.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONFIG_FILE = '.devflow.json';

export const DEFAULTS = {
  // "local": the clone is the source of truth — task branches → integrationBranch by fast-forward (land),
  //   → releaseBranch (promote + tag); the remote is only a backup; no PR, no CI.
  // "github": GitHub is the source of truth — task branches are pushed and reach integrationBranch through a
  //   pull request merged after CI (the same gate, run by .github/workflows/devflow-gate.yml) and review;
  //   `release` tags the release branch on the remote. integrationBranch may equal releaseBranch (GitHub flow).
  mode: 'local',
  integrationBranch: 'dev',
  releaseBranch: 'main',
  // Backup remote: land/promote push integration/release branches + tags here. null = no backup push.
  remote: 'origin',
  tagPrefix: 'v',
  // One worktree per task, under the main checkout.
  worktreeDir: '.claude/worktrees',
  // Gitignored dirs linked from the main checkout into each task worktree (deps, husky hooks).
  linkDirs: ['node_modules', '.husky/_'],
  // "auto": run commitlint in the gate when node_modules/@commitlint/cli exists; true: required; false: off.
  commitlint: 'auto',
  // Gate areas: files under `paths` trigger the area's eslint delta check and commands.
  // { name, paths: ["frontend/"], eslint?: { cwd, extensions }, commands: [{ label, cwd, run, runWin? }],
  //   format?: { cwd, run, runWin?, extensions? } } — format: run by the PostToolUse hook on each edited
  //   file of the area (the file path, relative to cwd, is appended), e.g. "npx --no-install prettier --write".
  areas: [],
  // Stop hook: an agent on a task branch may not end its turn before `check` passed on the current content.
  stopGate: false,
  // maxParallel: how many touched areas the gate runs at once (0 = all). 1 trades time for peak RAM.
  gate: { maxParallel: 0 },
  // Files whose "version" must never be hand-edited (the tag made by promote is the real version).
  // "package.json" (json key) | { file: "pom.xml", type: "maven" } | { file, regex }
  versionFiles: ['package.json'],
  // Tests: which paths are test files (regex, repo-relative with '/').
  testPaths: [
    '(^|/)(test|tests|__tests__|spec|e2e)/',
    '\\.(spec|test)\\.[cm]?[jt]sx?$',
    '(_test\\.(go|py)|(^|/)test_[^/]+\\.py)$',
    'Tests?\\.(java|kt|cs)$',
  ],
  // Project hard rules on changed lines: { level: "ERROR"|"WARN", files: regex, added?|removed?: regex,
  // msg, unlessChanged?: regex (rule is off when some changed file matches it) }
  rules: [],
  // Optional repo-relative .mjs whose default export gets ({ files, add, root, isCode, isTest }) for
  // rules too complex for a regex.
  rulesModule: null,
  handoff: { dir: '.claude/handoff', openspecDir: 'openspec/changes' },
  retro: {
    days: 7,
    fixWindowDays: 7,
    bigCommitLines: 400,
    codeExtensions: 'java|kt|kts|scala|groovy|ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|cs|rb|php|swift|c|cc|cpp|h|hpp|sql|html|scss|css',
  },
  guard: {
    blockSkipTests: true,
    blockManualPush: true,
    blockGhPr: true,
    blockBranchMoves: true,
    blockDestructiveSql: true,
  },
  // Commands run by the SessionStart hook only in cloud sessions (CLAUDE_CODE_REMOTE=true).
  remoteSetup: [],
  // Branches a cloud session works on (regex): cloud-push pushes only these.
  cloudBranches: '^(ccr-|claude/)[\\w./-]+$',
  github: {
    // Task branches the agent may push in github mode (regex). Protected branches are never pushed by hand.
    pushBranches: '^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)/|^(ccr-|claude/)',
    // Open pull requests as drafts.
    draft: false,
    // Fetch the integration branch from the remote at session start (offline → silently skipped).
    fetchOnStart: true,
  },
};

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function repoRoot(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The main checkout (shared by every task worktree), also when `cwd` is inside a linked worktree. */
export function mainCheckout(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? resolve(cwd, r.stdout.trim(), '..') : null; // <main>/.git/.. = main checkout
}

/** Config of the checkout at `root`; `found` tells whether the repo opted in with a .devflow.json. */
export function loadConfig(root) {
  const file = root && join(root, CONFIG_FILE);
  if (!file || !existsSync(file)) return { ...DEFAULTS, found: false };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`✖ ${CONFIG_FILE} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  return { ...merge(DEFAULTS, raw), found: true };
}

/** The ref the gate diffs against. github mode: the remote-tracking integration branch (fresh after a fetch),
 * else the local one; local mode: the local branch, else the remote-tracking one (cloud / CI clones have no
 * local integration branch). `override` (check --base) wins. null when none exists. */
export function baseRef(root, cfg, override) {
  const has = ref => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root }).status === 0;
  if (override) return has(override) ? override : null;
  const local = `refs/heads/${cfg.integrationBranch}`;
  const remote = cfg.remote && `refs/remotes/${cfg.remote}/${cfg.integrationBranch}`;
  const order = cfg.mode === 'github' ? [remote, local] : [local, remote];
  const hit = order.find(r => r && has(r));
  return hit ? hit.replace(/^refs\/(heads|remotes)\//, '') : null;
}

/** owner/repo of a GitHub remote URL (https, ssh, or a proxy URL ending in /owner/repo[.git]). */
export function githubSlug(url) {
  const m = (url ?? '').trim().match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** How a human runs a devflow command here: `npm run land` when package.json has the script. */
export function commandHint(root, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.scripts?.[name]) return `npm run ${name}`;
  } catch { /* no package.json */ }
  const script = { 'hard-rules': 'hard-rules.mjs', retro: 'retro.mjs', handoff: 'handoff.mjs' }[name];
  return script ? `node scripts/devflow/${script}` : `node scripts/devflow/flow.mjs ${name}`;
}
