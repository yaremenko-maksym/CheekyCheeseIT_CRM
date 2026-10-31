# Rule: Agent isolation — each agent has its own workspace

**Status:** Always-on (2 hooks + report lines; see "How we know it is violated")
**Applies to:** all agents and everyone who dispatches agents (Master / orchestrator)

> Rationale: `docs/architecture/rules-rationale/agent-isolation.md`

---

## One cause

> **An agent's session directory is derived from the agent's own identifier and is never inherited
> from the orchestrator.**

The harness resets an agent's working directory to its session directory between Bash calls, so a `cd` is not retained; harmless unless that directory is shared.

In practice: a write-agent gets `isolation="worktree"`; a reviewer gets its own checkout in its own
scratchpad, and only when it really needs one.

## What the harness already covers

It refuses `git -C <foreign path>` and `cd <foreign> && git ...` for isolated agents only. It does **not** stop `cd <foreign worktree> && ls`, `git worktree remove <foreign worktree>`, or `pkill -f <pattern>`; `pre:bash:cross-agent-blast` closes those three. (Command-by-command table: rationale file.)

## Rules

### 1. Dispatch: a write-agent — always with its own directory

`coder`, `autotest`, `devops`, `ui-ux-designer`, `manual-qa`, `legal`, `pm`, `architect` are
dispatched **only** with `isolation="worktree"` (or an explicit `cwd=`, if a specific existing
directory is needed — the parameters are mutually exclusive).

An error here is the **dispatcher's** error, not the agent's.

### 2. A read-only agent is NOT forced a worktree

`code-reviewer`, `security-reviewer`, `copy-reviewer`, `Explore`, `Plan`, the `codebase-audit`
fan-out do **not** require isolation and should not pay for an extra worktree: they read the diff via
`gh pr diff` / GitHub MCP, not via a local tree. The gate passes them silently.

**But:** as soon as a reviewer needs to **run or roll back** something (a redness check, a
measurement, a reproduction), it needs **its own** checkout — see rule 4.

### 3. A shared working directory is not issued in the prompt

The working directory path is **never** set by the orchestrator as an absolute path of the form
`/tmp/rev<PR>`: the PR number is the same for all reviewers of that PR, so such a path is shared by
construction.

The path is derived from the **agent's own** identifier: its worktree (`git rev-parse
--show-toplevel`) or its session-scratchpad, which the harness issues to each agent personally.

### 4. A foreign tree is not mutated. Ever

A redness check requires mutation — so it is done in **your own** checkout:

```bash
echo "$SCRATCH"                                                  # expand it once
git worktree add --detach /abs/scratch/co-pr<N> <sha of the real PR commit>
```

Use a **literal** path and a name of your own (`co-pr1024`, not `checkout` — siblings use that too), in your own checkout, never in another agent's tree or a shared one.

### 5. Processes — only your own, by PID

`pkill -f` / `killall` hit by pattern and extinguish any agent's processes. Your own processes are
killed by PID: `lsof -ti tcp:<your port>` → `kill <PID>`. A deliberate mass sweep is the owner's
prerogative, not the task's.

### 6. A foreign worktree is not removed

An agent does not see other agents and **cannot reasonably judge** whether a foreign worktree is
abandoned. Your own — remove it, a foreign one — report to the orchestrator.

**The scratchpad is SHARED with sibling agents**, so a scratch path proves nothing about ownership. The hook records `<agent_id> <path>` when you create a worktree at a path that is literal, absolute, below the scratchpad root, and not already there, and permits removing only what is recorded against you (`WORKTREE-UNRECORDED` otherwise). Expand the variable once and use the literal for both steps:

```bash
echo "$SCRATCH"                                          # once, to get the literal
git worktree add --detach /abs/scratch/co-pr1024 <sha>   # recorded as yours
git worktree remove --force /abs/scratch/co-pr1024       # permitted
```

Remove your own tree by an explicit path, never a variable (`WORKTREE-OPAQUE`); batch cleanup — expand, then remove one by one. A sibling's checkout, a path made through an unexpanded variable, and a re-dispatched instance of yourself stay refused.

### 7. The worktree vanished — stop and report

An agent that discovers its worktree is gone (or that `git rev-parse --show-toplevel` does not match
the issued path) **must stop and report**, not continue in the directory it was thrown into.

### 8. Reconciliation before the first edit (a mandatory step)

The first command in any write-agent's session:

```bash
git rev-parse --show-toplevel     # must match the issued worktree
```

No match → rule 7 (stop + report). The environment's self-representation cannot be trusted: trust
only a fact obtained by a command.

## How we know it is violated (a mandatory answer for every rule)

A rule without observability is not a rule. For each one above:

- 1, 3 — `pre:agent:dispatch-isolation` (matcher `Agent|Task`) refuses at dispatch, including an absolute `/tmp/rev<PR>` path in the prompt. Duplicate layer: Master checks `git status --porcelain` of the main checkout after EACH agent; a `Checkout:` line in a reviewer's report (two identical paths = a collision).
- 2 — the same hook passes read-only types silently (smoke-test case).
- 4 — `pre:bash:cross-agent-blast`, predicate `FOREIGN-WORKTREE`.
- 5 — same hook, `BROADCAST-KILL`.
- 6 — same hook, `WORKTREE-REMOVE` / `WORKTREE-PRUNE` / `WORKTREE-OPAQUE` (path not literal, ownership unverifiable) / `WORKTREE-UNRECORDED` (in the shared scratchpad, no record ties it to you).
- 7, 8 — no mechanic: the report line below. No line = the reconciliation was not done; Master returns the agent.

**The report line (mandatory for write-agents and for reviewers that made a checkout):**

```
Worktree: /abs/path (verified: toplevel == dispatched path)
```

No line → Master returns the agent for rework, as for a missing verdict. It is the only thing that
makes rules 7 and 8 observable: the harness gives no hook for "an agent reads the wrong directory".

## Checking the gates

```bash
bash .claude/hooks/tests/cross-agent-hooks-smoke.sh   # both sides: refusals and silence
```

Called from `scripts/devops/tests/test-pre-bash-cross-agent-blast.sh`, part of `run-guard-tests.sh` —
a step inside a **required** check. Each hook also has its own cases in `scripts/devops/tests/`,
because the meta-guard `check-guard-tests-exist.sh` reads the hook list from `.claude/settings.json`
and requires a negative case from every hook that can refuse.

The smoke test also requires, of a blocked case, the body `{"decision":"block"}` (rationale file).

## False positives

Both hooks decide by the **first token of a command segment**, not a substring: `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"` pass. `WORKTREE-OPAQUE` is the one exception that refuses by unverifiability; do not extend that pattern to ordinary mutators (rationale file).

## Related rules

- `.claude/rules/common/zone-of-write.md` — which paths are whose (this file — about **which tree**).
- `.claude/rules/common/review-findings-transfer.md` — transferring review findings (the same family: a channel without a gate).
- `.claude/rules/common/light-track.md` — concurrency ceiling, sweep of zombie dev servers.
- `.claude/skills/code-review-discipline/SKILL.md` §6 — the reviewer's own checkout.
- `.claude/agents/contracts.md` — Master-direct-dispatch contracts (dispatch with isolation).
