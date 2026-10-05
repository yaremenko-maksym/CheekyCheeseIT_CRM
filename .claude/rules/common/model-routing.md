# Rule: Model routing — the minimally sufficient model

**Status:** Always-on
**Applies to:** Master (dispatch via `Agent()`), all agents, USER sessions
**Source:** USER request 2026-06-11 (token optimization). Prices per 1M tokens (input/output): Fable 5 $10/$50 · Opus 4.8 $5/$25 · Sonnet 4.6 $3/$15 · Haiku 4.5 $1/$5.

---

## Principle

Each task is done by **the cheapest model whose capacity is guaranteed to close it precisely**. A doubt between tiers → take the higher tier only when the cost of error (security / money / cascading re-dispatch) is higher than the price difference; otherwise the lower tier + escalation by trigger.

> **Main principle (owner feedback 2026-10-03).** The minimally sufficient model is the **DEFAULT, not an
> exception**. The cheapest tier that is **guaranteed** to suffice is tried **FIRST**. A higher tier —
> only when (a) the task is knowingly judgment-heavy / critical (money, RBAC, security, migrations,
> cross-zone contracts, architecture) **or** (b) the lower tier failed. New and strong model versions —
> for the complex or after the weaker one failed, **not by default**. The project is huge: overpaying for a tier on every
> mechanical task adds up to the main expense line.

## Static assignment (fixed in the agents' frontmatter)

| Tier       | Agents                                                                                                                               | Why                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **opus**   | `architect`, `legal`                                                                                                                 | Judgment-heavy ADR / legal analysis: a crooked ADR / a missed legal risk cost more than 1.7× the price. Orchestration is run by Master (USER session, the tier is chosen via `/model`) |
| **sonnet** | `coder`, `autotest`, `code-reviewer`, `spec-reviewer`, `security-reviewer`, `copy-reviewer`, `manual-qa`, `ui-ux-designer`, `devops` | The workhorse: code, tests, review, QA. **Reviewers (incl. copy/security) — here, NOT in opus** (see below)                                                                            |
| **haiku**  | No permanent agents — a pointed `model="haiku"` override (mechanics + **text-only / simple-catalog review by checklist**)            | Simple mechanics, reconnaissance, mechanical verification (see the downgrade below)                                                                                                    |
| **fable**  | **NEVER for agents** (and in general not to be used without dire need)                                                               | The most expensive; even the USER main session should prefer Opus 4.8                                                                                                                  |

Do NOT change the agents' frontmatter `model:` without updating this table (single source).

**The static `model:` is a CEILING by default, not an assignment to a task.** `model: sonnet` on `coder`
means "do not go above sonnet without a reason", not "all coding goes on sonnet". Master (orchestrator)
**MUST** pass `model=` (and effort, where the harness permits) into `Agent()` per the concrete task by
the table below, dropping to `haiku` on mechanics. Dispatching a coder without `model=` on a task falling under the
haiku row is overpayment and a finding at acceptance.

## Reviewers — the minimal tier, NOT the top model (owner feedback 2026-10-04)

The prior edition kept `copy-reviewer` and `security-reviewer` on **opus**. This bred overspend:
expensive models went to text review that does not justify them. Verbatim from the owner: "a copywriting task
is not the level of such models". Reconsidered:

- **copy-reviewer → `haiku`** for a simple catalog (uk/en error strings): detecting Russianisms (the Russian-only Cyrillic letters absent from Ukrainian, per the guard — the canonical literal glyphs live in `russian-language.md`) +
  checking against the `_Avoid_` list in `CONTEXT.md` — this is essentially mechanical list-work. **`sonnet` — only** for
  bulky/nuanced text (a 5-language landing, "reads like a translation"). **NOT opus.**
- **code-reviewer / spec-reviewer → `haiku`** for text-only / mechanical diffs (statuses did not shift,
  uk strings, tests updated); **`sonnet`** — for diffs with real logic.
- **security-reviewer → `haiku`** for text-only/low-logic migrations (a checklist check: logic/statuses
  unchanged, no leak into params); **`sonnet`/`opus` — only** for a really risky surface
  (new auth logic, money movement, crypto contracts), not for "text→code".
