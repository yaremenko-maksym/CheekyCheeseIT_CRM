# ADR: Mechanics for keeping agents apart in a shared environment

**Date:** 2026-08-17
**Author:** Architect (dispatch)
**Backlog items:** 27, 36, 45, 72, 75, 85, 100 (+ 97 as a fact about the environment)

## Status

Proposed — awaits review and the owner's explicit "merge it".

---

## Context

Over two sessions **seven** cases of agent collision and **two** cases
where the environment's self-representation lied have accumulated. Each has already cost either a spoiled
measurement, or a lost finding, or an agent's turn.

| #   | Date / PR    | What happened                                                                                                        |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 27  | 08-07 / #493 | Two reviewers in a **shared directory**; a foreign mutation appeared in the tree in the middle of a measurement      |
| 36  | 08-08 / #497 | A writing coder **without isolation** switched the orchestrator's directory to `feature/resume-base`                 |
| 45  | 08-11 / #504 | When transferring review findings to the task **a security finding was lost** (a glyph-check bypass)                 |
| 72  | 08-17 / #547 | `pkill -f "apps/api/dist/main"` killed the dev-API of a **parallel coder**                                           |
| 75  | 08-17 / #544 | A coder deleted a **reviewer's** worktree; the reviewer started working in the shared checkout and detached its HEAD |
| 85  | / #545, #551 | Agents share one scratch DB `crm_qa`; foreign data is read as an edit defect                                         |
| 100 | 08-17 / #551 | A reviewer **rolled back a file in the live worktree of a working coder** for the sake of a redness check            |
| 97  | 08-17        | The harness reported to an agent a worktree path **that does not exist on disk**, and reading by it returned content |
| —   | 07-xx / #545 | The turbo cache returned a green result from a foreign tree                                                          |

Common to all: **agents live in a shared environment, and there are no mechanics keeping them apart.**
Fixing one case at a time means fixing seven times — and getting seven gates, each
with its own false-positive profile.

---

## Decision

### D0. A common cure instead of seven pinpoint ones (confidence: HIGH)

The breakdown showed that six of the seven cases are **consequences of one cause**:

> An agent works in a directory that does not belong to it, because its working
> directory was **not issued** to it — it **inherited** it from the orchestrator.

The second half of the mechanism is not an error but a property of the environment:
**the working directory is reset to the session directory between Bash calls.**

Verified by a run (2026-08-17, from an isolated agent):

```
$ cd /Users/.../worktrees/agent-a19187064c6215514 && pwd && ls | head -3
/Users/.../worktrees/agent-a19187064c6215514     ← cd within one call works
AGENTS.md ...

$ pwd                                            ← the NEXT call
/Users/.../worktrees/agent-a8f3d9397eb798ac3     ← returned to its own
```

The harness says this in plain text in the subagent's system prompt too:
_"Agent threads always have their cwd reset between bash calls"_.

**Key conclusion: the cwd reset is harmless in itself.** It is harmful exactly when
the session directory is **shared**. Then a `cd` to a safe place is not held, and the agent
on each next call returns to a foreign tree — exactly the #551 scenario.

Hence the common cure:

> **An agent's session directory is derived from the identifier of the agent itself and is never
> inherited from the orchestrator.**

