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

- [x] 1. Unit: image call, first Gemini model TIMEOUT → second vision model of the same route is attempted; a test fails on origin/main.
- [x] 2. Unit: text call does not select the sole vision route when its remaining budget ≤ reserve; selects it when above.
- [x] 3. Unit: 429 with `retry-after: 0` → next attempt on that provider waits ≥ floor; sibling model of the same provider is not attempted inside the cool-down; another provider may be.
- [x] 4. Unit: a Gemini probe obeys the vision reserve (no probe at or below `VISION_RESERVE_REQUESTS` left); other providers unchanged. Reworded by Master D2, see Assumptions.
- [x] 5. Existing extraction-worker / router suites pass (report non-zero counts); `pnpm --filter @crm/api typecheck` green.
- [x] 6. PR body: "Owner action" block with the exact config change for `gemini.freeLimit.requestsPerDay`, and `Jev-first: n/a (router plumbing, no new model call)`.

## Assumptions
- Vision reserve = 10 requests (`VISION_RESERVE_REQUESTS`), an absolute count of the vision route's own cap left today. A text call skips the vision route at 10 or fewer left (reason `CAP`, route end `LIMIT`). Image calls are never held back. Reversible; rollback is one constant.
- The vision route is the one route with a vision-capable model. The config allows each provider once and only Gemini reads images, so there is at most one. Reversible.
- Busy floor = 3000 ms (`MIN_BUSY_BACKOFF_MS`). The pause after any BUSY is the larger of the floor and the retry-after (absent retry-after: 9000 ms, as before). The floor is at or below `BUSY_BACKOFF_MS`, so the one in-call wait still happens. The wait still never passes the hosted budget. Reversible.
- Cool-down scope depends on the provider type (Master D1). For `gemini`, `groq` and `cloudflare`, a 429 cools only that model (floor applies), so the sibling model is tried at once. For `openrouter`, a 429 cools every OpenRouter model, because `:free` limits are account-wide. A 503 cools only the model on every provider. Provider set: `ACCOUNT_RATE` in `router.ts`. Reversible.
- Text-call TIMEOUT behaviour is unchanged: the call still leaves the route. Text has other routes, and the next route is the safer use of the budget. An image call stays on the vision route and tries its next vision model. Reversible.
- AC 4 reworded (Master D2): no hard 1/day cap and no new state field. A liveness probe of a vision-capable model is skipped (`capped`) when the provider's own cap has `VISION_RESERVE_REQUESTS` or fewer requests left today. A skipped probe keeps any stale flag, so an unprobed model is never marked alive. Reversible.
- D3: prod already has `gemini.freeLimit.requestsPerDay: 20` and `hostedBudgetMs: 90000` (applied by Master 2026-11-23); the PR body records it as applied.
- The runbook sample (`docs/runbooks/extraction-worker.md`) already shows `gemini.freeLimit.requestsPerDay: 20`. `docs/` is outside the coder zone, so it is not edited.

## Do not touch
- Prod `.env.extraction-worker`, prod `EXTRACTION_ROUTER_CONFIG`.
- `/resume-write` prompts. Files owned by Part A (see Depends on).

## Master decisions (2026-11-23, round 2): A1, reversible within this PR

- D1. **The cool-down scope depends on the provider type, not one global rule.** Gemini and Groq free limits are per model. On prod on 2026-11-23 at 10:06, `gpt-oss-20b` answered right after `gpt-oss-120b` returned 429. Rules:
  - For `gemini`, `groq` and `cloudflare`, a 429 cools **only that model**, still with the `MIN_BUSY_BACKOFF_MS` floor. The sibling model may be tried at once.
  - For `openrouter`, a 429 cools the whole provider, because `:free` limits are account-wide.

  This also settles the image-call risk: after a Gemini 429 on one model, the image call can still try the second vision model. Restore those of the 4 changed tests in `router.cascade.spec.ts` / `router.openrouter.spec.ts` that match this rule. Add two tests:
  - groq model 1 returns 429 → model 2 is attempted;
  - openrouter returns 429 → no other openrouter model is tried inside the cool-down.
- D2. **Finding 4: take your recommendation.** Gemini probes obey the same `VISION_RESERVE_REQUESTS` reserve: no probe when the remaining budget is at or below the reserve. No hard 1/day cap and no new state-file field. Remove the `.blocked.md` file (git rm). Tick AC 4 and record the reworded criterion in Assumptions.
- D3. On prod, `hostedBudgetMs` is 90000. Gemini `requestsPerDay` is already 20 there (Master set it on 2026-11-23). In the PR body, change the "Owner action" block to "applied 2026-11-23".
- Before pushing: if the branch is behind, run `git fetch origin && git merge origin/main`.
