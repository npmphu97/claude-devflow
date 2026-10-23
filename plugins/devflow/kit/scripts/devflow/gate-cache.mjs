// devflow gate cache: the key that says "the gate already ran green on exactly this content".
// Shared by flow.mjs (check / land write and read it) and the plugin's Stop hook (reads it).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const git = (root, args, env) => {
  const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** The working tree as a git tree id: tracked + untracked files, minus ignored ones — exactly what hard
 * rules and the areas look at. Staged into a copy of the index so unchanged files keep their stat cache
 * (nothing is re-hashed); the real index is untouched. null when git cannot do it. */
export function worktreeTree(root) {
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-index-'));
  try {
    const index = join(tmp, 'index');
    const real = resolve(root, git(root, ['rev-parse', '--git-path', 'index']) ?? '');
    if (existsSync(real)) copyFileSync(real, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (spawnSync('git', ['add', '-A'], { cwd: root, env }).status !== 0) return null;
    return git(root, ['write-tree'], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Hard rules and areas depend only on the content vs `dev`, committed or not: same working tree, same
 * `dev`, same merge base → same result. null when git cannot compute it. */
export function gateKey(root, dev) {
  const tree = worktreeTree(root);
  const devSha = git(root, ['rev-parse', dev]);
  return tree && devSha ? `${tree} ${devSha} ${git(root, ['merge-base', dev, 'HEAD']) ?? ''}` : null;
}

/** Per-worktree file holding the key of the last green gate. */
export const cacheFile = root => join(git(root, ['rev-parse', '--absolute-git-dir']), 'gate-passed');

/** Working-tree part of the last green key: the content that passed, whatever `dev` was then. */
export const passedTree = root => existsSync(cacheFile(root)) ? readFileSync(cacheFile(root), 'utf8').split(' ')[0] : null;

export const gatePassed = (root, key) => !!key && existsSync(cacheFile(root)) && readFileSync(cacheFile(root), 'utf8') === key;

export const markPassed = (root, key) => key && writeFileSync(cacheFile(root), key);
