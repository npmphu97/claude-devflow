// devflow guard rules — pure functions, no I/O, so they can be unit-tested
// (see scripts/devflow/devflow.test.mjs). The PreToolUse hook (guard-bash.mjs) builds the
// context from .devflow.json and calls checkCommand.
//
// A "protected" branch is the integration or release branch: it only moves by fast-forward
// through scripts/devflow/flow.mjs (land / promote). Everything else that would move it,
// merge into it, or rewrite it is blocked.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the rule list for a repo. ctx: { dev, main, current, guard }. */
export function buildRules({ dev, main, current, guard }) {
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

  if (guard.blockManualPush) rules.push({
    re: new RegExp(`${SEG}git(\\.exe)?(\\s+-[^\\s]+(\\s+[^\\-\\s][^\\s]*)?)*\\s+push(\\s|$)`, 'm'),
    msg: `manual git push is not allowed: land / promote / backup push the integration and release branches and tags; task branches stay local (skill devflow:ship). In a cloud session (branch ccr-*) use cloud-push.`,
  });

  if (guard.blockGhPr) rules.push({
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
      msg: `no hand-typed git merge: task branches reach ${dev} through land (gate + fast-forward), ${dev} reaches ${main} through promote (skill devflow:ship).`,
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
    if (r.re.test(cmd)) return r.msg;
  }
  return null;
}
