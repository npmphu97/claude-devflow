#!/usr/bin/env node
// PostToolUse hook for Edit / Write / MultiEdit (only in repos with a .devflow.json): run the formatter of
// the gate area that owns the edited file — `areas[].format` — so formatting never reaches the gate or
// the reviewer. Best effort: a missing or failing formatter is ignored (the land gate still lints).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { repoRoot, loadConfig } from '../kit/scripts/devflow/config.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}
const file = payload.tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);

const root = repoRoot(dirname(file));
const cfg = loadConfig(root);
if (!cfg.found) process.exit(0);

const rel = relative(root, file).replace(/\\/g, '/');
const area = cfg.areas.find(a => a.format && a.paths.some(p => rel.startsWith(p)));
const fmt = area?.format;
if (!fmt || (fmt.extensions && !fmt.extensions.includes(extname(file)))) process.exit(0);

const cwd = join(root, fmt.cwd ?? '');
const run = process.platform === 'win32' && fmt.runWin ? fmt.runWin : fmt.run;
spawnSync(`${run} "${relative(cwd, file)}"`, { cwd, shell: true, stdio: 'ignore', timeout: 30000 });
