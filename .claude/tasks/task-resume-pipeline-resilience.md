# task-resume-pipeline-resilience

## Agent: coder
## Status: ready (dispatch only after task-jev-offload Part A is merged — it owns `inference-clients.ts`)
## Priority: high
## Branch: fix/resume-pipeline-resilience (one PR)

## Context (audit 2026-11-23, code refs to verify)

Senior resume verification runs on prod die on a single failed model call. Prose generation stays on
the hosted routes (per `jev-first.md`, it is generation and Jev cannot do it). Only resilience changes here.

## Findings to close

4. **One writer failure kills the run.** `content-gates.ts` ~297-300 throws `WRITER_UNAVAILABLE` on the first
   `/resume-write` unavailable reply. A run makes (1 summary + N jobs) calls × up to 3 attempts. Fix: retry a writer call
   that came back unavailable once, after a delay of at least 20 s, so a per-minute limit can pass (constant). Then
   throw as today. Space a run's writer calls by a small constant gap so one run does not burst Groq's per-minute
   limit. Respect any existing run-time budget. Apply the same to `/resume-tailor` (`tailored-generate.ts` ~100).
5. **Jev entailment / decisions have no retry.** `inference-clients.ts` ~255-262 (entailment), `jev-decide.ts`
   ~44-50. Fix: one retry with backoff on `RATE_LIMITED` / TIMEOUT / transport error. Then the existing unavailable
   code, with a structured log line naming provider + cause.
6. **Resume upload extraction depends on one Cloudflare model.** `resume-ai.service.ts` ~55 uses
   `@cf/mistralai/mistral-small-3.1-24b-instruct` directly. Fix: an ordered model list with a fallback to a second
   model on 410 / 404 / unavailable. Pick a Cloudflare model the worker config already uses
   (`@cf/openai/gpt-oss-20b` or `@cf/google/gemma-4-26b-a4b-it`), with JSON output verified by the existing parser
   tests. Keep the daily budget (`resume-ai-daily-budget.ts`) counting every attempt. Degrade to manual entry as today.

## Acceptance criteria

- [ ] 1. Unit: the first writer call unavailable, the retry OK → the run continues. Both unavailable → `WRITER_UNAVAILABLE`. The delay is asserted with fake timers.
- [ ] 2. Unit: Jev `RATE_LIMITED` then OK → an answer. Twice → the existing unavailable code plus one log line.
- [ ] 3. Unit: Cloudflare model 1 returns 410 → model 2 is called. The budget is decremented per attempt.
- [ ] 4. The existing verification, entailment, relevance and resume-ai suites pass (non-zero counts). Typecheck is green.
- [ ] 5. The PR body carries `Jev-first: resume writer -> hosted (free-form prose)` and `Jev-first: resume upload extraction -> hosted (open structure)`.

## Assumptions
- A1: writer retry delay `WRITER_RETRY_DELAY_MS` = 20 s. A per-minute free-tier window (Groq, OpenRouter :free) partly resets in that time, and the delay still fits both run budgets. A retry is taken only while the run budget holds the whole delay: 1 200 000 ms for `/resume-write`, `TAILORED_WRITER_BUDGET_MS` = 400 000 ms for `/resume-tailor`.
- A1: gap between the writer calls of one run `WRITER_CALL_GAP_MS` = 2 s, which is 30 calls a minute (the Groq free-tier RPM). The router's `minGapMs` overlaps it; the run-level gap stays as a second floor because the router value is backed only by the rehearsal script.
- A1: Cloudflare fallback model `@cf/google/gemma-4-26b-a4b-it`. The extraction worker already runs it. It is cheaper than mistral (0.1 / 0.3 vs 0.351 / 0.555 USD per M tokens in / out), so `RESUME_AI_DAILY_CALL_CAP` = 10 still bounds the spend. It answers in the OpenAI chat shape (`result.choices[0].message.content`), which `callModel` now reads. Fallback only on HTTP 404 / 410 / 5xx.
- A1 (SPEC-L-1): writer replies `LIMITS_EXHAUSTED`, `NOT_CONFIGURED` and `INVALID_INPUT` are never retried. A spent daily limit and a missing key do not change in 20 s, and an invalid input is refused before any provider call, so a retry would only spend budget and delay the same failure.
- A1: Jev retry delay `JEV_RETRY_DELAY_MS` = 5 s, one retry. One budget check can be followed by several Jev requests in a row (`decideAll` and `scoreEntailment` send one request per 50 questions; the tailored `beforeModelCall` checks ownership only), so a Jev retry is taken only while the run's reaper deadline still holds `JEV_RETRY_COST_MS` = 5 s + 60 s (the Jev adapter's default timeout). A retry therefore never ends after the reaper deadline (1 400 000 ms for `/resume-write`, 600 000 ms for `/resume-tailor`).

## Do not touch
- `/resume-write` prompts, prod env and router config.
