#!/usr/bin/env node
// PreToolUse guard for Bash / PowerShell: turns devflow's hard rules into deterministic blocks.
// Exit 2 blocks the command and shows stderr to the agent. Only active in repos with a .devflow.json,
// so installing the plugin never changes behaviour in other projects.
// The match rules live in guard-rules.mjs (pure, unit-tested); this file only wires stdin/config.
import { spawnSync } from 'node:child_process';
import { repoRoot, loadConfig } from '../kit/scripts/devflow/config.mjs';
import { checkCommand } from './guard-rules.mjs';

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

const current = (() => {
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
})();

const msg = checkCommand(cmd, {
  dev: cfg.integrationBranch,
  main: cfg.releaseBranch,
  current,
  guard: cfg.guard,
});
if (msg) {
  console.error(`Blocked by devflow guard: ${msg}`);
  process.exit(2);
}
process.exit(0);