- The orchestrator verifies the aggregate itself: a cheap reviewer + orchestrator reconciliation is cheaper than an expensive reviewer.
- **Authoring vs review:** generating a quality bilingual catalog — `sonnet` (haiku stumbled,
  incident #761). But **review/verification** (checking against the list that there are no Russianisms) is mechanics, carried by `haiku`.

## Model versions — the lower ones by default (owner feedback 2026-10-04)

**For agents use the lower versions: Opus 4.8 / Sonnet 4.6 / Haiku 4.5. Sonnet 5+, Opus 5+, Fable —
ONLY for really complex tasks, not by default** (they are "too many tokens").

The catch: the tier aliases (`sonnet`/`opus` in `Agent()` and in frontmatter) in the current harness resolve to
the **newest** version (5.x), not the 4.x for which the price table above was written. I.e. `model="opus"` on
a reviewer went to Opus 5.x, not 4.8. The levers:

- **The tier** (haiku < sonnet < opus < fable) — we control it from `Agent(model=)`; this is the MAIN saving:
  take the minimal sufficient tier (haiku wherever possible), do not use fable.
- **The minor version** (4.x vs 5.x behind the alias) — set by the Claude Code config (the default model / subagents),
  NOT by a dispatch parameter (the enum accepts only tier aliases). Keep the default on 4.x; 5+/fable — deliberately and rarely.

## Task type → tier (coder and edit executors)

| Task type                                                                                                                                                                                                                                                                                              | Tier + effort          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| **Mechanics:** string / literal replacement; `i18n:extract` catalog sync; rebase / merge without semantics; editing comments and docs; configs without a runtime effect; test-only edits without new logic; finishing off surviving mutants by a ready list; moving by a map (rename / moving imports) | **haiku** + effort low |
| An ordinary feature / logic within a single module                                                                                                                                                                                                                                                     | **sonnet** + medium    |
| Cross-zone contracts (api ↔ web ↔ shared); finance / RBAC / security / money; Drizzle migrations and prod data; architecture. **Or** a fix task after a lower tier failed                                                                                                                              | **opus** + high        |

The haiku limits from the "Downgrade" section below apply here too: an automatic gate (typecheck + tests) is needed,
zero business logic, nothing from critical-path zones. The "test-only edits" row means edits to existing
specs without new logic (AutoTest zone); writing new specs — sonnet.

**Effort** — a second axis to the tier: **low** — mechanics; **medium** — the default, ordinary logic; **high** — hard /
critical. For `Agent()` dispatch, effort is passed where the harness supports it; where it does not (a subagent
is chosen by type and `model=`) — the effect is achieved by choosing the tier, we do not invent a separate parameter.

## Dynamic overrides — Master passes `model=` into `Agent()`

### Escalation: haiku → sonnet → opus

The ladder is one, a step up is taken **by trigger**, not "just in case":

| Step             | Trigger                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| haiku → sonnet   | The agent is stuck / looped on mechanics, the auto-gate does not pass on the second attempt                                                 |
| → opus           | A second `Verdict: BLOCK` in a row or a failed run (see the table below)                                                                    |
| straight to opus | A knowingly critical-path zone (money / RBAC / security / migrations / a cross-zone contract / architecture) — without trying the lower one |

### Escalation → `opus`

| Trigger                                                                                                | Action                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| A second `Verdict: BLOCK` in a row on one task (`review_rounds == 2`)                                  | Fix-task re-dispatch Coder with `model="opus"`  |
| Task file: a Drizzle migration + a cross-module refactor / finance calculation logic / company-account | Straight to `## Model: opus` in the task file   |
| Flaky Mode 4: sonnet-AutoTest did not find the root cause on the first pass                            | Re-dispatch with `model="opus"`                 |
| An agent cut off / got lost twice on the same multi-step task                                          | Re-dispatch with the top tier + a reduced scope |

### Downgrade → `haiku` (only with an automatic verifying gate)

Allowed:

- Read-only reconnaissance / search over the codebase (Explore-style fan-out, collecting lists of files/occurrences)
- Triage of CI logs, summarizing long run outputs for Master
- Mechanical batches by an exact list (rename by a map, moving imports, uniform edits) — ONLY with an auto-gate present (typecheck + tests) and zero business logic
- Merge `origin/main` into a PR branch with additive conflicts (`.po`, barrels) + worktree/port cleanup — under the same auto-gates (see "The orchestrator's token diet")

FORBIDDEN for haiku: quality gates (code/security review, manual-qa, designer), business logic, migrations, `*.spec.ts` **with new logic**, everything in critical-path zones.

### Reviewers

| Reviewer                             | Tier       | Why                                                                                                                                                                            |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `security-reviewer`, `copy-reviewer` | **opus**   | Security and text quality in five languages — judgment, not mechanics; the defect is caught by no check                                                                        |
| `code-reviewer`, `spec-reviewer`     | **sonnet** | Diff ↔ code / diff ↔ task — working review                                                                                                                                     |
| **Mechanical re-check**              | **haiku**  | "The string is replaced", "the diff is trivial", "finding N is closed literally per the text" — a reconciliation of a fact, not judgment. It does not replace the verdict gate |

Haiku in the re-check row reconciles **the execution of a concrete item**; it does not issue the `APPROVE` / `BLOCK` verdict on a PR —
that stays with the reviewers above (the haiku ban on quality gates is preserved).

## Accounting (otherwise the policy is not verifiable)

1. Task file: the `## Model:` field — the tier per the "Task type → tier" table (`haiku` on mechanics, `sonnet` on ordinary
   logic, `opus` — with one line of rationale per the trigger table). The field absent → `sonnet` as the ceiling,
   but Master still reconciles the task type against the table before dispatch.
2. Master records the chosen tier in the `## Model:` field of the task file (and in the dispatch prompt).
3. Dispatch without `model=` → Master adds the parameter itself per this table.

## USER main session (recommendation; chosen via `/model`)

- **Fable 5** — system audits, architectural decisions, complex cross-module debugging, meta-optimizations of processes.
- **Opus 4.8** — ordinary orchestration days (may use `/fast`). **Loop mode (merge on readiness, fix rounds,
  CI monitors) is an orchestration day by definition**, not an audit: the session switches to Opus before the cycle starts.
- **Sonnet 4.6** — the light track: docs, small edits, routine operations.

## The orchestrator's token diet (measurement 2026-09-21)

**Where the rule comes from.** An analysis of one internationalization loop session (from the start, through all compacts): the orchestrator on
Fable made **10,937 turns**, output 14M tokens, cache reads **5.86 billion**. In the equivalent of API prices the output is ~8%
of the sum, the rest is re-reading 300–500k tokens of context on every turn. Hundreds of turns were an "I'm waiting" answer to a
monitor event ("CI: success", "Deploy: success"). The coders (Sonnet, 156 runs) — 33.8 billion cache reads:
fix rounds on 26 findings and ~1000 tool calls. The owner's and the analysis's conclusion coincided: **the expensive thing is not the intellect, but the
number of turns × the context size.** The cascade "cheap model by default, expensive by necessity" already exists here
(the table above); the leak is in the orchestrator's mechanics and in the length of tasks.

| What                     | Rule                                                                                                                                         | Why                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The orchestrator's model | A loop/orchestration day — **Opus**; Fable — audit/architecture/complex debug                                                                | 2× the price per token at ~90% mechanical turns                                         |
| CI/deploy monitors       | **Only terminal events**: one output on completion (result + head + `mergeStateStatus`), not on every check                                  | Every event = a turn with the full context                                              |
| A non-terminal event     | **Do not answer with text.** An "I'm waiting" turn is an error, not politeness                                                               | The same turn, zero information                                                         |
| A fix round for a coder  | **≤ ~10 findings**; more — 2–3 coders by file groups (disjoint)                                                                              | 26 findings = 1000 tool calls and 20+ billion cache tokens on one                       |
| Agent mechanics          | **haiku** + an auto-gate: merge `origin/main`, cleanup, edits by an exact list                                                               | Already allowed by the downgrade table — now mandatory                                  |
| Delta review rounds      | copy-reviewer on the **delta** (checking its own findings are closed) — `model="sonnet"`; the first copy round and any security round — Opus | The delta checks conformance to the review text, the quality judgments are already made |
| Permanent context        | The orchestrator's memory index — compact: closed projects older than a quarter into an archive file not loaded into the session             | 55k tokens of index × every turn                                                        |

**How we know it is violated.** A turn of the orchestrator whose body is one sentence "waiting for …" after a monitor event;
a monitor with an `echo` on every check; a fix-task with a control line `(N)` at N > 12 without splitting; a loop-mode session on
Fable (visible in the model menu). All of this is checked by eye over the transcript, there is no gate — and none is needed: the cost of a violation is
counted in tokens after the fact, not caught before.

## Related rules

- `.claude/rules/common/light-track.md` — the master session's light track.
- `.claude/agents/contracts.md` §3 — dispatch matrices (whom to dispatch); this rule — with which tier.
