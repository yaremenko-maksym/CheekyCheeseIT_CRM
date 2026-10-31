# Rule: Git policy — commit hygiene & forbidden patterns

**Status:** Always-on
**Applies to:** All write-agents (Coder, AutoTest, DevOps), with applicable subset for Master / Architect / Reviewer when they touch git.

> Rationale: `docs/architecture/rules-rationale/git-policy.md`

---

## Zero-tolerance patterns — the target action first, the prohibition second

| Do it this way                                                     | Not this way                                                | Why                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finish the AC → an honest commit with `ac_verified:`               | `git push --no-verify`                                      | Bypasses the pre-push hook that checks `ac_verified:`. Real incidents 2026-06-02: 3× in a session.                                                 |
| Same                                                               | `git commit -n` / `git commit --no-verify`                  | Same.                                                                                                                                              |
| Same                                                               | `git -c core.hooksPath=/dev/null` (any form of hook bypass) | Same.                                                                                                                                              |
| Ask USER                                                           | `--no-gpg-sign` without an explicit USER request            | Bypasses signing.                                                                                                                                  |
| List the files explicitly from the task section "Concrete changes" | `git add .` / `git add -A` / `git add *` / `git add apps/`  | Sweeps up someone else's debug artifacts from the worktree (PR #22 round4 incident, see `.claude/agents/memory/coder/lessons.md` 2026-05-20 [P0]). |
| PR + label `merge-approved` → CI auto-merge                        | Push to `main` directly                                     | Branch protection — only via a PR.                                                                                                                 |
| On your own branches `--force-with-lease`                          | `git push --force` to `main` / `master`                     | Destroys history.                                                                                                                                  |
| `git stash` → restore                                              | `git reset --hard origin/main` without a warning            | Destroys local work.                                                                                                                               |
| Wait for green checks → squash via the label `merge-approved`      | `gh pr merge --admin`                                       | Bypasses branch protection (required checks).                                                                                                      |

CI hard block: `.github/workflows/check-no-skip-hooks.yml` fails on a PR if the string `--no-verify`
appears in the diff. The reviewer issues `Verdict: BLOCK`. `merge-approved` is set only by
Master/owner — and only on the owner's explicit "merge".

## Commit message format

```
<type>(<scope>): <subject>

<optional body>

ac_verified: 1,2,3,4,5        # AC numbers from the task file, comma-separated
vision: ✓ /team, /team/$teamId    # ONLY for UI tasks — affected routes
```

- If all AC are done — list all numbers: `ac_verified: 1,2,3,4,5`
- If some are not done — list the done ones + a comment: `ac_verified: 1,2,4 (3,5 — blocked, see .blocked.md)`
- If the task has no UI — omit the `vision:` line, `ac_verified:` is mandatory.

## Pre-push AC gate

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-coder-push-gate.sh` (id
`pre:bash:coder-push-gate`) blocks `git push` if the last commit **on any branch** does not contain an
`ac_verified:` line. Do not bypass — finish the AC.

**The gate closes everything but three exceptions:** `main` / `master` (not a work branch), and
`architect/*` and `legal/*` (their tasks have no AC list in the task file). The cost of each exception
is spelled out in the hook's header — read it **before** adding a fourth.

A branch that honestly has nothing to verify (screenshots, notes) has two answers, both an assertion
rather than a bypass: `wip:` in the commit subject, or `ac_verified: n/a (<why>)`.

## Prettier pre-push gate (catch formatting BEFORE push)

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-prettier-gate.sh` (id `pre:bash:prettier-gate`)
blocks `git push` if the files changed vs `origin/main` (`ts/tsx/js/jsx/json/md/yml`) did not pass
`prettier --check` — a local mirror of the CI gate `check-no-skip-hooks.yml`.

It resolves prettier worktree-safe (local `.bin` → MAIN-repo `.bin` via git-common-dir → `pnpm exec`);
if prettier is unreachable — **fail-loud BLOCK** with the instruction `pnpm install`, not a silent
skip. On a block it prints the exact fix command `prettier --write <files>`.

## WIP commits & chunking

The `wip:` prefix is a marker of incompleteness. The pre-push hook does NOT require `ac_verified:` on
`wip:` commits (only on the final one).

- **`wip:` push after every 2 files** OR
- **`wip:` push after every 5 minutes** OR
- **`wip:` push before any operation > 1 min** (build, tests, migration)

The final commit — without `wip:`, with `ac_verified:`.

## Pushing feature branches: `DATABASE_URL=` empty (data-safety)

ALWAYS push local feature branches as `DATABASE_URL= git push` (the variable empty). The pre-push hook runs tests; an empty `DATABASE_URL` makes integration specs graceful-skip, so the push never touches the live `crm_db`.

## Conventional commits scopes (for the project)

**Type** — from the Conventional Commits set (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
`perf`, `ci`, `style`, `build`) plus two of ours: `wip` (see the section above — a marker of
incompleteness, freeing from `ac_verified:`) and `infra` (changes to environment and plumbing that do
not land in the product).

**Scope** — the area the commit touches: a package (`api`, `web`, `shared`, `e2e`, `landing`), a
domain area (`finance`, `documents`, `auth`, `projects`, `teams`, `contracts`) or an infrastructure
zone (`infra`, `deploy`, `ci`, `hooks`, `agents`). The list is **not closed** — take what describes
the area more precisely.

The commit message body is in English, as is all agent output
(`.claude/rules/common/russian-language.md`).

## Related rules

- `.claude/rules/common/zone-of-write.md` — which agent may write which paths (the reviewer issues BLOCK on violations).
- `.claude/rules/common/russian-language.md` — English in repo + agent output, commits English; Russian only in the owner chat.
