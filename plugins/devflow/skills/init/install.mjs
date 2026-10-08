#!/usr/bin/env node
// Bootstrap (or update) devflow in a git repo: vendor scripts/devflow/, draft .devflow.json from the
// detected stack, add npm scripts, CLAUDE.md section, docs, .gitignore and commitlint config.
// Never overwrites a file that exists (except vendored scripts with --update / --force).
// Usage: node install.mjs [--target <repo>] [--dry-run] [--update] [--force] [--no-package-json]
//                         [--create-package-json] [--create-dev]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'kit');
const args = process.argv.slice(2);
const flag = f => args.includes(`--${f}`);
const dryRun = flag('dry-run');
const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : process.cwd();

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8' });
if (top.status !== 0) {
  console.error(`✖ ${target} is not inside a git repository (git init first).`);
  process.exit(1);
}
const root = top.stdout.trim();
const report = [];
const did = (what, path) => report.push(`  ${dryRun ? '[dry-run] ' : ''}${what.padEnd(9)} ${path}`);

function write(rel, content, { overwrite = false } = {}) {
  const file = join(root, rel);
  if (existsSync(file) && !overwrite) return did('kept', `${rel} (exists)`);
  const verb = existsSync(file) ? 'updated' : 'created';
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  did(verb, rel);
}
const tpl = name => readFileSync(join(KIT, 'templates', name), 'utf8');

// ---------- 1. vendored scripts ----------
const scriptsSrc = join(KIT, 'scripts', 'devflow');
for (const f of readdirSync(scriptsSrc)) {
  const rel = `scripts/devflow/${f}`;
  const dest = join(root, rel);
  const same = existsSync(dest) && readFileSync(dest, 'utf8') === readFileSync(join(scriptsSrc, f), 'utf8');
  if (same) { did('same', rel); continue; }
  if (existsSync(dest) && !flag('update') && !flag('force')) { did('kept', `${rel} (differs — rerun with --update to refresh)`); continue; }
  const existed = existsSync(dest);
  if (!dryRun) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(scriptsSrc, f), dest);
  }
  did(existed ? 'updated' : 'created', rel);
}
if (flag('update')) {
  console.log(report.join('\n'));
  process.exit(0);
}

