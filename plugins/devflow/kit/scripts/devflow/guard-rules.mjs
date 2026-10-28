// devflow guard rules — pure functions, no I/O, so they can be unit-tested
// (see scripts/devflow/devflow.test.mjs). The PreToolUse hook (guard-bash.mjs) builds the
// context from .devflow.json and calls checkCommand.
//
// A "protected" branch is the integration or release branch: it only moves by fast-forward
// through scripts/devflow/flow.mjs (land / promote), or — in github mode — by a merged pull request.
// Everything else that would move it, merge into it, or rewrite it is blocked.
// github mode: pushing a task branch is allowed (that is how a PR starts); pushing a protected branch,
// tags, force / delete / mirror pushes are not, and `gh` may read and open PRs but not merge or release.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tokens of every `git push` segment in `cmd` (quotes are not interpreted: good enough for refspecs). */
function pushSegments(cmd) {
  const out = [];
  for (const seg of cmd.split(/[;&|(\n]+/)) {
    const m = seg.match(/^\s*git(\.exe)?((?:\s+-[^\s]+(?:\s+[^\-\s][^\s]*)?)*)\s+push(\s.*|$)/);
    if (m) out.push(m[3].trim().split(/\s+/).filter(Boolean));
  }
  return out;
}

/** github mode: why this push is not allowed, or null. Allowed: plain push of a task branch matching
 * pushBranches (optionally -u / --set-upstream, an explicit remote, `HEAD` or `branch` / `branch:branch`). */
export function githubPushProblem(tokens, { dev, main, current, pushBranches }) {
  const protectedNames = new Set([dev, main]);
  const bad = tokens.find(t => /^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror|--all|--tags|--follow-tags|--delete|-d|--prune)$/.test(t));
  if (bad) return `\`git push ${bad}\` is not allowed: never force, delete, mirror or push tags by hand (tags come from \`release\`).`;
  const args = tokens.filter(t => !/^(-u|--set-upstream|--no-verify|-q|--quiet|-v|--verbose|--porcelain)$/.test(t));
  if (args.some(t => t.startsWith('-'))) return `unexpected flag in git push (${args.find(t => t.startsWith('-'))}) — use the plain form: git push -u origin <task-branch>.`;
  const refspecs = args.slice(1); // args[0] is the remote
  const targets = refspecs.length ? refspecs : [current];
  for (const spec of targets) {
    if (spec.startsWith('+') || spec.startsWith(':')) return `refspec ${spec} forces or deletes — not allowed.`;
    const [src, dst = src] = spec.split(':');
    const name = (dst === 'HEAD' ? current : dst).replace(/^refs\/heads\//, '');
    if (/^refs\/tags\//.test(dst) || /^v\d/.test(name)) return `pushing tag ${name} by hand is not allowed — \`release\` creates and pushes version tags.`;
    if (protectedNames.has(name) || (src === 'HEAD' && protectedNames.has(current) && dst === src)) {
      return `${name} is protected: it only moves by a merged pull request (github mode). Push your task branch and open a PR (\`pr\`).`;
    }
    if (!new RegExp(pushBranches).test(name)) return `branch ${name || '(none)'} does not match github.pushBranches (${pushBranches}) — create a task branch (feat/…, fix/…) first.`;
  }
  return null;
}

/** Build the rule list for a repo. ctx: { dev, main, current, guard, mode?, pushBranches? }. */
export function buildRules({ dev, main, current, guard, mode = 'local', pushBranches = '^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)/|^(ccr-|claude/)' }) {
  const github = mode === 'github';
  const D = esc(dev), M = esc(main);
  const BRANCHES = `(${D}|${M})`;
  // Start of one command segment: after start-of-line, ;, &, | or (. The flag or subcommand must
  // belong to the command itself, not to text inside a heredoc or quoted string.
  const SEG = String.raw`(?:^|[;&|(\n])\s*`;
  const rules = [];

  if (guard.blockSkipTests) rules.push({
    re: /(mvnw?|gradlew?|npm|npx|pnpm|yarn|ng|dotnet|pytest|go)\s[^|;&\n]*(-DskipTests|-Dmaven\.test\.skip|-x\s+test\b|--skip-tests|--no-tests)/,
    msg: 'skipping tests is not allowed. Run the relevant tests instead.',
  });

  if (guard.blockManualPush && github) rules.push({
    re: new RegExp(`${SEG}git(\\.exe)?(\\s+-[^\\s]+(\\s+[^\\-\\s][^\\s]*)?)*\\s+push(\\s|$)`, 'm'),
    check: cmd => pushSegments(cmd).map(t => githubPushProblem(t, { dev, main, current, pushBranches })).find(Boolean) ?? null,
  });
  else if (guard.blockManualPush) rules.push({
    re: new RegExp(`${SEG}git(\\.exe)?(\\s+-[^\\s]+(\\s+[^\\-\\s][^\\s]*)?)*\\s+push(\\s|$)`, 'm'),
    msg: `manual git push is not allowed: land / promote / backup push the integration and release branches and tags; task branches stay local (skill devflow:ship). In a cloud session (branch ccr-*) use cloud-push.`,
  });

  if (guard.blockGhPr && github) rules.push({
    re: new RegExp(`${SEG}gh(\\.exe)?\\s+(pr\\s+(merge|close|ready\\s+--undo)|release\\s+(create|delete|edit|upload)|repo\\s+(delete|edit|rename)|api\\s[^|;&\\n]*(-X|--method)\\s*(DELETE|PUT|PATCH))(\\s|$)`, 'm'),
    msg: 'github mode: the agent may read and open pull requests, not merge / close them, release, or change the repo — a human merges after CI and review (skill devflow:ship).',
  });
  else if (guard.blockGhPr) rules.push({
    re: new RegExp(`${SEG}gh(\\.exe)?\\s+(pr|release|run)\\s`, 'm'),
    msg: 'no PR / GitHub release / workflow runs in the local flow: the remote is only a backup (skill devflow:ship).',
  });

  if (guard.blockBranchMoves) {
    rules.push({
      re: new RegExp(`git\\s[^|;&\\\\n]*(update-ref\\s+(refs/heads/)?${BRANCHES}|branch\\s+(-f|--force|-M|-D)\\s+${BRANCHES})(\\s|$)`, ''),
      msg: `${dev}/${main} only move by fast-forward via land / promote (skill devflow:ship).`,
    });
    // checkout -B / switch -C recreate the branch at another commit — same as moving it.
    rules.push({
      re: new RegExp(`${SEG}git(\\.exe)?\\s+(checkout\\s+(-B|--orphan)|switch\\s+(-C|--orphan))\\s+${BRANCHES}(\\s|$)`, 'm'),
      msg: `${dev}/${main} only move by fast-forward via land / promote — do not recreate them with checkout -B / switch -C (skill devflow:ship).`,
    });
    // A hand-typed merge onto a protected branch creates a merge commit; the flow only
    // fast-forwards. (flow.mjs itself runs `merge --ff-only` via child_process, which this
    // hook never sees, so blocking the bare command is safe.)
    rules.push({
      re: new RegExp(`${SEG}git(\\.exe)?(\\s+-[^\\s]+(\\s+[^\\-\\s][^\\s]*)?)*\\s+merge(\\s|$)`, 'm'),
      // github mode: a pushed task branch is updated by merging the base into it (no rebase + force push);
      // merging INTO a protected branch is still the PR's job.
      when: github ? () => current === dev || current === main : undefined,
      msg: github ? `no git merge on ${current}: it only moves by a merged pull request (github mode).` : `no hand-typed git merge: task branches reach ${dev} through land (gate + fast-forward), ${dev} reaches ${main} through promote (skill devflow:ship).`,
    });
    // reset --hard while ON a protected branch (or naming one) would rewrite its history.
    rules.push({
      re: new RegExp(`${SEG}git(\\.exe)?\\s+reset\\s+--hard(\\s+${BRANCHES})?(\\s|$)`, 'm'),
      when: cmd => current === dev || current === main || new RegExp(`reset\\s+--hard\\s+${BRANCHES}(\\s|$)`).test(cmd),
      msg: current === dev || current === main
        ? `git reset --hard on ${current} would rewrite its history — ${dev}/${main} only move by fast-forward via land / promote.`
        : `git reset --hard naming ${dev}/${main} would rewrite their history — they only move by fast-forward via land / promote.`,
    });
  }

  if (guard.blockDestructiveSql) rules.push({
    re: /\b(mysql|mariadb|psql|sqlite3|sqlcmd|mongosh)\b[^|;&\n]*\b(drop\s+(table|database|schema|collection)|truncate\s|delete\s+from|alter\s+table|update\s+[a-z_."`]+\s+set|\.drop\(|\.deleteMany\()/i,
    msg: 'destructive SQL from the shell is not allowed. Write a reviewed migration / data tool with a dry-run and ask the user.',
  });

  // Always on: recursive delete of / or home.
  rules.push({
    re: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)|Remove-Item\s[^|;&\n]*-Recurse[^|;&\n]*\s(C:\\|\$HOME|~)(\s|$)/i,
    msg: 'recursive delete of / or home is not allowed.',
  });

  return rules;
}

/** Return the block message for `cmd`, or null when the command is allowed. */
export function checkCommand(cmd, ctx) {
  for (const r of buildRules(ctx)) {
    if (r.when && !r.when(cmd)) continue;
    if (!r.re.test(cmd)) continue;
    if (r.check) {
      const m = r.check(cmd);
      if (m) return m;
      continue;
    }
    return r.msg;
  }
  return null;
}
