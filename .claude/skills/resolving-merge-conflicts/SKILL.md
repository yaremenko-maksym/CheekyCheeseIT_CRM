---
name: resolving-merge-conflicts
description: 'Resolving conflicts of an in-progress merge/rebase by the INTENT of each side, traced to the primary source (commit, PR, task), not by picking lines. Hunk by hunk, preserving both intents where possible; incompatible ones — in favor of the stated goal of the merge, with the compromise recorded. Never --abort: the operation is always carried to the end.'
when_to_use: "Use when a merge or rebase is already in conflict, or a stacked PR needs rebasing onto a squashed base. Examples: 'conflict during rebase', 'CONFLICT (content)', 'the base collapsed into a squash, the stack fell off', 'which side to take', 'git status shows unmerged paths'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__github__get_pull_request
  - mcp__github__list_commits
  - mcp__ast-grep__find_code
---

# Merge conflicts — by intent, not by lines

A conflict is a typical point where an agent without a rule calls a human. With a rule it does not call: the choice
of side is almost always derived from primary sources, not from taste.

**Never `--abort`.** Aborting throws away the resolution work already done and returns you to
the same state ten minutes later. The operation is carried to the end.

## 1. Understand where you are

```bash
git status                       # merge or rebase, which paths are unmerged
git log --oneline --graph -15
git diff --name-only --diff-filter=U
```

For rebase additionally: which commit is being applied now (`git rebase --show-current-patch
--stat`) and how many remain. Resolving a rebase is resolving a **series**, and the same place
can conflict several times.

**Stacked PRs.** If the base collapsed into a squash, "our" commits look like someone else's. Do not resolve
by hand — reapply: `git rebase --onto origin/main <old-base> <branch>`. Half the conflicts
disappear because they never existed.

## 2. Find the primary source of each side

**This is the step the skill exists for.** Resolving by looking only at the two versions of the text is
guessing.

For each conflicting hunk:

```bash
git log -L <start>,<end>:<file> <side>      # the history of exactly these lines
git log --format='%h %s' <base>..<side> -- <file>
```

Then — up the chain to the **intent**: the commit message → the PR (`gh pr list --search <sha>`,
the body and the review findings) → the task file or the issue the PR references. You are seeking the answer to the question
**"why this line was written"**, not "what it does".

The intent is found neither in the commit, nor in the PR, nor in the task → this is an A2 question to the owner
(`autonomy-levels.md`), but **first** resolve all the hunks where the intent was found.

## 3. Resolve the hunk

In order:

1. **Both intents are compatible** — preserve both. Most often this is the case, and the textual conflict
   is accidental: two sides edited adjacent lines for different reasons.
2. **Incompatible** — the one that serves the **stated goal of the merge** wins (what we are merging and
   why). The losing intent is recorded as a compromise in the merge commit message.
3. **Never invent a third behavior.** Resolving a conflict is not a place for refactoring and
   not a place for "while we're at it". New behavior = scope creep, and `spec-reviewer` will flag it.

Special cases of our repository:

- **`routeTree.gen.ts`** — generated and in gitignore. There should be no conflict; if there is,
  someone committed the file — do not resolve, remove it from the index.
- **Drizzle migrations** — two new migrations with the same number conflict semantically, not
  textually. Renumber the later one, verify that it applies on top of the first.
- **`pnpm-lock.yaml`** — do not resolve by hand. Take the base side and regenerate
  `pnpm install --frozen-lockfile=false`, then check that the versions from `version-pins.md` have not moved.

## 4. Run the project checks

After resolving all hunks, before completing the operation:

```bash
pnpm typecheck
pnpm --filter @crm/api test    # and/or the affected packages
node_modules/.bin/prettier --check <changed files>
```

A merge breaks things that did not conflict textually: a signature renamed on one
side, and a new call added on the other. Types catch this, diffs do not.

## 5. Complete the operation

```bash
git add <explicit list of files>  # never git add . (git-policy)
git merge --continue              # or git rebase --continue to the end of the series
```

In the merge commit message — **a line about whose intent won and why**:

```
merge: <branch> into <branch>

Conflict in <file>: both sides changed <what>. Took the intent of <side>
(<primary source: PR #N / task-<slug>>), because <goal of the merge>.
The intent of <the other side> preserved as <how exactly> / deferred to <where>.
```

This is the observability of the rule: a merge commit without such a line is a resolution by lines, not
by intent.

## Related

- `.claude/rules/common/git-policy.md` — explicit `git add`, ban on `--no-verify`, force-with-lease.
- `.claude/rules/common/version-pins.md` — what to check after regenerating the lock file.
- `.claude/rules/common/autonomy-levels.md` — an unfound intent as an A2 question.
