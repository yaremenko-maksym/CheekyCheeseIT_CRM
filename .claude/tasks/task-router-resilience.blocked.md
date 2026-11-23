# BLOCKER: task-router-resilience — AC4 only (Gemini probes ≤ 1/day)

## Agent: coder

## Task: .claude/tasks/task-router-resilience.md

## Problem

AC4 asks for at most one Gemini liveness probe a day. The task does not say how Gemini self-heal must
behave with one probe. Self-heal is more than a liveness check: the daily job also promotes new models
after a 3-day alive streak, removes dead models, and rests ids that never answer alive. The weekly
chain check raises `MODEL_LIST_STALE`.

Measured: a Gemini-only cap of 1 per sweep in `runDailyModelRefresh` and `runModelChainCheck`
(`packages/inference/src/router/model-refresh.ts`) turns 68 existing specs red. 8 are in
`model-refresh-probes.spec.ts` and 60 in `model-refresh.spec.ts`. They pin outcomes (promotion,
removal, rest, stale flags), not probe counts.

There is also a correctness trap. The chain check with `inUse.slice(0, 1)` ends with
`stopped === null`, so `setStaleModels` replaces the stale list. A model that was never probed then
loses its stale flag as if it were proven alive. The code has a cut-short path (`stopped: 'capped'`),
and slicing bypasses it.

A per-sweep cap is also not per day. The daily job and the weekly chain check run on the same day once
a week. The startup refresh probes hourly while an `AUTH` bit is set. A real per-day cap needs a
persisted stamp, and the state schema is `.strict()`, so a new field is a rollback hazard: an older
worker would reject the whole file.

The change was reverted. AC1, AC2, AC3, AC5 and AC6 are done on this branch.

## Affected code

- `packages/inference/src/router/model-refresh.ts`, `runDailyModelRefresh` (Gemini gets `PROBE_CAP` = 6 probes)
- `packages/inference/src/router/model-refresh.ts`, `runModelChainCheck` (`inUse.slice(0, PROBE_CAP)`)
- `packages/inference/src/router/state.ts`, `PROBE_CAP` (it also sizes `MAX_MODEL_RECORDS`, a persisted `.max()`; do not lower it)

## Question to Master / the user

How should Gemini self-heal spend its probes?

- **A. A hard cap of 1 a day.** Persist a probe-day stamp, rotate which model gets the probe, and
  report "not reached" separately from "alive". Rewrite the 68 specs for the slower behaviour:
  promotion takes at least 3 days per candidate and happens only when current models had OK calls.
  This costs the most and degrades self-heal.
- **B. Recommended: probes obey the vision reserve.** A Gemini probe is not sent when
  `ownCapRemaining(gemini) <= VISION_RESERVE_REQUESTS`. This reuses the reserve from finding 2, so a
  probe can never take a request image calls need, and the mechanism specs stay valid. Combined with
  the owner action `requestsPerDay: 20`, probes spend at most 10 requests a day, and only on days
  vision did not need them.
- **C. B plus a smaller sweep for Gemini (2 a sweep).** The chain check is routed through the `capped`
  path so unprobed models keep their stale flag. Some specs need rework.

## What was done before the blocker

- `packages/inference/src/router/router.ts`, `packages/inference/src/router/state.ts` (AC1–AC3)
- `packages/inference/src/router/router.resilience.spec.ts` (new), `router.cascade.spec.ts`, `router.openrouter.spec.ts`
