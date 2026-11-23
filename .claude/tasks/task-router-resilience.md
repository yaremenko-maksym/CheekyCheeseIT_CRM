# task-router-resilience

## Agent: coder
## Status: ready
## Priority: high
## Branch: fix/router-resilience (one PR)
## Depends on: nothing. Runs in parallel with task-jev-offload Part A (that one owns `apps/api/src/resumes/verification/inference-clients.ts` and `packages/inference/src/adapters/jev.decision-adapter.ts` — do not touch them).

## Context (prod facts, 2026-11-23, measured by Master)

- Router config `hosted-2026-11-21`: gemini [gemini-3-flash-preview, gemini-3.1-flash-lite-preview] timeout 30 s, `freeLimit.requestsPerDay: 1000` (real Gemini own cap ~20/day); groq [gpt-oss-120b, gpt-oss-20b]; cloudflare RPD 16; openrouter `:free`.
- VISUAL_CHECK 6/7 PROVIDER_ERROR today: one Gemini attempt per call, `TIMEOUT` at 30 s, then EXHAUSTED; `gemini-3.1-flash-lite-preview` was never tried.
- Groq 429 bursts: two attempts on the same model within ~15 ms, then the sibling model at once.
- CLASSIFY_ROLES rotation lands on Gemini and spends the quota vision needs.
- Self-heal probes spend up to 6 Gemini calls/day (`PROBE_CAP`).

## Findings to close (code refs from the audit, verify each before editing)

1. **TIMEOUT drops the whole route.** `TIMEOUT` is in `NEXT_ROUTE` (`apps/api/src/extraction-worker/**/router.ts` ~129-138, `left.add(route)` ~503). For a call that carries images (only one vision-capable route exists), a TIMEOUT on one model must try the next vision-capable model of the same route before leaving it. For text calls keep today's behaviour unless the change is equally safe — record the choice in Assumptions.
2. **Text calls spend Gemini's vision quota.** Add a code-level vision reserve: a text (no-image) call must not pick a route/model when that route is the only vision-capable route and its remaining daily budget is at or below a reserve (constant, start at 10 of the day's cap). Rotation code ~479-485. The prod `freeLimit` value itself is owner/ops config — do NOT edit `.env.extraction-worker` or prod `EXTRACTION_ROUTER_CONFIG`; put the recommended value (`gemini.freeLimit.requestsPerDay: 20`) in the PR body under "Owner action". If a repo-side default/example config exists (docs, `.env.example`, runbook `docs/runbooks/extraction-worker.md`), update it there.
3. **429 retries without backoff.** `retry-after: 0` → 0 ms pause (`classified-chat.ts` ~222-224, `router.ts` ~420-423); a long retry-after cools only the model, the sibling model fires at once (`router.ts` ~376-381, ~427). Fix: a minimum backoff floor (constant, a few seconds) on BUSY/429; when a provider returns 429, cool the whole provider (all its models) for the floor or the retry-after, whichever is larger. Keep the overall `hostedBudgetMs` respected — never sleep past it.
4. **Gemini probe cost.** Cap Gemini liveness probes to 1 per day (`self-heal.ts` ~78-86, `state.ts` `PROBE_CAP` ~43, `model-refresh.ts` ~449-455); other providers unchanged.

## Acceptance criteria

- [ ] 1. Unit: image call, first Gemini model TIMEOUT → second vision model of the same route is attempted; a test fails on origin/main.
- [ ] 2. Unit: text call does not select the sole vision route when its remaining budget ≤ reserve; selects it when above.
- [ ] 3. Unit: 429 with `retry-after: 0` → next attempt on that provider waits ≥ floor; sibling model of the same provider is not attempted inside the cool-down; another provider may be.
- [ ] 4. Unit: Gemini probes ≤ 1/day.
- [ ] 5. Existing extraction-worker / router suites pass (report non-zero counts); `pnpm --filter @crm/api typecheck` green.
- [ ] 6. PR body: "Owner action" block with the exact config change for `gemini.freeLimit.requestsPerDay`, and `Jev-first: n/a (router plumbing, no new model call)`.

## Assumptions
(coder fills: reserve value, floor value, text-call TIMEOUT behaviour)

## Do not touch
- Prod `.env.extraction-worker`, prod `EXTRACTION_ROUTER_CONFIG`.
- `/resume-write` prompts. Files owned by Part A (see Depends on).
