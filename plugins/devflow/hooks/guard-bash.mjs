#!/usr/bin/env node
// PreToolUse guard for Bash / PowerShell: turns devflow's hard rules into deterministic blocks.
// Exit 2 blocks the command and shows stderr to the agent. Only active in repos with a .devflow.json,
// so installing the plugin never changes behaviour in other projects.
import { repoRoot, loadConfig } from '../kit/scripts/devflow/config.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}
const cmd = payload.tool_input?.command ?? '';
if (!cmd) process.exit(0);

const root = repoRoot(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const cfg = loadConfig(root);
if (!cfg.found) process.exit(0);
const g = cfg.guard;

function block(msg) {
  console.error(`Blocked by devflow guard: ${msg}`);
  process.exit(2);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BRANCHES = `(${esc(cfg.integrationBranch)}|${esc(cfg.releaseBranch)})`;

// Patterns only match within one command segment (same line, before | ; &), so the flag or keyword
// must belong to the build/DB command itself, not to text inside a heredoc or string.

if (g.blockSkipTests && /(mvnw?|gradlew?|npm|npx|pnpm|yarn|ng|dotnet|pytest|go)\s[^|;&\n]*(-DskipTests|-Dmaven\.test\.skip|-x\s+test\b|--skip-tests|--no-tests)/.test(cmd)) {
  block('skipping tests is not allowed. Run the relevant tests instead.');
}

// Integration/release branches only move through scripts/devflow/flow.mjs, which also pushes them
// (plus tags) to the backup remote. Nobody pushes by hand; task branches never leave the clone.
// Anchored to the start of a command, so "git push" inside a quoted commit message does not match.
if (g.blockManualPush && /(^|[;&|(\n])\s*git(\.exe)?(\s+-[^\s]+(\s+[^-\s][^\s]*)?)*\s+push(\s|$)/m.test(cmd)) {
  block('manual git push is not allowed: land / promote / backup push the integration and release branches and tags; task branches stay local (skill devflow:ship).');
}
if (g.blockGhPr && /(^|[;&|(\n])\s*gh(\.exe)?\s+(pr|release|run)\s/m.test(cmd)) {
  block('no PR / GitHub release / workflow runs in the local flow: the remote is only a backup (skill devflow:ship).');
}
if (g.blockBranchMoves && new RegExp(`git\\s[^|;&\\n]*(update-ref\\s+(refs/heads/)?${BRANCHES}|branch\\s+(-f|--force|-M|-D)\\s+${BRANCHES})(\\s|$)`).test(cmd)) {
  block(`${cfg.integrationBranch}/${cfg.releaseBranch} only move by fast-forward via land / promote (skill devflow:ship).`);
}

if (g.blockDestructiveSql && /\b(mysql|mariadb|psql|sqlite3|sqlcmd|mongosh)\b[^|;&\n]*\b(drop\s+(table|database|schema|collection)|truncate\s|delete\s+from|alter\s+table|update\s+[a-z_."`]+\s+set|\.drop\(|\.deleteMany\()/i.test(cmd)) {
  block('destructive SQL from the shell is not allowed. Write a reviewed migration / data tool with a dry-run and ask the user.');
}

if (/rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)|Remove-Item\s[^|;&\n]*-Recurse[^|;&\n]*\s(C:\\|\$HOME|~)(\s|$)/i.test(cmd)) {
  block('recursive delete of / or home is not allowed.');
}

process.exit(0);