It closes 27 (the shared reviewer directory), 36 (the coder in the orchestrator's directory),
the 75-consequence (the reviewer thrown into the shared checkout), 100 (the reviewer in a foreign tree)
and devalues 97 (verify by fact instead of trusting the self-representation). Separate
mechanics are required only by 72 (processes are not files), the 75-cause (the deletion of a foreign worktree)
and 85 (the shared DB).

Recorded: `.claude/rules/common/agent-isolation.md`.

### D1. What the harness already does — and where its holes are (confidence: HIGH, verified by a run)

Before writing a hook, it was verified what the harness does itself. It **already** contains
worktree-containment for isolated agents — and this discovery changed the design:

| Probe (from an isolated agent)                  | Result                     |
| ----------------------------------------------- | -------------------------- |
| `git -C <main checkout> status --porcelain`     | **harness refusal**        |
| `git -C <foreign worktree> status --porcelain`  | **harness refusal**        |
| `cd <foreign worktree> && git rev-parse ...`    | **harness refusal**        |
| `cd <foreign worktree> && pwd && ls \| head -3` | **executed** — a hole      |
| `git worktree remove <foreign path>`            | **executed** (a git error) |
| `pkill -f <pattern>`                            | **executed**               |

The refusal text: _"This agent is isolated in the worktree …, but this command
redirects git to the shared checkout via -C. Refusing to run it"_.

**Conclusion:** the built-in protection is (a) only **git-specific**, (b) only for
**isolated** agents. A non-isolated agent (#497, #551) is not protected by anything,
and file and process operations are not covered at all. Our hooks close exactly
these holes and do **not** duplicate what the harness already does.

As a side note, the false-positive profile of the harness itself is fixed: it refuses
even on a harmless `comm -12 a <(sort b)` (there is no git in the command at all) with the wording
"too complex to verify". This is the price of its conservatism, and it confirms that
one's own gates must be built on a parse of the command, not on "looks complex".

### D2. The hook `pre:bash:cross-agent-blast` (confidence: HIGH, verified by a run)

`.claude/hooks/pre-bash-cross-agent-blast.sh`, PreToolUse matcher `Bash`.
Fires **only** in an agent context (cwd inside `.claude/worktrees/**`
or a claude-scratchpad, or a non-empty `agent_id`); the owner's session is not touched.

Predicates:

| Code               | What it blocks                                                      | Incident   |
| ------------------ | ------------------------------------------------------------------- | ---------- |
| `BROADCAST-KILL`   | `pkill` / `killall` in the command position                         | #547       |
| `WORKTREE-REMOVE`  | `git worktree remove <path>`, where the path is **not my** worktree | #544       |
| `WORKTREE-PRUNE`   | `git worktree prune` (de-registers **foreign** live ones)           | #544       |
| `FOREIGN-WORKTREE` | a mutating command referencing `.claude/worktrees/<not-mine>`       | #551, #493 |
| `SHARED-CHECKOUT`  | a mutation of the shared checkout by an absolute path               | FM-2       |

**How false positives are avoided.** The decision is made by the **first token
of the command segment** (segments are split by `;`, `&&`, `||`, `|`, a newline), not
by a substring of the whole string. Therefore the following pass:

- `grep -rn "pkill" .claude/hooks/` and `echo "do not run pkill"` — the word in
  an **argument**, not a command;
- `pgrep -f 'worktrees[/]agent-' | xargs kill -9` — the owner's documented sweep
  (`light-track.md`);
- `kill <PID>` / `kill -TERM <PID>` — the prescribed replacement;
- reading a foreign tree (`cat`, `grep`, `git log`) — only a mutation is gated;
- deleting **one's own** worktree.

This is a deliberate difference from the neighboring `pre:bash:safety`, which greps the raw
string and therefore blocks an ordinary `echo` mentioning `DROP DATABASE crm_db`
(reproduced 2026-08-17 while working on this task). Such firings are what
develop the reflex to bypass the gate — backlog 63, `live-db-guard` against `grep`.

### D3. The hook `pre:agent:dispatch-isolation` (confidence: MED — see "not verified")

`.claude/hooks/pre-agent-dispatch-isolation.sh`, PreToolUse matcher `Agent|Task`.
Refuses if a subagent from the list of **writing** ones (`coder`, `autotest`, `devops`,
`ui-ux-designer`, `manual-qa`, `legal`, `pm`, `architect`) is dispatched **without**
`isolation` and **without** `cwd`; plus refuses if a shared working directory is specified
in the prompt by an absolute path of the form `/tmp/rev<PR>` (item 27).

**The mechanics' feasibility (AC4) — established by a fact, not by reasoning:**

1. PreToolUse is dispatched **generically by the tool name**: in the Claude
   Code source `services/tools/toolExecution.ts` calls `runPreToolUseHooks()` for
   any tool, which calls `executePreToolHooks(tool.name, …)` with
   `matchQuery = tool.name` and `tool_input` = the parsed tool input.
   There is no tool allow-list, that is, `Agent` is included.
2. The tool is called `Agent`, the alias `Task` is kept **precisely for the sake of hooks**:
   `// Legacy wire name for backward compat (permission rules, hooks, resumed
sessions)` — `tools/AgentTool/constants.ts`. `matchesPattern()` normalizes
   legacy names, so the matcher `Agent|Task` covers both.
3. `isolation` and `cwd` are real optional fields of the Agent-tool input schema
   (`tools/AgentTool/AgentTool.tsx`), next to `subagent_type`; so they come
   inside `tool_input` and are readable by the hook.
4. **Project hooks do fire on subagent calls in this runtime** — verified by a run: from a subagent an `echo` was executed containing
   the string `DROP DATABASE crm_db`, and a refusal `pre:bash:safety` was received.

**What is NOT verified and why (honestly):** a subagent cannot itself dispatch
`Agent`, so the author of this ADR could not perform a real Agent-tool call and
see the hook block it. Items 1–3 are taken from the leaked source snapshot,
which is **older** than the running application: the line of the live worktree-guard
(D1) is **absent** from the snapshot. Therefore:

> The hook is a **belt**, and the report line (D4) are the **suspenders**. The AC5 item requires exactly this
> pair, not a bet on one of the two layers.

**Read-only agents are not forced into isolation (AC6).** `code-reviewer`,
`security-reviewer`, `copy-reviewer`, `Explore`, `Plan`, the `codebase-audit` fan-out
pass the gate silently — a worktree costs disk operations, and the diff is read via
`gh` / GitHub MCP. Unknown subagent types also pass: **default-allow**,
because the unknown is not evidence, and a gate firing on surprises teaches
itself to be bypassed.

### D4. Observability where there is no mechanics (confidence: HIGH)

The requirement "do not add rules whose execution cannot be observed" gave three
places where mechanics are impossible, and for each — a way to make a violation visible
**in the report**, not in the consequences:

| Rule                                           | Why there is no mechanics                                                                                    | Observability                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Verify `--show-toplevel` before the first edit | The Bash hook does not know which path was issued to the agent at dispatch                                   | The line `Worktree: <path> (verified)` in the report; none → back for rework |
| Stop if the worktree disappeared               | Only the agent itself sees the disappearance; the hook cannot distinguish "disappeared" from "never entered" | The same line + an explicit "stop and report" in the rule                    |
| Do not work in a shared measurement directory  | The directory is not issued to the reviewer, it creates it                                                   | The line `Checkout: <path> @ <sha> (clean)` in the review body               |

Two identical `Checkout:` lines from two reviewers of one PR = a directory collision,
visible to PM in the aggregate. This is the replacement for the impossible hook.

### D5. Transfer of review findings (item 45; confidence: HIGH)

Rule: `.claude/rules/common/review-findings-transfer.md`. The reviewer numbers
the findings (`CR-H-1`, `SR-M-2`, …) **at the moment of writing the review** and closes the body
with the control line `Findings: … (N)`; the orchestrator transfers the **whole** list,
including what is decided not to do; the executor reports **on each**
identifier, including "did not do, because…".

**The mechanical check (AC9) — the decision is made explicitly: a CI gate is NOT introduced.** Reasons:
(1) there is nothing to compare with what — the executor's report lives in the chat and the PR body, the review in
GitHub, CI sees only the PR; (2) the gate would catch formatting, not the loss —
a reviewer who forgot the `Findings:` line reddens the PR, while the orchestrator who lost a finding
and rewrote the line does not; this is a negative sample, exactly the class of checks
we have been cleaning out all month; (3) the cheap part gives almost the whole effect —
the control line turns the reconciliation into a comparison of two numbers. The revision condition is
recorded in the rule.

### D6. Sweep of stale worktrees (item 75 / AC14; confidence: HIGH on data, MED on timing)

**Measurement as of 2026-08-17:** 44 worktrees, 37 with branches. Of them:

- **20** correspond to branches with an **already-merged PR** — candidates for cleanup;
- **17** branches have no remote at all (`no-remote`) — that is, they contain **only
  local, unpushed** commits;
- **2** have 1 unsent commit each over the remote;
- **1** is locked (`locked`) — my own.

Two conclusions, both counterintuitive and both mandatory for any future script:

1. **The ancestor test does not work.** We merge by squash, so a branch's commits do not
   become ancestors of `main`: `git merge-base --is-ancestor` returned "not merged"
   for **all** branches, including long-merged ones. A naive sweep by ancestry either
   deletes nothing, or (if inverted) deletes everything. A reliable sign is
   only the PR state via `gh pr list --state merged --head <branch>`.
2. **"A merged PR" ≠ "the worktree is abandoned".** The list of 20 included
   `claude/cheekycheeseit-crm-backlog-6e44ec` — this is the worktree of the **live
   orchestrator** of this very session. And it is **not locked**: exactly one worktree is locked
   across the whole repository (mine). That is, **there is no reliable "alive" flag** —
   that is exactly why the coder in #544 erred, and exactly why such a decision
   must not be made by an agent in principle.

**Decision:**

- **Agents do not clean up worktrees at all** — neither foreign ones nor "clearly stale" ones.
  One's own — can (and should) be deleted after oneself; a foreign one — only report to the orchestrator.
  This is already enforced by `pre:bash:cross-agent-blast` (`WORKTREE-REMOVE` / `PRUNE`).
- **The owner cleans up**, by a script, modeled on `scripts/devops/reap-zombie-devservers.sh`
  (dry-run by default, launchd optional). The script lives in `scripts/devops/**`
  — **this is the DevOps zone, not Architect**, so here it is specified, not
  written. A separate DevOps task.
- **Mandatory conditions — a worktree is cleaned up only if ALL is satisfied:**
  1. the branch's PR is in the `merged` state (via `gh`, not via ancestry);
  2. the working tree is clean (`status --porcelain` empty);
  3. there are no commits missing from the remote (`rev-list --count origin/<b>..<b>` = 0;
     a branch without a remote is **not** a candidate);
  4. the worktree is not locked and is not the current one;
  5. there is no process whose path points inside this worktree (`pgrep -f <path>`);
  6. the directory mtime age > 24 h.
- The default is `DRY_RUN=1`, outputting a list of candidates; the real deletion — by an explicit flag.

### D7. The shared scratch DB (item 85 / AC15; confidence: MED)

**Assessment of "a DB per agent".** The cost: `createdb` + `drizzle-kit push` + `db:seed` on
each run — this is tens of seconds per run against today's "one failure out of
48". Plus garbage collection: an agent that died on a limit (today it happened twice)
will not delete the DB after itself, and we will get the same dump as with 44 worktrees, only in
Postgres. Plus `DATABASE_URL` will have to be computed in each dispatch prompt, rather than
taken from `.env` — that is, a new surface for the error we were just
closing with `live-db-guard`.

**Decision: we do NOT introduce a DB-per-agent now.** Instead — two cheap measures:

1. **A namespace in the fixtures — where the guard allows it.** The infrastructure
   is already half there: `assertNoForeignUnstampedRows()` and
   `assertNoForeignPathBRows()` filter by `TEST_OWN_USER_IDS`, that is, the spec already
   knows how to tell its own from foreign. It is enough to extend this technique (one's own
   prefix/owner on all inserted rows) to the new integration specs.
   This is exactly what was not done on #551, where the new case itself became a source of contamination.
2. **Serialization of specs that scan the whole table.** The guards above by
   construction read the whole table and are therefore incompatible with a parallel run
   of foreign fixtures. Such specs must go single-threaded
   (`describe.sequential` / a separate vitest project), rather than rely on luck.

**Revision condition:** if after (1)+(2) false failures from foreign data
recur, introduce a DB-per-agent with a name from the agent identifier
(`crm_qa_<agent-id>`) **together** with a reaper modeled on D6 — without the reaper this is
an exchange of one dump for another.

Adjacent: a green turbo-cache result from a foreign tree (#545) — the same family
(a shared cache over different trees). We do not introduce separate mechanics here, but when
measuring redness/greenness `--force` / a disabled cache is mandatory; recorded in
`code-review-discipline` §6 as part of the requirement "the tree == the reviewed commit".

---

## Consequences

**Pros.**

- Six cases are closed by one principle (D0), not by six gates.
- Two new gates are verified by a run on **both** sides — 33 cases, of which 21
  "must stay silent".
- False positives are minimized constructively (a parse by the first token), not
  by a promise.
- Where mechanics are impossible, a violation has become **visible in the report** (D4).
- It is explicitly fixed what the harness already can do (D1) — we do not duplicate or argue with it.

**Cons and risks.**

- `pre:agent:dispatch-isolation` is not verified end-to-end (D3). If the runtime does not
  dispatch PreToolUse on `Agent`, the gate silently does not fire — **hence the
  mandatory second layer** (the line in the dispatch + a cleanliness check of the main
  checkout after each agent). The very first real dispatch of a writing agent without
  isolation will show whether the hook works; this is worth checking deliberately.
- Two new always-on rules are context in each session. Both are deliberately
  short and reference each other rather than duplicate.
- D6 and D7 are decisions, not implementations: the sweep-script and the namespace-fixtures go off
  as separate tasks (DevOps / Coder), because they lie outside the Architect zone.

**What was left out deliberately.**

- Reading a foreign tree is not blocked (only a mutation) — blocking reading
  would mean catching a legitimate reconciliation and multiplying false positives.
- The worktree sweep is not automated in this PR (a foreign write zone).

---

## Rollback

Granularity — from one file to a full rollback.

```bash
# 1. Disable one hook, keeping the files (the most frequent case: false positives)
#    — remove the block with "id": "pre:bash:cross-agent-blast" (or "pre:agent:dispatch-isolation")
#    from .claude/settings.json.
git checkout origin/main -- .claude/settings.json      # restore the hook registration as it was

# 2. Roll back a single file
git checkout origin/main -- .claude/rules/common/agent-isolation.md

# 3. Roll back the whole PR after the merge
git revert -m 1 <merge-sha>

# 4. Before the merge — just close the PR; the branch changes nothing in main.
```

**Expected state after rollback (1):** `git -C <repo> diff origin/main -- .claude/settings.json`
empty; the hooks remain on disk but are not invoked.
**Verification:** `python3 -c "import json;print([h['id'] for h in json.load(open('.claude/settings.json'))['hooks']['PreToolUse']])"`
does not contain the rolled-back id; `bash .claude/hooks/tests/cross-agent-hooks-smoke.sh`
continues to pass (the test calls the scripts directly and does not depend on the registration).

---

## Sources

- Incidents: PR #493, #497, #504, #544, #545, #547, #551 (dates in the Context table).
- Verification runs of the harness and the hooks — 2026-08-17, output in the PR body
  `infra/agent-infra-mechanics`.
- Claude Code source (leaked snapshot, `~/Desktop/programming/claude-code/`,
  memory `reference_cc_leak_source`): `services/tools/toolExecution.ts`,
  `services/tools/toolHooks.ts`, `utils/hooks.ts`, `tools/AgentTool/constants.ts`,
  `tools/AgentTool/AgentTool.tsx`. **The snapshot is older than the running application** —
  see the caveat in D3.
- The subagent's system prompt (this runtime): "Agent threads always have their cwd
  reset between bash calls".
- Existing precedents: `scripts/devops/reap-zombie-devservers.sh`,
  `.claude/hooks/pre-bash-live-db-guard.sh`, `.claude/rules/common/light-track.md`.
