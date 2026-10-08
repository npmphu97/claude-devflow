#!/usr/bin/env node
// SessionStart hook (only in repos with a .devflow.json):
// 1. Every session: print the current branch's handoff note (stdout is added to the agent's context).
// 2. Cloud sessions (CLAUDE_CODE_REMOTE=true): run .devflow.json "remoteSetup" commands. Output goes to
//    stderr to keep the context small.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, loadConfig } from '../kit/scripts/devflow/config.mjs';

const root = repoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const cfg = loadConfig(root);
if (!cfg.found) process.exit(0);

const git = args => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch && branch !== 'HEAD') {
  const base = git(['rev-parse', '--verify', '-q', cfg.integrationBranch]) ? cfg.integrationBranch : cfg.releaseBranch;
  const notes = [`${cfg.handoff.dir}/${branch.replace(/\//g, '-')}.md`];
  // An OpenSpec change's handoff belongs to this branch when the branch has commits in that change.
  const changes = join(root, cfg.handoff.openspecDir);
  if (existsSync(changes)) {
    for (const n of readdirSync(changes)) {
      const rel = `${cfg.handoff.openspecDir}/${n}/handoff.md`;
      if (existsSync(join(root, rel)) && git(['log', '--oneline', `${base}..HEAD`, '--', `${cfg.handoff.openspecDir}/${n}`])) notes.push(rel);
    }
  }
  for (const rel of notes) {
    if (!existsSync(join(root, rel))) continue;
    console.log(`=== Handoff note for branch ${branch} (${rel}) — read before continuing (/devflow:handoff resume) ===`);
    console.log(readFileSync(join(root, rel), 'utf8').split('\n').slice(0, 40).join('\n'));
  }
}

if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  for (const c of cfg.remoteSetup) {
    const r = spawnSync(c, { cwd: root, shell: true, stdio: ['ignore', process.stderr, process.stderr] });
    if (r.status !== 0) console.error(`devflow remoteSetup failed: ${c}`);
  }
  if (process.env.CLAUDE_ENV_FILE && existsSync(join(root, 'node_modules', '.bin'))) {
    appendFileSync(process.env.CLAUDE_ENV_FILE, `export PATH="${join(root, 'node_modules', '.bin')}:$PATH"\nexport OPENSPEC_TELEMETRY=0\n`);
  }
}
