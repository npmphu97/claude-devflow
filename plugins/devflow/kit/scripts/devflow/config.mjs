// devflow config: defaults merged with <repo>/.devflow.json. Shared by flow / hard-rules / handoff /
// retro and by the plugin hooks. Everything project-specific (branches, gate commands, rules) lives in
// .devflow.json; the scripts themselves stay identical across projects.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = '.devflow.json';

export const DEFAULTS = {
  // Local-first flow: task branches → integrationBranch (land) → releaseBranch (promote + tag).
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
  // { name, paths: ["frontend/"], eslint?: { cwd, extensions }, commands: [{ label, cwd, run, runWin? }] }
  areas: [],
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

/** How a human runs a devflow command here: `npm run land` when package.json has the script. */
export function commandHint(root, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.scripts?.[name]) return `npm run ${name}`;
  } catch { /* no package.json */ }
  const script = { 'hard-rules': 'hard-rules.mjs', retro: 'retro.mjs', handoff: 'handoff.mjs' }[name];
  return script ? `node scripts/devflow/${script}` : `node scripts/devflow/flow.mjs ${name}`;
}
