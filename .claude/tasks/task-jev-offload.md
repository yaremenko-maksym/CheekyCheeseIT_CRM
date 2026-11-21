# task-jev-offload

## Agent: coder
## Status: ready
## Blockers: none
## Priority: high
## Model: per `jev.mjs route` at dispatch
## Depends on: nothing. Rule `.claude/rules/common/jev-first.md` defines the check this task applies.
## Branch: feature/jev-offload (one PR per part below)

## Context

On 2026-11-21 no senior resume on prod could reach the final PDF: every verification run died on a
hosted-route quota (`WRITER_UNAVAILABLE`, then `VISUAL_CHECK_UNAVAILABLE` with the router reply
`LIMITS_EXHAUSTED`, Gemini own cap of 20 a day spent). The visual check can run only on Gemini today
(`isVisionCapable` admits the Gemini family alone). Jev answers typed questions about text and
images (verified against the live API on 2026-11-21: image `noul` questions on `jev-latest`, about 900
input tokens per page at $0.042 per 1M). Owner decision 2026-11-21: move every model call Jev can
answer to Jev, and keep the hosted routes for generation only.

## Parts (one PR each, in this order)

### Part A — resume visual check → Jev (priority: blocks the resume preview on prod)

1. `apps/api/src/resumes/verification/inference-clients.ts` — a visual client backed by `DecisionPort`
   (Jev): one Jev call per rendered page, carrying that page as its single image asset, with one
   `noul` question per check in `VISUAL_CHECKS` (a `noul` answer carries no page, so the page comes
   from the call)
   (`apps/api/src/extraction-worker/link-contract.ts`: overflow, overlap, ragged, orphan,
   broken-bullet, uneven-spacing, cut-off), the check's definition from `VISUAL_CHECK_INSTRUCTION` as
   the question's instructions. A probability at or above the threshold is a finding
   `{ check, page, text }`. Jev returns a probability, not prose, so `text` is a fixed English
   sentence per check written in the client (it fits the schema's free `text` field).
2. Fallback: Jev unavailable → the existing worker `/visual-check` (Gemini). Both unavailable → the
   existing `VISUAL_CHECK_UNAVAILABLE`, with one structured log line naming the provider and the cause.
3. `packages/inference/src/adapters/jev.decision-adapter.ts` — image assets and the header
   `TypeSafe-Danger-Zone-Images: true`, only if the adapter does not send them yet. Read
   `https://docs.typesafe.ai/api.md` for the asset shape before writing it; the adapter's current wire
   format predates image support.

### Part B — job role classification → Jev

`apps/api/src/job-sourcing/role-ai/` + `apps/api/src/extraction-worker/classify-roles.ts`: today the
worker asks a hosted model for up to 4 role ids and one confidence. Rebuild it as Jev questions over
the vacancy text (one `noul` per role id, or `choice` if a vacancy maps to one role; measure on the
fixture set and record which in Assumptions). Fallback to the worker route as in Part A.

### Part C — inventory of the remaining hosted-route calls

For every remaining hosted model call — each caller of the extraction worker (`/extract` from
`apps/api/src/job-sourcing/structuring/`, `/resume-write`, and any other caller found with
`codegraph_callers` on the worker adapter) and each direct provider call outside it (for example
the Cloudflare call in `apps/api/src/resumes/resume-ai.service.ts`) — apply the check in `jev-first.md` and write one
`Jev-first:` line per call into this file. Closed-list or yes/no fields inside a generation output
(for example vacancy `remote`) become separate Jev questions only where the inventory shows a
measurable quota saving; otherwise the line records `hosted (<why>)`. Done when every hosted model call has a
line.

## Reuse / Regression scope

**Existing code for reuse:**

- `ENTAILMENT_PROVIDER = 'jev'` client in `apps/api/src/resumes/verification/inference-clients.ts` — the
  pattern for a Jev-backed verification client.
- `DecisionPort` (`packages/inference/src/contracts/decision.ts`) and its Jev adapter.
- `findingsReplySchema` / `VisualFinding` — the finding shape the render gates already consume.

**Shared code that will be affected:**

- `VISUAL_PROVIDER` and the visual client → call-sites in `render-gates.ts` (Coder confirms via `codegraph_callers`).
- The Jev decision adapter → every `DecisionPort` consumer (relevance, entailment).

**Must not break:**

- Resume verification run: content, ATS, layout and visual gates, the staged result and the confirm step.
- Vacancy relevance and entailment calls through the same adapter.
- Role classification output consumed by job sourcing.

## Seams under test

- The visual client (input: page images; output: `VisualFinding[]` or unavailable) — Jev reply → findings mapping, threshold, fallback order.
- The Jev decision adapter request builder — image assets and header present only when the request carries images.
- The role classifier client — Jev reply → role ids, fallback.

## Acceptance criteria

Part A:

- [ ] 1. A Jev-backed visual client exists; `grep -n "TypeSafe-Danger-Zone-Images" packages/inference/src` finds the header.
- [ ] 2. Unit: a Jev reply with one probability over the threshold yields exactly one finding with the right `check` and `page`; all below → no finding.
- [ ] 3. Unit: Jev unavailable → the worker `/visual-check` is called; both unavailable → `VISUAL_CHECK_UNAVAILABLE` and one structured log line with provider + cause.
- [ ] 4. Existing relevance and entailment adapter tests pass unchanged.
- [ ] 5. PR body carries the `Jev-first:` line for the visual check.

Part B:

- [ ] 6. Role classification asks Jev first; unit tests cover the reply → role ids mapping and the fallback.
- [ ] 7. `Jev-first:` line for role classification.
- [ ] 7a. `## Assumptions` records the fixture measurement: `noul` per role vs `choice`, the fixture count and the agreement with the current classifier.

Part C:

- [ ] 8. Every hosted model call (worker callers and direct provider calls) has a `Jev-first:` line in this file.

## Assumptions

- Visual threshold starts at 0.5; tuned after the first prod runs · reversible, rollback: one constant.
- Gemini stays as the visual fallback, not removed · reversible.

## Do not touch

- `.env.extraction-worker` on prod and `EXTRACTION_ROUTER_CONFIG` — owner/ops only.
- Resume writing (`/resume-write`) prompts — generation stays on the hosted routes.

## Verification (Coder before `git push`)

1. `git diff HEAD --name-only` — only files of the part being shipped.
2. Each AC by its grep or a unit run with a non-zero test count.
3. Commit carries `ac_verified:`.
