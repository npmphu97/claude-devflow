#!/usr/bin/env node
// Stop hook (only in repos with a .devflow.json that sets "stopGate": true): the agent may not end its
// turn on a task branch whose current content has not passed the land gate. "Passed" is the same
// content-keyed cache `check` / `land` write (gate-cache.mjs), so after one green `check` this costs one
// `git write-tree`. Blocks once per stop (stop_hook_active): an agent stopping on purpose — a question for
// the user, a handoff — says so and ends the turn again. The integration / release branches are left
// alone: hot-fix-dev gates through `ship --verify`, and the main checkout may hold other sessions' edits.
import { spawnSync } from 'node:child_process';
import { repoRoot, loadConfig, commandHint } from '../kit/scripts/devflow/config.mjs';
import { gateKey, gatePassed } from '../kit/scripts/devflow/gate-cache.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}
if (payload.stop_hook_active) process.exit(0);

const root = repoRoot(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const cfg = loadConfig(root);
if (!cfg.found || !cfg.stopGate) process.exit(0);

const git = args => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const dev = cfg.integrationBranch;
const branch = git(['branch', '--show-current']);
if (!branch || branch === dev || branch === cfg.releaseBranch) process.exit(0);
if (!git(['rev-parse', '--verify', '-q', dev])) process.exit(0);
const ahead = Number(git(['rev-list', '--count', `${dev}..HEAD`]) ?? 0);
if (!ahead && !git(['status', '--porcelain'])) process.exit(0);

if (gatePassed(root, gateKey(root, dev))) process.exit(0);

console.log(JSON.stringify({
  decision: 'block',
  reason: `devflow stop gate: ${branch} has changes that have not passed the land gate. Run \`${commandHint(root, 'check')}\` `
    + '(Bash timeout: 600000), fix it if red (skill devflow:steward), and report its result lines. '
    + 'If you are stopping on purpose (question for the user, handoff, work not finished yet), say so in one line and end the turn.',
}));
