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
(the coder fills in: retry delay, gap value, the chosen fallback model)

## Do not touch
- `/resume-write` prompts, prod env and router config.