// ---------- 2. detect stack → .devflow.json draft ----------
const SKIP = new Set(['node_modules', '.git', '.claude', '.husky', 'docs', 'dist', 'build', 'target', 'out', 'scripts', 'openspec', '.idea', '.vscode']);
const dirs = ['.', ...readdirSync(root).filter(d => !SKIP.has(d) && !d.startsWith('.') && statSync(join(root, d)).isDirectory())];
const has = (d, f) => existsSync(join(root, d, f));
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const areas = [];
const versionFiles = [];
const linkDirs = [];
const testHints = [];
for (const d of dirs) {
  const name = d === '.' ? 'root' : d;
  const paths = [d === '.' ? '' : `${d}/`];
  const pkg = has(d, 'package.json') ? readJson(join(root, d, 'package.json')) : null;
  if (pkg) {
    versionFiles.push(d === '.' ? 'package.json' : `${d}/package.json`);
    linkDirs.push(d === '.' ? 'node_modules' : `${d}/node_modules`);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const commands = [];
    if (pkg.scripts?.build) commands.push({ label: `${name}: build`, cwd: d, run: 'npm run build' });
    // `ng test` / karma / jest --watch open a browser or watch: leave unit tests for the user to wire.
    if (pkg.scripts?.test && !/\b(ng test|karma|--watch)\b|no test specified/.test(pkg.scripts.test)) {
      commands.push({ label: `${name}: test`, cwd: d, run: 'npm test' });
    } else if (pkg.scripts?.test) testHints.push(`${name}: "npm test" (${pkg.scripts.test}) is interactive — add a CI-style test command by hand`);
    const isTooling = d === '.' && !commands.length && !deps.eslint;
    if (!isTooling && (commands.length || deps.eslint)) {
      areas.push({ name, paths, ...(deps.eslint ? { eslint: { cwd: d, extensions: ['.ts', '.tsx', '.js', '.jsx', '.vue', '.html'] } } : {}), commands });
    }
  }
  if (has(d, 'pom.xml')) {
    versionFiles.push({ file: d === '.' ? 'pom.xml' : `${d}/pom.xml`, type: 'maven' });
    const wrapper = has(d, 'mvnw');
    areas.push({ name: pkg ? `${name}-maven` : name, paths, commands: [{
      label: `${name}: unit tests`, cwd: d,
      run: wrapper ? './mvnw -B test' : 'mvn -B test', runWin: wrapper ? 'mvnw.cmd -B test' : 'mvn -B test',
    }] });
    testHints.push(`${name}: if some tests need a database, exclude them in the gate (e.g. -Dtest='!**/e2e/**,!*IT')`);
  } else if (has(d, 'build.gradle') || has(d, 'build.gradle.kts')) {
    const wrapper = has(d, 'gradlew');
    areas.push({ name, paths, commands: [{ label: `${name}: test`, cwd: d,
      run: wrapper ? './gradlew test' : 'gradle test', runWin: wrapper ? 'gradlew.bat test' : 'gradle test' }] });
  }
  if (has(d, 'pyproject.toml') || has(d, 'requirements.txt')) {
    areas.push({ name: `${name}-python`, paths, commands: [{ label: `${name}: pytest`, cwd: d, run: 'python -m pytest -q' }] });
  }
  if (has(d, 'go.mod')) areas.push({ name: `${name}-go`, paths, commands: [{ label: `${name}: go test`, cwd: d, run: 'go vet ./... && go test ./...' }] });
  if (has(d, 'Cargo.toml')) areas.push({ name: `${name}-rust`, paths, commands: [{ label: `${name}: cargo test`, cwd: d, run: 'cargo test' }] });
  if (readdirSync(join(root, d)).some(f => /\.(sln|csproj)$/.test(f))) {
    areas.push({ name: `${name}-dotnet`, paths, commands: [{ label: `${name}: dotnet test`, cwd: d, run: 'dotnet test' }] });
  }
}
linkDirs.push('.husky/_');

const branchExists = b => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: root }).status === 0;
const release = branchExists('main') ? 'main' : branchExists('master') ? 'master' : 'main';
const remote = spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)[0] ?? null;

const config = {
  $comment: 'devflow config — see the devflow plugin README. Review areas/commands: they are the land gate.',
  integrationBranch: 'dev',
  releaseBranch: release,
  remote,
  linkDirs,
  areas,
  versionFiles: versionFiles.length ? versionFiles : ['package.json'],
  rules: [],
};
write('.devflow.json', `${JSON.stringify(config, null, 2)}\n`);

// ---------- 3. package.json scripts ----------
const SCRIPTS = {
  task: 'node scripts/devflow/flow.mjs task',
  untask: 'node scripts/devflow/flow.mjs untask',
  ship: 'node scripts/devflow/flow.mjs ship',
  check: 'node scripts/devflow/flow.mjs check',
  land: 'node scripts/devflow/flow.mjs land',
  promote: 'node scripts/devflow/flow.mjs promote',
  sync: 'node scripts/devflow/flow.mjs sync',
  backup: 'node scripts/devflow/flow.mjs backup',
  'hard-rules': 'node scripts/devflow/hard-rules.mjs',
  retro: 'node scripts/devflow/retro.mjs',
  handoff: 'node scripts/devflow/handoff.mjs',
};
const pkgFile = join(root, 'package.json');
if (!flag('no-package-json') && (existsSync(pkgFile) || flag('create-package-json'))) {
  const pkg = existsSync(pkgFile) ? readJson(pkgFile) : { name: root.split(/[\\/]/).pop().toLowerCase(), private: true };
  if (!pkg) {
    did('skipped', 'package.json (invalid JSON)');
  } else {
    pkg.scripts ??= {};
    const clashes = [];
    for (const [k, v] of Object.entries(SCRIPTS)) {
      if (!pkg.scripts[k]) pkg.scripts[k] = v;
      else if (pkg.scripts[k] !== v) clashes.push(k);
    }
    const existed = existsSync(pkgFile);
    if (!dryRun) writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    did(existed ? 'updated' : 'created', `package.json (scripts${clashes.length ? `; kept existing: ${clashes.join(', ')} — use node scripts/devflow/flow.mjs <cmd> for those` : ''})`);
  }
} else {
  did('skipped', 'package.json (none — run node scripts/devflow/flow.mjs <cmd>, or rerun with --create-package-json)');
}

