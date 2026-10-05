---
name: diagnosing-bugs
description: 'The discipline of diagnosing hard bugs and flakes: a phased cycle with the gate "no red command — no hypotheses". First a tight feedback loop is built (one fast deterministic command that goes red on EXACTLY this bug), then minimization of the repro, then ranked falsifiable hypotheses, targeted instrumentation, a fix with a regression test, and cleanup.'
when_to_use: "Use when a bug resists a first look, an E2E goes flaky, a regression crept in between two good states, or something is slow. Examples: 'the test is flaky in CI', 'the bug does not reproduce locally', 'something broke between releases', 'the page is slow', 'did we find the root cause?', 'it fails only sometimes'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__ast-grep__find_code
  - mcp__codegraph__codegraph_explore
  - mcp__playwright__browser_navigate
  - mcp__playwright__browser_evaluate
  - mcp__playwright__browser_console_messages
---

# Diagnosing bugs — the loop first, theories after

`contracts.md` §5.3 requires "the root cause found (NOT raising timeouts, NOT retry masking)", but
does not say **how**. This skill is the missing mechanics. Phases are skipped only with explicit
justification.

## Redacting secrets

The skill forces you to show commands, output and captured artifacts. **Secrets are scrubbed first
thing**: in their place `<REDACTED>`; build loops against environment variables, so the credential
stays in the environment and not in what is shown. Captured traffic carries auth headers — quote only
the lines that carry signal. If after scrubbing there is nothing left to diagnose with — say so and ask the owner
(this is A3 per `autonomy-levels.md`).

## Phase 1. Build the feedback loop

**This is the skill, the rest is mechanics.** There is a **tight** pass/fail signal that goes red on _this_
bug — you will find the cause; bisection, hypothesis checking and instrumentation merely consume it.
No signal — however long you stare at the code, it will not help.

Ways, roughly in this order:

1. **A failing test** at any reachable seam: unit, integration, E2E.
2. **An HTTP script** against a running dev server (`curl`, `.http`).
3. **A CLI call** with a fixture, diff stdout against a known-good.
4. **A Playwright script** that drives the UI and asserts on DOM / console / network.
5. **A capture replay**: save a real request / payload / event log and run it through the code
   in isolation.
6. **A throwaway harness**: a minimal slice of the system (one service, mocked dependencies)
   that pokes the buggy path with one call.
7. **A property / fuzz loop**, if the bug is "sometimes a wrong result": a thousand random inputs.
8. **Bisection**, if the bug appeared between two known states: automate
   "go to state X, check, repeat" under `git bisect run`.
9. **A differential loop**: the same input through the old and the new version, diff the outputs.

Built the right loop — the bug is 90% fixed.

### Tighten the loop

The loop is the product. Got _some_ loop — **tighten it**: faster (cache the setup, cut extra
initialization, narrow the scope), a sharper signal (assert on the specific symptom, not on "it did not fail"),
more deterministic (fix the time, seed the RNG, isolate the FS and the network).

A flaky thirty-second loop is almost useless; a two-second deterministic one is a superpower.

### Non-deterministic bugs: the goal is not a repro but the frequency

Not "a clean reproduction", but **raising the frequency**. Run the trigger 100×, parallelize, add
load, narrow the time windows, insert `sleep`. A bug with 50% flake is debuggable, with 1% is not:
raise the frequency until it becomes debuggable.

### The phase 1 gate

The phase is closed when you can name **one command**, **already run at least once** (show the
call and the output, scrubbed), and it:

- [ ] **goes red** — pokes the real path of the bug and asserts the **exact symptom** described by the
      reporter, not "ran without error";
- [ ] **is deterministic** — the same verdict every run (for flakes — a fixed high frequency);
- [ ] **is fast** — seconds, not minutes;
- [ ] **is run by the agent** without a human in the loop.

If you catch yourself reading code for a theory before this command exists — **stop**. The jump to
a hypothesis is exactly the failure the skill prevents.

**In the fix report, a line with the call of the red command and its output is mandatory.** No line — the phase
is not passed, the hypotheses are invalid.

## Phase 2. Reproduce and minimize

Run the loop, watch how it goes red. Confirm: this is **the** symptom the reporter had, not
a similar one nearby; it reproduces repeatedly; the exact symptom is fixed for checking the fix.

Then **minimize**: cut inputs, callers, config, data and steps **one at a time**, running the
loop after each cut. Done when **every remaining element is load-bearing** — removing any
makes the loop green.

Why: the minimal repro shrinks the hypothesis space in phase 3 and becomes a clean regression
test in phase 5.

## Phase 3. Hypotheses

**3–5 ranked hypotheses before checking any of them.** A single hypothesis anchors on the first plausible one.

Each is **falsifiable** — name a prediction: "if the cause is X, then change Y removes the bug /
change Z amplifies it". If you cannot name a prediction, it is not a hypothesis but a feeling: sharpen
it or discard it.

The ranked list — into the report before checking. The owner often re-ranks instantly ("we just
shipped a change in #3"). Do not block on this: it is A2, continue in your own order.

## Phase 4. Instrument

Each probe corresponds to a specific prediction from phase 3. **Change one variable at a time.**

Priority: a debugger / REPL if the environment allows (one breakpoint is better than ten logs) →
targeted logs at the boundaries that distinguish the hypotheses. Never "log everything and grep".

**Tag every debug log with a unique prefix** — `[DEBUG-a4f2]`. Cleanup at the end
becomes one grep: untagged logs survive, tagged ones die.

**The performance branch.** For speed regressions logs are usually useless: first a baseline
measurement (a timer, `performance.now()`, a profiler, the query plan), then bisection. Measure first,
fix second.

## Phase 5. Fix and regression test

The regression test is written **before** the fix — but only if there is a **right seam**.

The right seam is the one where the test pokes the **real pattern of the bug the way it happens at the call site**.
If only a too-small seam is available (a unit where the bug needs several callers; a test that does not
reproduce the chain) — a test on it gives false confidence.

**No right seam — this is itself a finding.** Record it: the architecture hinders pinning the bug.
This is the entry into `codebase-design` (deepening the module), not a reason to write a test "wherever it fit".

There is a seam: minimal repro → failing test → watch it fail → fix → watch it pass →
run the phase 1 loop against the original (non-minimized) scenario.

**The mutation gate.** A test that went green but does not kill a mutant is tautological
(`coder.md` §2.6). The gate catches this mechanically; know it in advance.

## Phase 6. Cleanup

Mandatory before "done":

- [ ] The original repro no longer reproduces (run the phase 1 loop)
- [ ] The regression test passes (or the absence of a seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (by a grep on the prefix)
- [ ] Throwaway harnesses removed
- [ ] The correct hypothesis named in the commit message / PR body — so the next debugger learns

## Related

- `.claude/agents/contracts.md` §5.3 — Flaky E2E SLA (what counts as a fix).
- `.claude/skills/playwright-patterns/SKILL.md` — CRM specifics of E2E flakes.
- `.claude/skills/codebase-design/SKILL.md` — when the finding is "no right seam".
- `.claude/rules/common/live-db-access.md` — reading the live DB is allowed, writing is not.
