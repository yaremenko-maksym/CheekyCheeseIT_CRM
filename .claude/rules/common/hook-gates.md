---
paths:
  - '.claude/hooks/**'
  - '.claude/settings*.json'
  - 'scripts/devops/tests/**'
  - 'scripts/devops/check-guard-tests-exist.sh'
---

# Rule: hook gates — internals of the always-on gates

**Status:** Path-scoped (loads when you read or edit a hook, the hook registration or a hook test)
**Applies to:** whoever edits or tests a hook (Architect), and anyone debugging a gate refusal

> Moved verbatim (2026-11-08) out of always-on rules, which keep the one-line behaviour of each gate
> and point here. Edit the behaviour line in the source rule and the detail here together.

---

## From `agent-isolation.md`

> Rationale references here mean `docs/architecture/rules-rationale/agent-isolation.md`.

### Checking the gates

```bash
bash .claude/hooks/tests/cross-agent-hooks-smoke.sh   # both sides: refusals and silence
```

Called from `scripts/devops/tests/test-pre-bash-cross-agent-blast.sh`, part of `run-guard-tests.sh` —
a step inside a **required** check. Each hook also has its own cases in `scripts/devops/tests/`,
because the meta-guard `check-guard-tests-exist.sh` reads the hook list from `.claude/settings.json`
and requires a negative case from every hook that can refuse.

The smoke test also requires, of a blocked case, the body `{"decision":"block"}` (rationale file).

### False positives

Both hooks decide by the **first token of a command segment**, not a substring: `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"` pass. `WORKTREE-OPAQUE` is the one exception that refuses by unverifiability; do not extend that pattern to ordinary mutators (rationale file).

## From `verification-integrity.md`

> Rationale references here mean `docs/architecture/rules-rationale/verification-integrity.md`.

### The mechanism: `pre:bash:swallowed-failure` (advisory)

Form 1 and the zsh trap are mechanised (evidence and counts: rationale file).

`pre:bash:swallowed-failure` prints one note and **never refuses**:

- **SWALLOWED-COUNT** — a named-object read (`git show` / `cat-file` / `log` / `diff`, `cat`, `head`,
  `tail`, `jq`) whose stderr is discarded, piped into a counter (`grep -c`/`-q`, `wc -l`/`-w`/`-c`).
- **ZSH-REVSPEC** — an unbraced `$VAR:` in such a read, reported with or without a discard.

It is advisory by decision: service probes (`curl`, `nc`, `ssh-keyscan`, `pg_isready`) are deliberately not readers, because their producer is expected to fail. Form 2, form 3 and the shape inside an authored script are **not** covered.

## From `git-policy.md`

> Rationale references here mean `docs/architecture/rules-rationale/git-policy.md`.

### Pre-push AC gate

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-coder-push-gate.sh` (id
`pre:bash:coder-push-gate`) blocks `git push` if the last commit **on any branch** does not contain an
`ac_verified:` line. Do not bypass — finish the AC.

**The gate closes everything but three exceptions:** `main` / `master` (not a work branch), and
`architect/*` and `legal/*` (their tasks have no AC list in the task file). The cost of each exception
is spelled out in the hook's header — read it **before** adding a fourth.

A branch that honestly has nothing to verify (screenshots, notes) has two answers, both an assertion
rather than a bypass: `wip:` in the commit subject, or `ac_verified: n/a (<why>)`.

Test: `scripts/devops/tests/test-pre-bash-coder-push-gate.sh` (28 cases, by execution).

### Prettier pre-push gate (catch formatting BEFORE push)

Claude PreToolUse:Bash hook `.claude/hooks/pre-bash-prettier-gate.sh` (id `pre:bash:prettier-gate`)
blocks `git push` if the files changed vs `origin/main` (`ts/tsx/js/jsx/json/md/yml`) did not pass
`prettier --check` — a local mirror of the CI gate `check-no-skip-hooks.yml`.

It resolves prettier worktree-safe (local `.bin` → MAIN-repo `.bin` via git-common-dir → `pnpm exec`);
if prettier is unreachable — **fail-loud BLOCK** with the instruction `pnpm install`, not a silent
skip. On a block it prints the exact fix command `prettier --write <files>`.
