#!/usr/bin/env node
// SessionStart hook (only in repos with a .devflow.json):
// 1. Every session: print the current branch's handoff note (stdout is added to the agent's context),
//    then a few lines of the shared task queue (this branch's task, how many are ready, the next one).
// 2. Cloud sessions (CLAUDE_CODE_REMOTE=true): run .devflow.json "remoteSetup" commands. Output goes to
//    stderr to keep the context small.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, loadConfig } from '../kit/scripts/devflow/config.mjs';
import { queueFile, load as loadQueue, itemsOf, readyItems, describe } from '../kit/scripts/devflow/queue-lib.mjs';

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

// A change committed to the integration branch with at least one task ticked has landed; while it is still
// in <openspecDir>/ (not archive/), nobody has archived it yet.
if (git(['rev-parse', '--verify', '-q', cfg.integrationBranch])) {
  const dir = cfg.handoff.openspecDir;
  const pending = [];
  for (const n of existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []) {
    if (n === 'archive') continue;
    const tasks = git(['show', `${cfg.integrationBranch}:${dir}/${n}/tasks.md`]);
    const done = (tasks.match(/^\s*- \[x\]/gim) ?? []).length;
    if (done > 0) pending.push(`${n} (${done}/${(tasks.match(/^\s*- \[[ x]\]/gim) ?? []).length} task)`);
  }
  if (pending.length) {
    console.log(`=== OpenSpec: landed in ${cfg.integrationBranch} but not archived — tell the user; archive with 'npm run archive -- <name>' from the main checkout (if the script refuses, /opsx:archive in a subagent): ${pending.join(', ')} ===`);
  }
}

const queue = loadQueue(queueFile(root));
if (queue.exists) {
  const mine = branch && itemsOf(queue.sections).find(t => t.section === 'In progress' && t.meta?.branch === branch);
  const { ready } = readyItems(queue.sections);
  console.log(`=== Task queue (.claude/task-queue.md in the main checkout; skill devflow:queue) ===`);
  if (mine) console.log(`This branch is ${describe(mine)} — run \`queue done ${mine.id}\` after land.`);
  console.log(`${ready.length} ready${ready[0] ? `; next: ${describe(ready[0], { hideBlockedBy: true })}` : ''}`);
}

// github mode: GitHub is the source of truth — refresh <remote>/<dev> so check / hard-rules / status diff
// against what is really merged. Offline or no remote → skipped quietly.
if (cfg.mode === 'github' && cfg.remote && cfg.github?.fetchOnStart !== false) {
  spawnSync('git', ['fetch', '-q', cfg.remote, cfg.integrationBranch], { cwd: root, stdio: 'ignore', timeout: 20000 });
}

if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // Cloud clones have no local integration branch, so check / hard-rules could not diff against it.
  const dev = cfg.integrationBranch;
  if (cfg.mode !== 'github' && cfg.remote && branch !== dev && spawnSync('git', ['ls-remote', '--exit-code', '--heads', cfg.remote, dev], { cwd: root }).status === 0) {
    const f = spawnSync('git', ['fetch', '-q', cfg.remote, `${dev}:${dev}`], { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });
    if (f.status !== 0) console.error(`could not create local ${dev} from ${cfg.remote}/${dev}; cloud-push falls back to ${cfg.remote}/${dev}`);
  }
  for (const c of cfg.remoteSetup) {
    const r = spawnSync(c, { cwd: root, shell: true, stdio: ['ignore', process.stderr, process.stderr] });
    if (r.status !== 0) console.error(`devflow remoteSetup failed: ${c}`);
  }
  if (process.env.CLAUDE_ENV_FILE && existsSync(join(root, 'node_modules', '.bin'))) {
    appendFileSync(process.env.CLAUDE_ENV_FILE, `export PATH="${join(root, 'node_modules', '.bin')}:$PATH"\nexport OPENSPEC_TELEMETRY=0\n`);
  }
}