// ---------- 4. docs, CLAUDE.md, handoff dir, gitignore, commitlint ----------
const claudeMd = join(root, 'CLAUDE.md');
const section = tpl('CLAUDE.devflow.md');
if (existsSync(claudeMd)) {
  if (readFileSync(claudeMd, 'utf8').includes('<!-- devflow:start -->')) did('kept', 'CLAUDE.md (devflow section already there)');
  else {
    if (!dryRun) appendFileSync(claudeMd, `\n${section}`);
    did('appended', 'CLAUDE.md (devflow section — fill the <...> placeholders)');
  }
} else write('CLAUDE.md', `# CLAUDE.md — <tên dự án>\n\n<Tổng quan, kiến trúc, lệnh build/test: chạy /init của Claude Code để sinh phần này.>\n\n${section}`);

write('docs/AGENT_WORKFLOW.md', tpl('AGENT_WORKFLOW.md'));
write('.claude/handoff/README.md', tpl('handoff-README.md'));

// devflow files must be committable: a global excludesFile that ignores CLAUDE.md / .claude/ / openspec/
// would silently keep handoff notes and the CLAUDE.md section out of git, so re-include them here.
const gitignore = join(root, '.gitignore');
const gi = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
const ignored = p => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: root }).status === 0;
const lines = [];
for (const [probe, line] of [['CLAUDE.md', '!CLAUDE.md'], ['.claude/handoff/README.md', '!.claude/'], ['openspec/config.yaml', '!openspec/']]) {
  if (ignored(probe) && !gi.split(/\r?\n/).includes(line)) lines.push(line);
}
if (!/^(\*\*\/)?\/?\.claude\/worktrees\/?$/m.test(gi)) lines.push('**/.claude/worktrees/');
if (lines.some(l => l === '!.claude/') && !/settings\.local\.json/.test(gi)) lines.push('**/.claude/settings.local.json*');
if (!lines.length) did('kept', '.gitignore (already fine)');
else {
  const header = lines.some(l => l.startsWith('!')) ? '# devflow: keep CLAUDE.md / .claude / openspec tracked even if a global excludesFile ignores them\n' : '';
  if (!dryRun) appendFileSync(gitignore, `${gi && !gi.endsWith('\n') ? '\n' : ''}${header}${lines.join('\n')}\n`);
  did('updated', `.gitignore (+ ${lines.join(', ')})`);
}

const commitlintFiles = ['commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yml', '.commitlintrc.js'];
if (commitlintFiles.some(f => existsSync(join(root, f)))) did('kept', 'commitlint config (exists)');
else write('commitlint.config.cjs', tpl('commitlint.config.cjs'));
if (existsSync(join(root, '.husky')) || flag('create-package-json') || existsSync(pkgFile)) {
  write('.husky/commit-msg', 'npx --no -- commitlint --edit "$1"\n');
}

// ---------- 5. integration branch ----------
if (!branchExists('dev')) {
  if (flag('create-dev')) {
    if (!dryRun) spawnSync('git', ['branch', 'dev', release], { cwd: root, stdio: 'inherit' });
    did('created', `branch dev from ${release}`);
  } else did('todo', `branch dev does not exist — rerun with --create-dev (git branch dev ${release})`);
}

console.log(`devflow install into ${root}\n${report.join('\n')}`);
console.log(`\nDetected gate areas: ${areas.length ? areas.map(a => a.name).join(', ') : '(none — add them to .devflow.json)'}`);
for (const h of testHints) console.log(`  ! ${h}`);
console.log(`\nKit: ${resolve(KIT)}`);
