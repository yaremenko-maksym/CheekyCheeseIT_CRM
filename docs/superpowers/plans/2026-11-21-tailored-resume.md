# Tailored Resume + Cover Letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR presses "Generate CV + CL" next to a matched senior on a `/job-queue` card. The browser downloads a CV
PDF tailored to the posting and verified against the senior's VERIFIED base resume. HR also gets a cover letter text,
can edit the generated fields (re-render, no checks), and can regenerate after a confirmation.

**Architecture:** A new module `apps/api/src/tailored-resumes/` owns the table `tailored_resumes`, the run lifecycle
(QUEUED → RUNNING → SUCCEEDED | FAILED, run-id compare-and-set, in-process `RunSlots`, a sweep cron) and the
pipeline. The pipeline reuses the verified-base-resume (VBR) gates from `apps/api/src/resumes/verification/`:
contact redaction, fact gate, Jev entailment, `renderAccepted` and `visualGate` with `VisualCheckClient`. Generation is
the only hosted-route call, through a new extraction-worker route `/resume-tailor`. Every judging call goes to Jev
(`DecisionPort`). The endpoints sit under `/job-queue/:id/seniors/:seniorId/tailored` and reuse the queue's scope and
eligibility checks. Five PRs, each inert on prod until the owner sets `TAILORED_RESUME_ENABLED=true`.

**Tech Stack:** NestJS 11 + Fastify, Drizzle (Postgres), Zod v4, `@crm/inference` (`DecisionPort`, extraction
worker transport), Typst 0.15.1 (pinned), `unpdf`, Vitest + Stryker diff gate, React + TanStack Query, Lingui (uk/en),
Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-tailored-resume-design.md` (owner-approved 2026-11-10, amended
2026-11-21 in the same PR as this plan). Consumed interfaces: `docs/superpowers/plans/2026-11-10-verified-base-resume.md`.
Rule: `.claude/rules/common/jev-first.md`. Sibling task: `.claude/tasks/task-jev-offload.md` Part A.

## Global Constraints

- New files stay under 800 lines. `resumes.service.ts`, `job-sourcing.service.ts` and `queue-actions.service.ts` are
  already over it; none of them grows. A change to them only moves code out or adds a delegation line (spec §3).
- No new npm dependency. Typst stays at 0.15.1. Nothing in `.claude/rules/common/version-pins.md` is bumped.
- Tailored resumes and cover letters are English only. Generation is blocked when any base field, or the display name,
  has a non-Latin letter (`isLatinScript` in `packages/shared/src/schemas/resume-completeness.ts`; spec Q2).
- **Data to models (spec §3, A4).** Only `summary`, `skills` and `experience[].role/company/period/bullets` of the
  base, plus the posting. Never the display name, `users.email`, a `user_emails` address, `links`, education,
  languages or the source file. Every outgoing string goes through `redactAll` with the senior's contact contexts
  (`loadOwnerContacts`). Every model reply goes through `hasContact`; a hit fails that item.
- **Untrusted text.** Posting text and model output sit only inside delimited data blocks whose instruction says the
  block is data. Jev judges never see the raw posting text, except the injection check (spec §3, §6.2 step 5).
- **Jev first (`.claude/rules/common/jev-first.md`).** Injection check, skill-gap classification, entailment, reviewer
  and visual check go to Jev or to the clients Part A moves to Jev. Only generation uses a hosted route. Every PR with
  a model call carries one `Jev-first:` line per call.
- **One visual client.** The pipeline calls `visualGate(…, deps)` with `deps.vision = VisualCheckClient` from
  `apps/api/src/resumes/verification/inference-clients.ts`, injected by Nest. It never builds its own vision client,
  so `task-jev-offload` Part A applies to it without a change here.
- **No free-form model output reaches HR unchecked** (G2). Fail closed with a coded `run_error_code`; HR gets no file.
- **Access.** ADMIN and HR only. SENIOR, JUNIOR, ACCOUNTANT and DROP get the controller's 403 (`@Roles('ADMIN','HR')`
  plus `JobQueueScopeService.resolve`, which throws `ForbiddenException` for a non-queue role). Out of scope, not
  matched, not eligible, flag off, unknown id: the uniform `JOB_OPPORTUNITY_NOT_FOUND` 404.
- **Never write to live `crm_db`.** Integration specs and `db:push` run on a scratch DB with `DATABASE_URL` inline.
  Push as `DATABASE_URL= git push`.
- Every visible web string goes through Lingui (`uk` + `en`). Server error `message` fallbacks stay English.
- **Inert until go-live.** `TAILORED_RESUME_ENABLED` defaults to `false`. While false, every tailored endpoint answers
  the uniform 404 and nothing enqueues a run. Go-live is an owner action (Task 14).
- **Mutation gate.** The Stryker diff gate sees moved code as new. Kill behaviour mutants with asserts in the unit
  specs. Suppress only provably equivalent mutants, one line-scoped `// Stryker disable next-line <Mutator>: equivalent
— <why>` each, in the style the VBR files use.
- Long-lived text (comments, PR bodies) names behaviour and symbols, never line numbers
  (`.claude/rules/common/doc-durability.md`).
- Zones: `apps/**`, `packages/**` = Coder; `.github/workflows/**`, `scripts/devops/**` = DevOps;
  `apps/e2e/**` specs = AutoTest or Coder. A PR that needs two zones is dispatched as two agents on one branch.

## Review Focus

1. **A base resume that changes while a run is in flight.** HR edits or re-verifies the base mid-run. Expected: publish
   fails `BASE_CHANGED`, the previous variant and its PDF stay, and the GET shows the hint. Test: Task 9
   `publish refuses when base version moved`.
2. **Double click, two tabs, or POST during an edit re-render.** Expected: one run only (202 with the same `runId`), and
   409 while `pdf_status` is QUEUED/RUNNING. Test: Task 11 `POST is idempotent while a run is active` and
   `POST 409 while edit re-render is in flight`.
3. **A posting with no description.** The detail is pending or failed, or the source never sends one. Expected: never a
   crash and never an empty prompt block. Pending means the button is disabled with a reason. Failed or missing means
   generation from title + `stackKeywords` with `postingPartial: true`. Test: Task 5 `prepare marks postingPartial on
missing description` and Task 11 `eligibility POSTING_PENDING`.
4. **The senior's name or email inside a base bullet or in model output.** Expected: redacted before the call; a model
   reply that contains it fails the item and is repaired or reverted. Test: Task 7 `tailor payload carries no contact`
   and Task 7 `contact in reply fails the item`.
5. **A senior who leaves the team, or a stop-listed opportunity, after a variant exists.** Expected: GET, PDF and PUT
   answer the uniform 404 (no stale access through an old row). Test: Task 11 `left senior → 404 on every verb`.

## PR split (each independently mergeable, each inert on prod)

| PR  | Branch                           | Tasks | Content                                                                                       | Reviews                                     |
| --- | -------------------------------- | ----- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `feature/tailored-resume-schema` | 1–3   | Shared schemas, table + DDL + grants + deploy wiring, env flags, module, run lifecycle, sweep | code, security (privilege class), DevOps    |
| 2   | `feature/tailored-resume-worker` | 4     | Worker route `/resume-tailor` + its API client                                                | code, **security** (PII to providers)       |
| 3   | `feature/tailored-resume-gates`  | 5–8   | Prepare, Jev analysis, generation + content gates + reviewer + content repair (pure, faked)   | code, **security** (PII, injection)         |
| 4   | `feature/tailored-resume-run`    | 9–12  | Render/visual/layout repair, publish, runner, API + RBAC + throttle + audit, edit re-render   | code, **security** (RBAC, PII), spec-review |
| 5   | `feature/tailored-resume-web`    | 13    | Web row, edit form, dialog, Lingui, E2E                                                       | code, copy-reviewer                         |

Task 14 is the owner's go-live checklist, not a PR. Merge order is 1 → 2 → 3 → 4 → 5. PR2 depends only on main, so it
may go in parallel with PR1. Each PR is merged when ready (owner standing permission 2026-11-21).

Why each PR is inert: PR1 adds an empty table that nothing writes. PR2 adds a worker route that no API code calls
(and prod runs the old worker image until the owner redeploys it). PR3 adds pure functions that no runner calls.
PR4 exposes endpoints behind `TAILORED_RESUME_ENABLED=false`, which answer 404. PR5 renders the controls only when
the list endpoint answers 200, so on prod with the flag off the row looks as it does today.

PR5 has no Claude Design mockup and no design-fidelity gate (owner 2026-11-21; redesign v2 restyles it). Its body
carries the Flow Gate skip lines `Skip-Design-Fidelity: owner decision 2026-11-21, minimal UI in the current design
system, restyled by redesign v2` and `Skip-UI-UX-Review:` with the same reason.

## Reuse map (verified on `main` @ `8082b545b`, 2026-11-21)

| Existing symbol (file)                                                                                                                                                                                     | Use                        | Generalisation needed                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `writingPayload(input: ContentInput)`, `redactAll`, `hasContact`, `splitSentences`, `groupClaims`, `toFeedback`, `payloadStatements`, `RunFailure`, `GateResult` (`resumes/verification/content-gates.ts`) | as is                      | none. The tailor payload is `writingPayload({ facts: contentToFacts(base.content), frozen: base.content, … })`: `contentToFacts` maps each base bullet to a note, index-aligned, so `sourceIndices` index `experience[i].notes`.                                                                                                                             |
| private `gateTexts(texts, source, sources, input, deps)` (`content-gates.ts`)                                                                                                                              | contact + fact + Jev       | **export it**, and take `sources: string[] \| ((index: number) => string[])` so each bullet is judged against its own `sourceIndices`. VBR callers keep passing an array. Task 7.                                                                                                                                                                            |
| private `cleaner(template)` (`content-gates.ts`)                                                                                                                                                           | normalise model text       | **export it** unchanged (NFC + font coverage, spec §6.4 item 14). Task 7.                                                                                                                                                                                                                                                                                    |
| `findUngroundedTokens(text, source: FactSource)` (`fact-gate.ts`)                                                                                                                                          | fact gate                  | none: the cover-letter source appends `employerName` and `title` to `FactSource.text` (spec §5).                                                                                                                                                                                                                                                             |
| `ResumeEntailmentClient.score(claims)` (`inference-clients.ts`)                                                                                                                                            | entailment on Jev          | none (Nest DI).                                                                                                                                                                                                                                                                                                                                              |
| `VisualCheckClient.check(pngPages)` + `visualGate(accepted, templateName, contacts, deps)` + `placeholderCopy` (`render-gates.ts`)                                                                         | visual gate                | none. Part A swaps the client's backend; this module inherits it.                                                                                                                                                                                                                                                                                            |
| `renderAccepted(plan: RenderPlan, deps: RenderDeps)` (`render-gates.ts`)                                                                                                                                   | glyph, render, ATS, layout | `RenderPlan` gains two optional fields: `maxPages?: number` (an extra page check in `measure`, next to its `MAX_PDF_PAGES` one; `checkResumeAts` keeps its own `ATS_MAX_PAGES` unchanged) and `shrinkContent?: (c: ResumeContent) => ResumeContent \| null`, tried when `shrinkLayout` returns `null`. When both are absent, behaviour is unchanged. Task 9. |
| `checkResumeAts` (`resumes/ats/resume-ats-checker.ts`)                                                                                                                                                     | through `renderAccepted`   | none.                                                                                                                                                                                                                                                                                                                                                        |
| `loadOwnerContacts(db, userId)` (`verification-runner.ts`)                                                                                                                                                 | contact contexts           | none.                                                                                                                                                                                                                                                                                                                                                        |
| `RunSlots` (`run-slots.ts`)                                                                                                                                                                                | per-process FIFO cap       | none.                                                                                                                                                                                                                                                                                                                                                        |
| `callWorker`, `workerTransport`, `unavailableReplySchema`, `unavailableOrigin` (`inference-clients.ts`)                                                                                                    | worker transport           | none.                                                                                                                                                                                                                                                                                                                                                        |
| `writingPayloadSchema`, `VISUAL_CHECKS` (`extraction-worker/link-contract.ts`)                                                                                                                             | wire contract              | new exports next to them for `/resume-tailor` (Task 4).                                                                                                                                                                                                                                                                                                      |
| `stripContacts(input)` (`job-sourcing/structuring/contact-strip.ts`)                                                                                                                                       | posting contact strip      | none.                                                                                                                                                                                                                                                                                                                                                        |
| `loadOpportunity(db, id, onDemandTypes)`, `detailFetchTargets`, `enqueueDirty(…, DETAIL_FETCH)`, `productionLedgerCatalog().onDemandTypes()`                                                               | posting + detail enqueue   | none: the same calls `openOpportunity` makes.                                                                                                                                                                                                                                                                                                                |
| `vacancyTechnologies`, `canonicalSkill`, `mentionsSkill`, `SKILL_SYNONYM_GROUPS` (`@crm/shared`)                                                                                                           | requirement extraction     | none.                                                                                                                                                                                                                                                                                                                                                        |
| `JobQueueScopeService.resolve`, `.assertVisible`; private `JobQueueActionsService.assertSeniorEligible`, `writeScope`                                                                                      | RBAC                       | **move** the private `assertSeniorEligible` to `job-sourcing/queue/senior-eligibility.ts` as an exported function (pure move; the 1 465-line service shrinks, it does not grow); export `JobQueueScopeService` from the module. `authorizeSenior` in the new module composes `resolve` + `assertVisible` + it. No SQL is copied. Task 11.                    |
| `AuditLogService.record({ actorId, targetId, action, changes }, tx?)` + `auditActionSchema`                                                                                                                | audit                      | two new `auditActionSchema` values. `user_audit_log.action` is `text`, so no DDL is needed.                                                                                                                                                                                                                                                                  |
| `ResumeTypstService.render` / `renderPng`, `ResumeTextExtractionService.countRenderedPages` / `extractRenderedPages`, `S3Service.upload` / `getObject` / `delete` / `listObjects`                          | render + storage           | none.                                                                                                                                                                                                                                                                                                                                                        |

**Not reusable, rebuilt in the module:** `ownsRun`, `failRun`, `run-columns.ts` and `sweepStalledVerifications` are
bound to `seniorResumes` and its staged columns. `writeGatedContent` / `writeGatedField` write from facts notes one
field per call, with no posting and no `sourceIndices`. The tailored module writes its own run columns, its own
claim/own/fail/publish, and its own gate loop on top of the exported primitives.

## Decisions the spec left open (A1 unless marked; each also goes into the PR body's Assumptions)

- **D1 — detail fetch cannot be awaited (spec §6.1 step 2 vs code; A2, accepted by the owner 2026-11-21).** On `main`,
  `openOpportunity` only enqueues `DETAIL_FETCH`. The consumer is the 08:30 weekday `handleDetailPass` cron, inert
  until a source is flipped to ON_DEMAND. A 10 min job cannot wait for it. Plan: when `loaded.detailPending` is true,
  eligibility is `POSTING_PENDING`, the button is disabled ("the full posting text is being fetched"), and the fetch is the one
  `openOpportunity` already enqueues when HR opens the card; the tailored GETs are read-only and never enqueue. When there is a description, generation uses it. When there
  is none and none is pending, generation uses title + `stackKeywords` with `postingPartial: true` (spec Q3 [call]).
  An inline fetch inside the job is an external GET and needs the owner's explicit "go"; it is not planned.
- **D2 — new worker route `/resume-tailor`**, not a third `task` of `/resume-write`. Its body has a posting block and
  its reply has `sourceIndices`. Neither fits `resumeWriteBodySchema` (strict, `task: 'summary' | 'bullets'`). The
  VBR wire stays byte-identical.
- **D3 — one generation call returns everything** (summary, skills, per-item bullets, cover letter). A repair call
  sends the whole payload again with feedback lines; only the failing items are taken from the new reply.
- **D4 — posting text cap 12 000 chars** after `stripContacts`, cut at the last sentence end before the cap.
  `postingTruncated: true` is recorded. This keeps the worker input (payload + posting + 20 feedback lines) under
  `MAX_WORKER_INPUT_CHARS` (50 000), and `fitTailor` (Task 5: `fitToWorker`'s trimming, budgeted with the tailor
  input, since `fitToWorker` measures `resumeWriteInput` only) then trims trailing items as VBR does.
- **D5 — base page count** comes from the base's live PDF: `S3Service.getObject(base.pdfS3Key)` →
  `countRenderedPages`, read once in prepare (spec §6.4 item 16: "read from the base, not re-rendered").
- **D6 — reviewer is Jev only** (spec §6.4 item 12 [builder]: "start with Jev only").
- **D7 — thresholds.** Injection `noul` ≥ 0.7 = anomaly. Gap `choice` confidence < 0.6 falls back to the
  deterministic bucket. Reviewer `cut` only at confidence ≥ 0.7. Entailment uses the existing `ENTAILMENT_THRESHOLD`
  (0.8).
- **D8 — cover letter length gate:** a body of 100–220 words passes; outside that range it is a feedback item. The
  greeting `Dear Hiring Team,` and the closing `Kind regards,\n<display name>` are added by the service (spec §5).
- **D9 — a confirmed visual finding feeds layout repair.** It drops the lowest-ranked bullet, re-renders and
  re-checks. At most 3 visual repair rounds (spec §6.4), so at most 4 visual checks and 8 vision calls (spec §6: 1–8).
  Each round's `renderAccepted` keeps its own layout rounds, so renders can exceed the spec's rough "1–4"; the 10 min
  deadline is the hard cap (spec §6). Then `LAYOUT_UNFIXABLE`.
  `VISUAL_CHECK_UNAVAILABLE` never repairs; it fails closed.
- **D10 — batch status endpoint** `GET /job-queue/:id/tailored?teamId&seniorIds=` (at most 200 ids per request, = `SENIORS_PAGE`). One
  request per card gives every row its state and eligibility. A per-row GET would mean up to 200 requests per card
  (`SENIORS_PAGE` in `MatchedSeniors.tsx`). Spec §9's per-senior GET stays for the detail and for polling. The batch GET is read-only (no enqueue) and uses
  set queries (one over `tailored_resumes`, one over the bases, exclusions over the id set; never a per-senior loop).
  It runs on card open and after a mutation, never on an interval. Only the per-senior GET polls, every 5 s, and only
  for a row with an active run or render.
- **D11 — flag and limits** in `apps/api/src/config/env.ts`, in the existing boolean-preprocess style:
  `TAILORED_RESUME_ENABLED` (default `false`), `TAILORED_RESUME_MAX_CONCURRENT_RUNS` (default `2`) and
  `TAILORED_RESUME_DAILY_TEAM_CAP` (default `50`).
- **D12 — throttle** `@Throttle({ default: { limit: 10, ttl: 60_000 } })` on POST and PUT (the resume upload pattern).
  The daily cap counts today's `tailored_resume_generate` audit rows (Kyiv day) whose `changes.teamId.after` is the
  scope team, or `studio` for an ADMIN studio scope. Over the cap → 429 `TAILORED_RESUME_DAILY_CAP`.
- **D13 — audit** via `AuditLogService.record` into `user_audit_log`: `targetId` = senior, actions
  `tailored_resume_generate` (POST) and `tailored_resume_edit` (PUT). `changes` holds only ids and flags
  (`opportunityId`, `teamId`, `runId` or `renderId`, `overwrite`), each in the service's `AuditChange` shape
  `{ before: null, after: <value> }`, never text. No `job_queue_actions` kind: that table
  is class B append-only with triggers, and a new kind needs DDL on it.
- **D14 — S3 keys:** prefix `tailored-resumes/<rowId>/`. Run key `…/run-<runId>.pdf`, edit key `…/edit-<renderId>.pdf`.
  The daily orphan sweep deletes objects under the prefix that no row references and that are older than 1 h.
- **D15 — file name** `<display name> - <title> - CV.pdf`. Each part is reduced to `[A-Za-z0-9 .,&()-]`, collapsed and
  cut to 80 chars, and sent as `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`.
- **D16 — DDL ships wired, not staged.** `drizzle/manual/2026-11-21_tailored_resumes.sql` is applied by the deploy
  before the grants file, class A in `PRIVILEGE_CLASSES`. The table is empty and unread until the flag flips, so
  wiring it at once is safe, and it avoids the staged-path trap of SFS U2-D/U4-D.
- **D17 — eligibility by script.** `NON_LATIN_NAME`: the display name has a letter outside Latin script.
  `NON_ENGLISH`: any field sent to the model has one (spec Q2 "any non-Latin field"). No language detector.
- **D18 — Jev down at analysis fails the run at once** (`DECISION_UNAVAILABLE`). Entailment fails closed later anyway,
  so stopping early spends no generation call.
- **D19 — generation budget 4 calls** (first + 2 content repairs + 1 cover-letter regeneration as its own attempt,
  spec §6.4; spec §6's "1–3" counts the resume attempts only, recorded in the spec amendment item 6). The cover-letter regeneration has its own slot; still failing → `COVER_LETTER_UNGROUNDED`. The worker's own retry on invalid output
  is inside one call.
- **D20 — "matched" is not checked (A2, accepted by the owner 2026-11-21; RBAC so not A1; security-reviewer mandatory).** Spec §9 asks for "the same
  eligibility check the submission path uses" and describes it as "in scope and matched". The submission path's
  `assertSeniorEligible` checks scope membership (active SENIOR, live team), opportunity existence and the senior's
  stop-list, not a match row. The plan follows the code (the spec's primary instruction). A stricter match check is a
  one-function addition in `tailored-access.ts` if the owner wants it.
- **D21 — an HR edit re-render runs the deterministic gates only** (glyph, ATS, layout knobs; edited paths never
  reverted), no visual check and no content shrink: spec §9 says "re-render only", and HR is the author of the text.

---

## Assumptions (owner decisions, 2026-11-21)

- **D1** accepted by the owner (A2): a pending detail fetch makes the row `POSTING_PENDING`; no inline external
  fetch inside the job.
- **D20** accepted by the owner (A2, RBAC): eligibility is `assertSeniorEligible` (scope membership, opportunity,
  stop-list), no match-row check. security-reviewer is mandatory on PR 4 (Task 11).

## PR 1 — schema, module, run lifecycle (inert)

### Task 1: Shared schemas, error codes, audit actions

**Files:**

- Create: `packages/shared/src/schemas/tailored-resume.ts`, `packages/shared/src/schemas/tailored-resume.spec.ts`
- Modify: `packages/shared/src/schemas/audit-log.ts` (two `auditActionSchema` values), the resume file under
  `packages/shared/src/schemas/api-errors/` (three codes), the `@crm/shared` barrel

**Interfaces:**

- Produces (all exported from `@crm/shared`):
  - `tailoredRunStatusSchema = z.enum(['QUEUED','RUNNING','SUCCEEDED','FAILED'])`
  - `tailoredRunStageSchema = z.enum(['FETCHING_POSTING','ANALYSING','TAILORING','CHECKING','RENDERING','VISUAL_CHECK'])`
    (spec §4 step 3 order)
  - `tailoredResumeErrorCodeSchema = z.enum(['BASE_NOT_VERIFIED','BASE_CHANGED','NON_ENGLISH','NON_LATIN_NAME',
'WRITER_UNAVAILABLE','DECISION_UNAVAILABLE','ENTAILMENT_UNAVAILABLE','LIMITS_EXHAUSTED','COVER_LETTER_UNGROUNDED',
'RENDER_FAILED','ATS_CHECK_FAILED','GLYPH_CHECK_FAILED','LAYOUT_UNFIXABLE','VISUAL_CHECK_FAILED',
'VISUAL_CHECK_UNAVAILABLE','STALLED','INTERNAL_ERROR'])` — every code a reused gate can throw as `RunFailure.code`
    is a member, so a caught failure maps 1:1 through `toTailoredCode` (Task 3); a VBR code outside this list maps to `INTERNAL_ERROR` (Task 10).
  - `tailoredEligibilitySchema = z.enum(['READY','NO_VERIFIED_RESUME','NON_ENGLISH','NON_LATIN_NAME','POSTING_PENDING'])`
  - `tailoredVerificationSchema`: `{ gates: { gate: string; ok: boolean; items: { path: string; reason: string }[] }[];
revertedPaths: string[]; keptFromBase: number; coverage: { matched: string[]; total: number }; gaps: string[];
injectionSuspected: boolean; postingPartial: boolean; postingTruncated: boolean; routes: string[] }`. Never posting
    text, never model text.
  - `tailoredGenerateRequestSchema = z.object({ teamId: z.string().uuid().optional(), overwrite: z.boolean() }).strict()`
  - `tailoredEditRequestSchema = z.object({ teamId: uuid.optional(), summary: z.string().max(RESUME_LIMITS.summary),
skills: z.array(short text).max(RESUME_LIMITS.skills), bullets: z.array(z.array(bullet text).min(1)
.max(RESUME_LIMITS.bulletsPerExperience)).max(RESUME_LIMITS.experience), coverLetter: z.string().min(1).max(4000)
}).strict()` — limits taken from the existing `RESUME_LIMITS` keys (spec §9: same limits as the base).
  - `tailoredListQuerySchema = z.object({ teamId: uuid.optional(), seniorIds: <comma list → uuid[], 1..200 (= SENIORS_PAGE)> })`
  - `tailoredResumeRowDto = { seniorId; eligibility; runStatus | null; runStage | null; runErrorCode | null;
published: boolean; pdfStatus: ResumeRenderStatus; baseChanged: boolean }`
  - `tailoredResumeDetailDto = tailoredResumeRowDto & { coverLetter: string | null; editable: { summary; skills;
experience: { company; role; period; bullets: string[] }[] } | null; summary: { keptFromBase; gaps; coverage;
postingPartial } | null; generatedAt: string | null; editedAt: string | null }` (spec §4 step 4 "short summary")
  - audit actions `'tailored_resume_generate'`, `'tailored_resume_edit'`
  - API error codes `TAILORED_RESUME_CONFLICT` (409), `TAILORED_RESUME_DAILY_CAP` (429),
    `TAILORED_RESUME_NOT_ELIGIBLE` (422, `details.eligibility`). Out of scope stays `JOB_OPPORTUNITY_NOT_FOUND`.

- [ ] **Step 1: Write the failing tests** in `tailored-resume.spec.ts`:
      `edit request refuses a summary one char over RESUME_LIMITS.summary`, `… refuses an item with 0 bullets`,
      `… refuses an unknown key`, `list query parses "a,b" into two uuids; accepts 200 ids; refuses 201 ids and "not-a-uuid"`,
      `error codes include every reused gate code` — each of `['WRITER_UNAVAILABLE','ENTAILMENT_UNAVAILABLE',
'RENDER_FAILED','ATS_CHECK_FAILED','GLYPH_CHECK_FAILED','LAYOUT_UNFIXABLE','VISUAL_CHECK_FAILED',
'VISUAL_CHECK_UNAVAILABLE']` `.safeParse(x).success === true`.
- [ ] **Step 2: Run** `pnpm --filter @crm/shared exec vitest run tailored-resume` — expected FAIL (module missing).
- [ ] **Step 3: Implement** the schemas; add the audit actions and API error codes in the existing files' style.
- [ ] **Step 4: Run** the same command — PASS with a non-zero case count; then `pnpm --filter @crm/shared typecheck`.
- [ ] **Step 5: Commit** `feat(shared): tailored resume schemas` (files by name).

### Task 2: Table, manual DDL, privilege class, deploy wiring, env flags

**Files:**

- Create: `apps/api/src/database/schema/tailored-resumes.ts`, `apps/api/drizzle/manual/2026-11-21_tailored_resumes.sql`,
  `apps/api/src/database/tailored-resumes-ddl.integration.spec.ts`
- Modify: the schema barrel (export), `apps/api/src/database/privileges/privilege-classes.ts` (`'tailored_resumes'` in
  class A), the files `pnpm --filter @crm/api db:privileges:generate` rewrites, `apps/api/src/config/env.ts` (+ spec),
  `apps/api/.env.example`
- Modify (DevOps agent, same branch): `.github/workflows/deploy.yml` (the hard-required manual-file list and one SCP
  step, shaped like the `2026-11-14_senior_availability.sql` entries); `scripts/devops/deploy-stack-on-vps.sh` (one
  apply block **before the grants file**, shaped like the senior_availability block: "Creates tailored_resumes
  (class A). MUST precede the grants file"); `docs/runbooks/deployment.md` (the §5 apply-order row and the §9
  Rollback manual-file list, shaped like the senior_availability entries; `check-prod-ddl-wiring.py` reads both)

**Interfaces:**

- Produces: Drizzle table `tailoredResumes`, type `TailoredResumeRow`. Columns (spec §8):
  `id uuid pk`; `jobOpportunityId → job_opportunities ON DELETE CASCADE`; `seniorUserId → users ON DELETE CASCADE`;
  `UNIQUE (job_opportunity_id, senior_user_id)`; `baseResumeId → senior_resumes ON DELETE CASCADE` (nullable until the
  first publish); `baseVersion int`; `opportunityRevision int`; `content jsonb` (`ResumeContent`, null = nothing
  published); `coverLetter text`; `layout jsonb`; `templateName text`; `verification jsonb`; run columns `runStatus`,
  `runId uuid`, `runBaseVersion int`, `runStage`, `runQueuedAt`, `runStartedAt`, `runErrorCode`,
  `runRequestedByUserId → users SET NULL`; PDF columns `pdfStatus text NOT NULL DEFAULT 'IDLE'`, `pdfRenderId uuid`,
  `pdfRenderStartedAt`, `pdfRenderError`, `pdfS3Key`, `pdfFingerprint`; `generatedByUserId`, `editedByUserId`
  (→ users SET NULL), `generatedAt`, `editedAt`, `createdAt`, `updatedAt`.
  CHECKs: run status in the 4 values or NULL; `pdf_status` in the `ResumeRenderStatus` values; QUEUED/RUNNING ⇒
  `run_id IS NOT NULL`; `(content IS NULL) = (cover_letter IS NULL)`. Partial index on `run_status` WHERE QUEUED/RUNNING.
- Produces (env, D11): `TAILORED_RESUME_ENABLED` (default `false`, same preprocess as the other boolean flags),
  `TAILORED_RESUME_MAX_CONCURRENT_RUNS` (int ≥ 1, default `2`), `TAILORED_RESUME_DAILY_TEAM_CAP` (int ≥ 1, default `50`).

- [ ] **Step 1: Write the failing DDL spec** (shape of the existing `*-ddl.integration.spec.ts`): apply the SQL to a
      scratch DB; every `getTableConfig(tailoredResumes)` column exists with the same type and nullability; the CHECKs
      refuse `run_status='DONE'`, `pdf_status='X'`, QUEUED with null `run_id`, content without cover letter; the unique
      pair refuses a second row; the file applies twice (idempotent); deleting the opportunity cascades the row.
- [ ] **Step 2: Run** it with an inline scratch `DATABASE_URL` after `SELECT current_database()` — expected FAIL.
- [ ] **Step 3: Implement** the table, the SQL (one transaction, `SET LOCAL lock_timeout` like its neighbours), the
      class-A entry, `db:privileges:generate`, and the env keys with spec cases (`unset → false`, `'true' → true`,
      `MAX_CONCURRENT_RUNS='0'` refused).
- [ ] **Step 4: Run** the DDL spec, `vitest run privilege-classes env`, and
      `python3 scripts/devops/check-prod-ddl-wiring.py` — all PASS (the file is wired and precedes the grants file).
- [ ] **Step 5: Commit** two commits by zone: `feat(api): tailored_resumes table + class A grants` (Coder) and
      `ci(deploy): apply tailored_resumes DDL before grants` (DevOps).

### Task 3: Module and run lifecycle (start, claim, own, fail, sweep)

**Files:**

- Create in `apps/api/src/tailored-resumes/`: `tailored-resumes.module.ts`, `tailored-run.ts` (+ `.spec.ts`,
  `.integration.spec.ts`), `tailored-sweep.cron.ts` (+ spec), `tailored-keys.ts` (+ spec)
- Modify: `apps/api/src/app.module.ts` (import the module)

**Interfaces:**

- Consumes: Task 2 `tailoredResumes`; `S3Service`; `ConfigService<Env, true>`.
- Produces (`tailored-run.ts`):
  - `TAILORED_RUN_DEADLINE_MS = 10 * 60_000`, `TAILORED_RENDER_DEADLINE_MS = 2 * 60_000`
  - `class TailoredRunFailure extends Error { code: TailoredResumeErrorCode; gates; origin }` and
    `toTailoredCode(c: ResumeVerificationErrorCode): TailoredResumeErrorCode` (a shared member maps to itself, any
    other to `INTERNAL_ERROR`). VBR's `RunFailure.code` is typed `ResumeVerificationErrorCode` (`content-gates.ts`)
    and is not widened. In tailored files below, `RunFailure('X')` means `TailoredRunFailure`; a VBR `RunFailure`
    from a reused gate is mapped with `toTailoredCode` (Task 10).
  - `type StartResult = { kind: 'STARTED' | 'ACTIVE'; rowId: string; runId: string } | { kind: 'CONFLICT'; reason:
'PUBLISHED' | 'RENDERING' }`
  - `startRun(db: SqlExecutor, p: { opportunityId; seniorId; userId; baseVersion: number; overwrite: boolean }):
Promise<StartResult>` — one `INSERT … ON CONFLICT (job_opportunity_id, senior_user_id) DO UPDATE … WHERE` no run is
    QUEUED/RUNNING, `pdf_status` is not QUEUED/RUNNING, and `(content IS NULL OR overwrite)`. No row returned → one read
    decides ACTIVE (returns the live `runId`) or CONFLICT. Published columns are never written here.
  - `claimRun(db, rowId, runId): Promise<TailoredResumeRow | null>` — QUEUED → RUNNING, CAS on `run_id`.
  - `ownsRun(db, rowId, runId): Promise<boolean>`; `setStage(db, rowId, runId, stage): Promise<boolean>` (CAS).
  - `failRun(deps: { db; s3: Pick<S3Service,'delete'>; logger }, rowId, runId, code, verification | null,
origin: RunOrigin | null): Promise<boolean>` — CAS → FAILED + code; published columns kept; after commit deletes
    `runPdfKey(rowId, runId)` quietly; one structured warn line (run id, code, origin), never text.
  - `isStalled(row, now, waiting: ReadonlySet<string>): boolean`; `isRenderStalled(row, now): boolean`
- Produces (`tailored-keys.ts`, D14): `tailoredPrefix(rowId)`, `runPdfKey(rowId, runId)`, `editPdfKey(rowId, renderId)`.
- Produces (`tailored-sweep.cron.ts`): `TailoredSweepCron` — `@Cron(EVERY_5_MINUTES) sweepRuns()` and
  `@Cron('50 5 * * *') sweepOrphans()` (an object listed without `LastModified` comes back as epoch 0, so it is
  re-checked with `headLastModified`; `null` → kept, as `resume-orphan-sweep.cron.ts` does); never rethrows. Until Task 10 it passes an empty `waiting` set.

- [ ] **Step 1: Write the failing unit tests:** `isStalled: RUNNING started 10 min + 1 ms ago → true; 10 min − 1 ms →
false`; `isStalled: QUEUED past deadline but runId in waiting → false`; `isStalled: SUCCEEDED → false`;
      `isRenderStalled: RUNNING 2 min + 1 ms → true`; `runPdfKey('r','u') === 'tailored-resumes/r/run-u.pdf'` and
      starts with `tailoredPrefix('r')`.
- [ ] **Step 2: Write the failing integration tests** (scratch DB): `startRun creates a QUEUED row with runBaseVersion`;
      `startRun twice while QUEUED → ACTIVE with the first runId`; `startRun on a published row, overwrite=false →
CONFLICT PUBLISHED, content unchanged`; `startRun while pdf_status RUNNING → CONFLICT RENDERING`;
      `claimRun with a stale runId → null`; `toTailoredCode: GLYPH_CHECK_FAILED → itself, a VBR-only code →
INTERNAL_ERROR`; `failRun keeps content, cover_letter and pdf_s3_key`;
      `sweepRuns fails a RUNNING run past 10 min with STALLED and keeps the published variant`;
      `sweepRuns marks an edit render RUNNING past 2 min pdf_status FAILED, pdf_s3_key kept`;
      `sweepOrphans deletes an unreferenced object older than 1 h, keeps a referenced one and a 59-min one` (fake S3); `an object listed without LastModified →
headLastModified checked, null → kept`.
- [ ] **Step 3: Run** both — expected FAIL.
- [ ] **Step 4: Implement.** The module provides the cron only; nothing calls `startRun` yet.
- [ ] **Step 5: Run** both (PASS, non-zero count), `pnpm --filter @crm/api typecheck`, ESLint MCP on new files.
- [ ] **Step 6: Commit** `feat(api): tailored resume run lifecycle (inert)`. PR body: Assumptions D11, D14, D16;
      "inert: no code path writes the table"; rollback = revert the PR (the additive DDL stays; drop only on owner
      request).

---

## PR 2 — worker route `/resume-tailor` (inert until the owner redeploys the worker)

### Task 4: Worker contract, route, API client

**Files:**

- Modify: `apps/api/src/extraction-worker/link-contract.ts` (new exports), `apps/api/src/extraction-worker/schema.ts`
  (body schema), `apps/api/src/extraction-worker/server.ts` (route), `packages/inference/src/adapters/extraction-worker.ts`
  (`'/resume-tailor'` in `ExtractionWorkerRoute` and `WORKER_ROUTES`)
- Create: `apps/api/src/extraction-worker/resume-tailor.ts` (+ spec), `apps/api/src/tailored-resumes/tailor-writer.client.ts`
  (+ spec)
- Test: `apps/api/src/extraction-worker/server.spec.ts` (new cases), the package's route-list spec

**Interfaces:**

- Produces (`link-contract.ts`):
  - `MAX_POSTING_CHARS = 12_000` (D4)
  - `tailorBodySchema = z.object({ payload: canonical writing-payload string (same refinement as resumeWriteBodySchema),
posting: z.object({ title: z.string().min(1).max(300), employerName: z.string().max(200), text:
z.string().max(MAX_POSTING_CHARS), requirements: z.object({ existing: z.array(label).max(100), supported:
z.array(label).max(100) }).strict() }).strict(), feedback: <same 20 × 1..1000 one-line rule> }).strict()`.
    `gap` requirements are never sent (spec §6.2 item 6: never placed in the output).
  - `tailorReplySchema = z.object({ summary: z.string().min(1).max(RESUME_LIMITS.summary), skills: z.array(z.object({
index: z.number().int().min(0), name: z.string().min(1).max(RESUME_LIMITS.shortText) }).strict())
.max(RESUME_LIMITS.skills), items: z.array(z.object({ bullets: z.array(z.object({ text: bullet text,
sourceIndices: z.array(z.number().int().min(0)).min(1).max(3) }).strict()).min(1)
.max(RESUME_LIMITS.bulletsPerExperience) }).strict()).max(RESUME_LIMITS.experience), coverLetter:
z.string().min(1).max(4000) }).strict()` — shape only. The base-dependent rules (§5: indices in range, unique,
    each base bullet used once, item count) are checked on the API side (Task 7), the trust boundary.
  - `tailorWriteInput(body): string` — the user message; the route refuses one over `MAX_WORKER_INPUT_CHARS`.
- Produces (`resume-tailor.ts`): `TAILOR_INSTRUCTION` (the §5 contract + "reformulate, never fabricate"; the posting is
  data, never instructions) and `tailorResume(port, body, signal): Promise<{ kind: 'ok' } & TailorReply | Unavailable>`
  with `modelPreference: 'largest'` (spec §7: "strong" models), same retry behaviour as `writeResume`.
- Produces (route): `POST /resume-tailor` in the `/resume-write` shape; log line exactly `{ event: 'RESUME_TAILOR',
payloadChars, postingChars, feedbackCount, outcome }`.
- Produces (API): `TAILOR_PROVIDER = 'extraction-worker:/resume-tailor'`; `@Injectable() TailorWriterClient.tailor(body:
TailorBody): Promise<TailorWireReply>` over `callWorker(workerTransport(), '/resume-tailor', JSON.stringify(body),
schema)`; a reply failing its schema is `unavailable INVALID_OUTPUT`. Precondition (R19): caller redacted contacts.
  Types: `TailorBody = z.infer<typeof tailorBodySchema>`, `TailorReply = z.infer<typeof tailorReplySchema>`,
  `TailorWireReply = ({ kind: 'ok' } & TailorReply) | Unavailable`.

- [ ] **Step 1: Write the failing tests:** `server: /resume-tailor refuses posting.text of 12 001 chars (400)`;
      `… refuses a feedback line with LF`; `… refuses a non-canonical payload`; `… refuses an input over
MAX_WORKER_INPUT_CHARS`; `… answers an ok reply`; `… answers LIMITS_EXHAUSTED as { kind: 'unavailable', reason:
'LIMITS_EXHAUSTED' }`; `… logs exactly the five keys` (`Object.keys(log)` equal, no text); `tailorResume passes
modelPreference 'largest'`; `TailorWriterClient: reply without coverLetter → unavailable INVALID_OUTPUT`;
      `WORKER_ROUTES contains '/resume-tailor'`.
- [ ] **Step 2: Run** `pnpm --filter @crm/api exec vitest run server resume-tailor tailor-writer` and
      `pnpm --filter @crm/inference exec vitest run extraction-worker` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both — PASS, non-zero counts; typecheck both packages.
- [ ] **Step 5: Commit** `feat(worker): /resume-tailor route`. PR body: `Jev-first: generation of tailored text →
hosted pool via the worker (writing, not judging — allowed by jev-first.md)`; "inert: no caller; prod worker
      gets the route only when the owner redeploys `crm-extraction` (Task 14)". Assumptions D2, D4. Security review: posting text and
      resume payload cross a process boundary.

---

## PR 3 — prepare, Jev analysis, generation, content gates, reviewer (inert)

### Task 5: Prepare (deterministic)

**Files:** Create in `apps/api/src/tailored-resumes/`: `tailored-prepare.ts`, `tailored-requirements.ts`,
`tailored-eligibility.ts` (each + spec; prepare also `.integration.spec.ts`).

**Interfaces:**

- Consumes: `loadOpportunity`, `productionLedgerCatalog().onDemandTypes()`, `stripContacts`, `loadOwnerContacts`,
  `writingPayload`, `contentToFacts`, `fitToWorker`, `redactAll`, `vacancyTechnologies`, `canonicalSkill`,
  `mentionsSkill`, `S3Service.getObject`, `ResumeTextExtractionService.countRenderedPages`.
- Produces:
  - `eligibilityOf(i: { base: { verificationStatus; content } | null; displayName: string; detailPending: boolean }):
TailoredEligibility` — order: `NO_VERIFIED_RESUME` → `NON_LATIN_NAME` (display name has a letter outside Latin
    script) → `NON_ENGLISH` (any payload field has a letter outside Latin script; spec Q2 "any non-Latin field") →
    `POSTING_PENDING` (D1) → `READY`.
  - `extractRequirements(text: string, stackKeywords: string[]): string[]` — canonical, deduplicated, stable order.
  - `bucketOf(req: string, base: ResumeContent): 'existing' | 'supported' | 'gap'` — in base skills (canonical) →
    existing; mentioned in a base bullet or the summary (`ResumeContent` has no technologies field) → supported; else gap.
  - `capPosting(text: string): { text: string; truncated: boolean }` — D4.
  - `fitTailor(payload: WritingPayload, posting, feedback): { payload; feedback; sentItems: number }` — `fitToWorker`'s
    trimming (trailing experience items, then feedback), but budgeted with `tailorWriteInput` (payload + posting +
    requirements), since `fitToWorker` measures `resumeWriteInput` only. Items past `sentItems` are kept from the base
    unchanged.
  - `type Bucket = 'existing' | 'supported' | 'gap'`; `type PrepareDeps = { db; s3: Pick<S3Service,'getObject'>;
extraction: Pick<ResumeTextExtractionService,'countRenderedPages'>; onDemandTypes: ReadonlySet<string> }`
  - `type PreparedRun = { base: { id; version; content: ResumeContent; templateName; layout; pdfPages: number };
contacts: readonly ContactContext[]; email: string; payload: string; posting: { title; employerName; text; partial: boolean; truncated:
boolean }; requirements: { name: string; bucket: Bucket }[]; displayName: string; sentItems: number }`
  - `prepareTailoring(deps: PrepareDeps, p: { rowId; runId; opportunityId; seniorId; runBaseVersion }):
Promise<PreparedRun>` — throws `RunFailure` `BASE_NOT_VERIFIED` / `BASE_CHANGED` (version ≠ `runBaseVersion`) /
    `NON_ENGLISH` / `NON_LATIN_NAME`. No description and none pending → `partial: true`, posting text = title +
    `stackKeywords` (spec Q3 [call]).

- [ ] **Step 1: Write the failing tests:** `extractRequirements: "JavaScript and React" yields javascript, react, not
java`; `bucketOf: base skill "Postgres" → existing for "PostgreSQL"`; `bucketOf: only in a bullet → supported`;
      `capPosting: 12 500 chars → ≤ 12 000, ends at a sentence end, truncated true; 11 999 → unchanged, false`;
      `eligibilityOf: Cyrillic display name → NON_LATIN_NAME`; `… Cyrillic bullet → NON_ENGLISH`; `… detailPending →
POSTING_PENDING`; `… no base → NO_VERIFIED_RESUME`. Integration: `prepare marks postingPartial on missing
description` (Review Focus 3); `prepare strips an email and a phone from the posting`; `prepare fails BASE_CHANGED
when the base version moved after start`; `prepare reads pdfPages from the base PDF, never renders` (render spy
      not called); `fitTailor on a resume over the worker budget trims the oldest items, sentItems < item count, and
the trimmed items keep their base bullets`.
- [ ] **Step 2: Run** `vitest run tailored-prepare tailored-requirements tailored-eligibility` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, non-zero count.
- [ ] **Step 5: Commit** `feat(api): tailored resume prepare step`.

### Task 6: Jev analysis and the chunked decision helper

**Files:** Create `apps/api/src/tailored-resumes/jev-decide.ts`, `tailored-analysis.ts`, `tailored-decision.client.ts`
(each + spec).

**Interfaces:**

- Consumes: `DecisionPort`, `decisionRequestSchema`, `MAX_DECISION_QUESTIONS`, `createJevDecisionAdapter` (the
  `ResumeEntailmentClient` constructor pattern over `JEV_API_KEY`).
- Produces:
  - `decideAll(port: DecisionPort, state: Record<string, unknown>, questions: DecisionQuestion[]): Promise<Map<string,
DecisionAnswer> | { kind: 'unavailable'; cause: string }>` — ⌈n/50⌉ sequential requests; fails closed on duplicate
    id, invalid request, thrown port, `ok: false`, answer count ≠ asked, missing / extra id, or a kind other than
    asked (the `scoreEntailment` rules, generalised). `scoreEntailment` is not changed.
  - `@Injectable() TailoredDecisionClient.decide(state, questions)` — `{ kind: 'unavailable', cause: 'NOT_CONFIGURED' }`
    without a key.
  - `INJECTION_QUESTION` (spec §6.2 item 5, verbatim), `GAP_QUESTION`, `INJECTION_THRESHOLD = 0.7`,
    `GAP_MIN_CONFIDENCE = 0.6` (D7).
  - `analysePosting(client, prepared: PreparedRun): Promise<{ injectionSuspected: boolean; requirements: { name;
bucket }[] }>` — two Jev requests, each with its own state: `injection` (noul), state `{ posting }`; `req-<i>` (choice
    `existing` / `supported` / `gap`), state `{ resume payload, requirements }` with no posting text (spec §3).
    Either unavailable →
    throws `RunFailure('DECISION_UNAVAILABLE', origin jev)`: the entailment gate would fail closed later anyway, and
    stopping here spends no generation call (D18). Injection → one warn line `TAILORED_INJECTION_SUSPECTED` with
    row id and run id only.

- [ ] **Step 1: Write the failing tests:** `decideAll: 51 questions → 2 decide calls, 50 then 1`; `… extra id →
unavailable`; `… score answer to a noul question → unavailable`; `… port throws → unavailable with the error
name`; `analysePosting: injection probability 0.7 → true; 0.69 → false`; `… gap confidence 0.59 → deterministic
bucket; 0.6 → Jev bucket`; `… unavailable → RunFailure DECISION_UNAVAILABLE`; `… the posting text never appears in
a log call` (logger spy, `JSON.stringify(calls)` lacks a marker string from the posting); `the gap request's
state lacks the posting marker string; the injection request is a separate decide call`.
- [ ] **Step 2–4: Run** `vitest run jev-decide tailored-analysis tailored-decision` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): tailored resume Jev analysis`.

### Task 7: Generation, content gates, content repair

**Files:**

- Modify: `apps/api/src/resumes/verification/content-gates.ts` — export `gateTexts` with `sources: string[] | ((index:
number) => string[])`; export `cleaner`. VBR callers unchanged.
- Create in `apps/api/src/tailored-resumes/`: `tailored-draft.ts` (validate + merge), `tailored-gates.ts`,
  `tailored-generate.ts` (repair loop), each + spec.

**Interfaces:**

- Consumes: Task 4 `TailorWriterClient`, Task 5 `PreparedRun`, Task 6 analysis, `findUngroundedTokens`, `hasContact`,
  `splitSentences`, `payloadStatements`, `toFeedback`, `ResumeEntailmentClient`, `cleaner`.
- Produces:
  - `validateTailorReply(reply: TailorReply, base: ResumeContent, sentItems: number): { ok: true; draft: TailoredDraft } | { ok: false;
feedback: string[] }` — §5 rules: item count equal to `sentItems` (items past it come from the base); per item 1..`bulletsPerExperience` bullets; `sourceIndices` 1–3,
    unique, in range of that item, each base bullet used at most once per item; skill `index` in range, `name` equal to
    the base skill or its `canonicalSkill`. Every text passes through `cleaner` first.
  - Types: `BulletRef = { item: number; bullet: number; path: string /* 'experience.<i>.bullets.<j>' */ }`;
    `TailoredDraft = { summary: string; skills: string[]; items: { bullets: { text: string; sourceIndices: number[] }[]
}[]; coverBody: string }`; `FailingItem = { path: string; reason: string /* a code or the fixed reviewer line */ }`.
  - `mergeDraft(base, draft): ResumeContent` — frozen fields copied from the base; `frozenFieldsEqual(base, merged):
boolean` asserted as gate 9.
  - `COVER_GREETING = 'Dear Hiring Team,'`, `coverClosing(displayName) = 'Kind regards,\n' + displayName` (spec §5),
    `COVER_MIN_WORDS = 100`, `COVER_MAX_WORDS = 220` (D8).
  - `gateDraft(draft, prepared, deps): Promise<{ failing: FailingItem[]; scores: … }>` — per text: `hasContact` (and the
    name / email scan of §3), fact gate (cover letter source adds `employerName` and `title` only), skills subset,
    entailment through `gateTexts` (bullet _i_ → its `sourceIndices` base bullets; summary and cover sentences →
    `payloadStatements` + `the senior is applying to <title> at <employer>`), cover length. Entailment unavailable →
    `RunFailure('ENTAILMENT_UNAVAILABLE')`.
  - `MAX_GENERATION_CALLS = 4` (D19: initial + 2 repairs + 1 cover-letter regeneration; the cover-letter
    regeneration has its own slot, still failing → `COVER_LETTER_UNGROUNDED`). The worker's own invalid-output retry
    is inside the call, not counted.
  - `generateVerified(prepared, analysis, deps): Promise<{ content: ResumeContent; coverBody: string; verification:
Partial<TailoredVerification>; changedBullets: BulletRef[] }>` — generate → validate (invalid twice → `RunFailure
('WRITER_UNAVAILABLE', INVALID_OUTPUT)`) → gates → reviewer (Task 8) → repair with gate + `rewrite` feedback → after
    the last attempt revert: bullet → its source bullets, each as its own bullet; summary → base summary; cover sentence
    removed; more than half of cover sentences removed → one regeneration of the letter; still failing →
    `COVER_LETTER_UNGROUNDED`. `keptFromBase` = number of reverted items. Writer `LIMITS_EXHAUSTED` →
    `RunFailure('LIMITS_EXHAUSTED')`, any other unavailable → `WRITER_UNAVAILABLE`.

- [ ] **Step 1: Write the failing tests:** `content-gates: gateTexts with a sources function judges text i against
sources(i)` and the existing VBR specs stay green; `validateTailorReply refuses sourceIndices [0,0]`, `… index 5 in
a 3-bullet item`, `… base bullet 1 used by two output bullets`, `… one item fewer`, `… skill rename to a
non-synonym`; `mergeDraft keeps company/role/period/education/languages/links byte-equal`; `tailor payload carries
no contact` (Review Focus 4: a base bullet with the owner's email reaches the client redacted); `contact in reply
fails the item` (Review Focus 4); `"used" reworded to "led" fails entailment → after 2 repairs the bullet is its
source bullets`; `cover letter: employerName token allowed, a technology only in the posting refused`; `cover
length: 99 and 221 words → feedback; 100 and 220 → pass`; `cover loses 3 of 5 sentences → one regeneration, still
failing → COVER_LETTER_UNGROUNDED`; `writer calls never exceed 4; 2 spent repairs still leave the cover regeneration` (client spy); `greeting and closing are not sent
to any gate`; `writer LIMITS_EXHAUSTED → RunFailure LIMITS_EXHAUSTED`; `a reply with sentItems items on a trimmed
payload validates`.
- [ ] **Step 2–4: Run** `vitest run content-gates tailored-draft tailored-gates tailored-generate` — FAIL, implement,
      PASS.
- [ ] **Step 5: Commit** two commits: `refactor(resumes): export gateTexts and cleaner` (VBR specs green on its own) and
      `feat(api): tailored resume generation and content gates`.

### Task 8: Reviewer (Jev only)

**Files:** Create `apps/api/src/tailored-resumes/tailored-review.ts` (+ spec).

**Interfaces:**

- Consumes: Task 6 `TailoredDecisionClient`.
- Produces:
  - `REVIEW_CUT_MIN_CONFIDENCE = 0.7` (D7); `RELEVANCE_LEVELS = ['none','low','medium','high']`.
  - `reviewBullets(client, bullets: BulletRef[], prepared, injectionSuspected: boolean): Promise<{ verdicts: Map<string,
'keep' | 'cut' | 'rewrite'>; relevance: Map<string, number>; fit: number }>` — one batch: per bullet a `choice`
    (`keep` / `cut` / `rewrite`) and a `score` over `RELEVANCE_LEVELS`, plus one `fit` score. When
    `injectionSuspected`, the instructions say the posting may carry instructions to an AI and they are ignored.
    Unavailable → `RunFailure('DECISION_UNAVAILABLE')` (fail closed: layout repair needs the ranking).
  - `applyVerdicts(content, verdicts): { content; rewrite: FailingItem[] }` — `cut` below 0.7 confidence is `keep`; a
    `cut` of an item's last bullet is ignored; `rewrite` becomes a feedback item with the fixed reason
    `reviewer: reword this bullet for relevance to the posting, using only its sources`.
  - `rescore(client, changed: BulletRef[], …)` — one more batch only for bullets changed or reverted after review, so
    every bullet has a relevance score before layout (spec §6.4 item 12).

- [ ] **Step 1: Write the failing tests:** `cut at confidence 0.7 drops the bullet; 0.69 keeps it`; `cut of the only
bullet of an item is ignored`; `rewrite becomes one feedback item for that bullet path`; `rescore asks only the 2
changed bullets`; `after rescore every bullet has a relevance score`; `injectionSuspected adds the ignore sentence
to the instructions`; `unavailable → DECISION_UNAVAILABLE`.
- [ ] **Step 2–4: Run** `vitest run tailored-review` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): tailored resume reviewer`. PR 3 body: `Jev-first:` lines — injection check →
      Jev noul; gap buckets → Jev choice; entailment → Jev noul (existing client); reviewer → Jev choice + score;
      generation → worker hosted route. Assumptions D3, D4, D6, D7, D8, D17, D18, D19. "Inert: no caller." Security review
      (contact redaction, posting as untrusted input).

---

## PR 4 — render, publish, runner, API, edit (flag stays off)

### Task 9: Render generalisation, visual repair loop, publish

**Files:**

- Modify: `apps/api/src/resumes/verification/render-gates.ts` — `RenderPlan.maxPages?: number` (the page limit
  `measure` adds next to its `MAX_PDF_PAGES` check; `checkResumeAts` is not touched) and `RenderPlan.shrinkContent?: (c: ResumeContent) => ResumeContent | null`
  and `RenderPlan.maxContentDrops?: number` (its own budget, outside `MAX_REPAIR_ROUNDS`: once the layout knobs are
  spent, `shrinkLayout` returning `null` or the rounds used, `shrinkContent` runs up to `maxContentDrops` times, each
  re-rendered and re-measured; then `LAYOUT_UNFIXABLE`). All absent → today's behaviour.
- Create in `apps/api/src/tailored-resumes/`: `tailored-render.ts`, `tailored-publish.ts` (+ spec,
  `.integration.spec.ts`).

**Interfaces:**

- Consumes: `renderAccepted`, `visualGate`, `lastPageUnderfilled` (the §6.4 item 16 fill rule is already in `measure`:
  the [builder] measure is answered by the existing `MIN_LAST_PAGE_FILL = 0.25` line-count rule, not Typst `query`),
  Task 3 keys and CAS helpers, Task 8 relevance.
- Produces:
  - `dropLowest(content, relevance: Map<string, number>): ResumeContent | null` — removes the lowest-scored bullet;
    never an item's last bullet; tie → the later item, then the later bullet; `null` when nothing can go.
  - `tailoredPageLimit(basePages: number) = Math.min(2, basePages)` (spec §6.4 item 16).
  - `MAX_CONTENT_DROPS = 6` (layout drops, separate from the 3 layout rounds).
  - `MAX_VISUAL_ROUNDS = 3` (D9: at most 4 visual checks = 8 vision calls).
  - `renderVerified(content, prepared, relevance, deps: RenderDeps): Promise<{ accepted: Accepted; visual: GateResult
}>` — `renderAccepted({ …, notes: base content (the revert target of §6.4 item 14), fallbacks: [], editedPaths: [],
maxPages, shrinkContent: (c) => dropLowest(c, relevance), maxContentDrops: MAX_CONTENT_DROPS })` → `visualGate`; a caught `VISUAL_CHECK_FAILED` with
    rounds left → `dropLowest` → again; `dropLowest` null or rounds spent → `RunFailure('LAYOUT_UNFIXABLE')` carrying
    the visual items. `VISUAL_CHECK_UNAVAILABLE` and every other failure pass through (fail closed).
  - `publishRun(deps: { db; s3; logger }, p: { rowId; runId; runBaseVersion; result: RunResult /* { accepted: Accepted; coverLetter: string; verification:
TailoredVerification; baseResumeId; baseVersion; opportunityRevision; templateName } */ }): Promise<'PUBLISHED' |
'LOST' | 'BASE_CHANGED'>` — upload `runPdfKey` first (`S3Service.upload(key, pdf, 'application/pdf', 'RESUME')`); then one transaction: lock the row, CAS `run_id` + RUNNING;
    base row `FOR SHARE`, VERIFIED at `runBaseVersion` or `BASE_CHANGED` (run FAILED, nothing published); write every
    published column, `run_status` SUCCEEDED, `pdf_status` READY, a fresh `pdf_render_id`, `generated_by_user_id =
run_requested_by_user_id`. After commit: delete the previous `pdf_s3_key`. `LOST` / `BASE_CHANGED`: delete the
    run's own object.

- [ ] **Step 1: Write the failing tests:** `renderAccepted without maxPages/shrinkContent: existing specs unchanged`;
      `renderAccepted with maxPages 1 renders 2 pages → shrinkContent called only after shrinkLayout returns null`;
      `overflow by 3 bullets after the knobs are spent → 3 drops → accepted`; `needs 7 drops with maxContentDrops 6 →
LAYOUT_UNFIXABLE`;
      `dropLowest never drops an item's last bullet`; `dropLowest tie → later item`; `renderVerified: one confirmed
finding → one bullet dropped, re-rendered, passes`; `… 4th confirmed finding → LAYOUT_UNFIXABLE`;
      `… VISUAL_CHECK_UNAVAILABLE → thrown, no drop`; `… vision calls ≤ 8` (spy). Integration:
      `publish refuses when base version moved` (Review Focus 1: content and pdf_s3_key unchanged, run FAILED
      BASE_CHANGED, run object deleted); `publish after the sweep took the run → LOST, own object deleted`;
      `publish sets a fresh pdf_render_id`; `previous PDF deleted after commit, never before` (call-order spy).
- [ ] **Step 2–4: Run** `vitest run render-gates tailored-render tailored-publish` — FAIL, implement, PASS; the VBR
      `verification-runner` specs stay green.
- [ ] **Step 5: Commit** `refactor(resumes): optional page limit and content shrink in renderAccepted` and
      `feat(api): tailored resume render and publish`.

### Task 10: Runner (stages, slots, failure mapping)

**Files:** Create `apps/api/src/tailored-resumes/tailored-runner.ts` (+ spec); modify `tailored-sweep.cron.ts` (pass
`runner.waitingRunIds()`), `tailored-resumes.module.ts` (providers).

**Interfaces:**

- Consumes: Tasks 3, 5–9.
- Produces: `@Injectable() TailoredRunner` with `enqueue(rowId: string, runId: string): void` (fire-and-forget through
  `RunSlots(TAILORED_RESUME_MAX_CONCURRENT_RUNS)`), `waitingRunIds(): ReadonlySet<string>`, and `run(rowId, runId):
Promise<void>`: `claimRun` → `setStage` FETCHING_POSTING (prepare) → ANALYSING → TAILORING (first generation) →
  CHECKING (gates, reviewer, repair, rescore) → RENDERING → VISUAL_CHECK → `publishRun`. `setStage` false = lost,
  stop silently. `RenderDeps.beforeModelCall` = `ownsRun` or throw `RunLost`. `TailoredRunFailure` → `failRun(code)`; a VBR `RunFailure` →
  `failRun(toTailoredCode(code))`;
  `RunLost` → nothing; any other error → `failRun('INTERNAL_ERROR')` with the error class in the log, never its
  message. `verification.routes` lists the providers used (`TAILOR_PROVIDER`, `jev`, `VISUAL_PROVIDER`).
  `coverageOf(content: ResumeContent, requirements): { matched: string[]; total: number }` — spec §6.4 item 15, on
  the final text after every drop: of the `existing` / `supported` requirements, those `mentionsSkill` finds in
  summary, skills or bullets; `gaps` = the `gap` names. Information only; nothing re-generates on it.

- [ ] **Step 1: Write the failing tests:** `run walks the six stages in order` (setStage spy); `a VBR RunFailure
GLYPH_CHECK_FAILED from renderAccepted → FAILED GLYPH_CHECK_FAILED`;
      `writer LIMITS_EXHAUSTED → FAILED LIMITS_EXHAUSTED, published columns untouched`; `setStage false → no further
write, no model call`; `third enqueue with cap 2 waits and is in waitingRunIds until it starts`; `unexpected
TypeError → FAILED INTERNAL_ERROR, log carries "TypeError" and no message`; `beforeModelCall throws RunLost after
the sweep changed run_id`; `coverage is computed after layout drops: a dropped bullet's only mention leaves
matched`; `gap requirements are never in matched`.
- [ ] **Step 2–4: Run** `vitest run tailored-runner tailored-sweep` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): tailored resume runner`.

### Task 11: API, RBAC, eligibility

**Files:**

- Create: `apps/api/src/job-sourcing/queue/senior-eligibility.ts` — **move** `assertSeniorEligible` out of
  `queue-actions.service.ts` (1 465 lines; the move shrinks it) as `assertSeniorEligible(scopes: JobQueueScopeService,
tx, scope, seniorId, opportunity, refuse = notFound): Promise<void>`; both service call sites call it. Body
  unchanged (pure move).
- Modify: `apps/api/src/job-sourcing/job-sourcing.module.ts` — export `JobQueueScopeService`.
- Create in `apps/api/src/tailored-resumes/`: `tailored-resumes.controller.ts`, `tailored-resumes.service.ts`,
  `tailored-access.ts`, `tailored-filename.ts` (each + spec), `tailored-resumes.rbac.integration.spec.ts`,
  `tailored-resumes.service.integration.spec.ts`.

**Interfaces:**

- Produces (`tailored-access.ts`): `authorizeSenior(scopes, user, opportunityId, seniorId, teamId, tx):
Promise<WriteScope>` — `resolve` (role outside ADMIN/HR → 403), NONE → 404, `assertVisible`, `assertSeniorEligible`.
  Every miss is the one `JOB_OPPORTUNITY_NOT_FOUND` 404. `visibleSeniors(scopes, scope, opportunityId, ids, tx):
Promise<string[]>` — ids ∩ `liveVersions(scope)`, minus seniors whose own exclusion matches the opportunity (same
  `findMatchingExclusion`); ids outside are omitted from the answer, never reported.
- Produces (controller, `@UseGuards(RolesGuard) @Controller('job-queue')`, every route `@Roles('ADMIN','HR')`):
  - `GET :id/tailored?teamId&seniorIds=` → `tailoredResumeRowDto[]` (D10); read-only: never enqueues (the card's `openOpportunity`
    call already enqueues `DETAIL_FETCH`, D1); set queries, never a per-senior loop.
  - `POST :id/seniors/:seniorId/tailored` → 202 `{ runId }` | 409 `TAILORED_RESUME_CONFLICT` | 422
    `TAILORED_RESUME_NOT_ELIGIBLE` | 429. One transaction: authorize → eligibility → an active run returns 202 with it (before the cap, so a double click at
    the cap is still idempotent) → daily cap → `startRun` → audit;
    `runner.enqueue` after commit, only for STARTED.
  - `GET :id/seniors/:seniorId/tailored` → `tailoredResumeDetailDto`; `baseChanged` = the base version or the
    opportunity revision differs from the row's.
  - `GET :id/seniors/:seniorId/tailored/pdf` → the PDF; 202 while `pdf_status` QUEUED/RUNNING or a run is active with
    nothing published; 404 when nothing is published and no run is active (spec §9).
  - `PUT :id/seniors/:seniorId/tailored` → Task 12.
  - `TAILORED_RESUME_ENABLED` false → every route answers the uniform 404 before any query.
- Produces (`tailored-filename.ts`, D15): `tailoredFilename(displayName, title): { ascii: string; utf8: string }`.

- [ ] **Step 1: Write the failing RBAC integration tests** (real Nest app, scratch DB, flag on):
      `HR outside scope → 404 JOB_OPPORTUNITY_NOT_FOUND on POST, GET, GET pdf, PUT, batch GET omits the senior`;
      `out-of-scope and unknown opportunity answer byte-equal bodies`; `SENIOR, JUNIOR, ACCOUNTANT → 403 on all five
routes`; `left senior → 404 on every verb` (Review Focus 5); `stop-listed senior → 404 on every verb`;
      `malformed seniorId → 404, not 500`; `ADMIN studio scope → 202`; `flag off → 404 on all routes for ADMIN`.
- [ ] **Step 2: Write the failing service tests:** `POST is idempotent while a run is active` (Review Focus 2: two
      POSTs → same runId, enqueue called once, one audit row); `POST 409 while edit re-render is in flight` (Review
      Focus 2); `POST with a published variant and overwrite=false → 409`; `team at the cap + an active run → POST answers 202
with that run, not 429`; `eligibility POSTING_PENDING → 422 with
details.eligibility, and the batch GET enqueued nothing`; `batch GET for 200 seniors runs a fixed number of queries` (Review Focus 3); `GET pdf: 202 during the
first run; previous PDF served during a regenerate; 404 when nothing exists`; `tailoredFilename strips "/",
quotes and CR/LF, cuts at 80`.
- [ ] **Step 3: Run** `vitest run tailored-resumes tailored-access tailored-filename queue-actions` — FAIL (the
      existing queue-actions specs stay green after the move).
- [ ] **Step 4: Implement**, run again — PASS, non-zero count.
- [ ] **Step 5: Commit** `refactor(job-queue): move assertSeniorEligible to its own file` and
      `feat(api): tailored resume API`.

### Task 12: Edit re-render, throttle, daily cap, audit

**Files:** Create `apps/api/src/tailored-resumes/tailored-edit.ts`, `tailored-cap.ts` (each + spec, + integration);
modify the controller and service.

**Interfaces:**

- Produces:
  - `applyEdit(db, p: { rowId; userId; edit: TailoredEditRequest }): Promise<{ renderId } | null>` — one
    transaction: `SELECT … FOR UPDATE` the row; `content` null, a run QUEUED/RUNNING or `pdf_status` QUEUED/RUNNING
    → `null`; item count or order not equal → 400; merge the edited fields over the snapshot `content`; then a
    conditional `UPDATE … WHERE` the run and the render are still not active (CAS), writing the merged `content`,
    `edited_by_user_id`, `edited_at`, `pdf_status` RUNNING (claimed in the same step, so Task 3's RUNNING-past-2-min
    sweep covers a restart), a fresh `pdf_render_id` and `pdf_render_started_at`. No row updated → `null` → 409.
  - `renderEdit(deps, rowId, renderId): Promise<void>` (after commit) — `renderAccepted` with every edited path in
    `editedPaths` (never silently reverted), no `shrinkContent`, no visual check (D21: HR is the author; only
    deterministic gates). Upload `editPdfKey` (category `'RESUME'`); CAS on `pdf_render_id` → READY + new key, delete the previous after
    commit; lost → delete its own object; failure → `pdf_status` FAILED, `pdf_render_error` = code, previous key kept.
  - `assertUnderDailyCap(db, scopeKey: string /* teamId | 'studio' */, cap: number, now: Date): Promise<void>` —
    takes `pg_advisory_xact_lock(hashtext('tailored-cap:' || scopeKey))` in the POST transaction, then counts
    today's `tailored_resume_generate` rows (Kyiv day) for the key; at `cap` → 429 `TAILORED_RESUME_DAILY_CAP`
    (D12).
  - `@Throttle({ default: { limit: 10, ttl: 60_000 } })` on POST and PUT.
  - Audit (D13): `AuditLogService.record({ actorId, targetId: seniorId, action, changes }, tx)` in the same
    transaction; `changes` keys only `opportunityId`, `teamId`, `runId` | `renderId`, `overwrite`.

- [ ] **Step 1: Write the failing tests:** `PUT while a run is QUEUED → 409, content unchanged`; `PUT keeps the unedited fields of the snapshot`;
      `two concurrent PUTs → one renderId, the other 409`; `edit render left RUNNING by a restart → FAILED by the sweep
after 2 min, previous pdf_s3_key kept`; `PUT with one item
fewer → 400`; `a late older edit render is dropped and its object deleted`; `edit ATS failure on an edited path →
pdf_status FAILED, previous pdf_s3_key kept`; `11th POST in 60 s → 429`; `team at 49 today → POST passes; at 50
→ 429 TAILORED_RESUME_DAILY_CAP`; `two concurrent POSTs at 49 → one 202, one 429`; `ADMIN studio POSTs count under "studio", not under a team`; `a row written at
23:59 Kyiv time does not count the next day`; `audit row keys ⊆ {opportunityId, teamId, runId, overwrite}, no
text`; `no audit row on 404, 409, 422 or 429`.
- [ ] **Step 2–4: Run** `vitest run tailored-edit tailored-cap tailored-resumes` — FAIL, implement, PASS.
- [ ] **Step 5: Commit** `feat(api): tailored resume edit, throttle, daily cap, audit`. PR 4 body: `Jev-first:` lines
      (visual check → `VisualCheckClient`, inherits task-jev-offload Part A; entailment and reviewer → Jev;
      generation → worker); Assumptions D1, D5, D9, D10, D12–D15, D20, D21; "flag `TAILORED_RESUME_ENABLED` stays false
      on prod: every route 404s". **security-reviewer mandatory** (RBAC, PII in PDFs, audit) + spec-reviewer.

### Mutation gate (PRs 1–4)

The diff gate mutates every changed line. Each threshold has a boundary pair in the tests above (0.7 / 0.69, 0.6 /
0.59, 99 / 100 / 220 / 221 words, 49 / 50 cap, 10 min ± 1 ms, 2 min + 1 ms, 12 000 chars, 51 questions). Each CAS has
a stale-id test. Moved code (Task 11) counts as new: kill its mutants through the existing queue-actions specs; an
equivalent mutant gets a line-scoped `Stryker disable next-line <mutator>: equivalent — <why>`, never a file-wide one.
The base is the current `origin/main`.

---

## PR 5 — web UI (minimal; flag on only in E2E)

### Task 13: Controls in `MatchedSeniors`, edit dialog, E2E

**Files:**

- Create in `apps/web/app/components/job-queue/`: `TailoredResumeControls.tsx`, `TailoredResumeEditDialog.tsx`,
  `useTailoredResumes.ts`, `__tests__/TailoredResumeControls.test.tsx`
- Modify: `MatchedSeniors.tsx` (one `<TailoredResumeControls>` per `SeniorBlock`; one batch query per card, D10), the
  Lingui catalogs (`pnpm i18n:extract`, `uk` + `en`)
- Create: `apps/e2e/tests/tailored-resume.spec.ts`
- Modify (DevOps): `.github/workflows/ci.yml`, add the new spec to one E2E shard;
  `python3 scripts/devops/check-e2e-shard-coverage.py` must PASS
- Modify (DevOps): the E2E job's API env sets `TAILORED_RESUME_ENABLED=true`

**Interfaces:**

- Consumes: Task 1 DTOs, Task 11–12 routes.
- Produces: `useTailoredRows(opportunityId, teamId, seniorIds)` (TanStack Query; one request for up to 200 seniors, on card open
  and after a mutation, never on an interval); `useTailoredDetail` (per-senior GET, polled every 5 s only while that
  row's run or render is QUEUED/RUNNING, stopped otherwise); `useGenerateTailored`; `useEditTailored`. Not in the
  persisted-query allow-list (PII). A 404 on the batch GET (flag off on prod until Task 14) renders no controls, no
  error UI and no refetch: PR 5 is inert-safe on its own.
- UI (spec §4): button `Згенерувати CV і лист` (READY, nothing published); stage line per `runStage`; on SUCCEEDED the
  PDF downloads once (anchor with the server's file name), `Копіювати лист` copies the cover letter; after an edit Save the per-senior GET is polled until `pdfStatus`
  is READY with the new render, then the PDF downloads once (spec §4 step 6); `Редагувати`
  opens the dialog (summary, skills, bullets per item, cover letter; client-side limits from `RESUME_LIMITS`);
  `Перегенерувати` opens a confirm dialog with the spec text ("This replaces the current CV and cover letter,
  including your edits"); a disabled button with the eligibility reason otherwise; `runErrorCode` as a localized
  message; "base changed" hint. `en` strings written by the Coder, checked by copy-reviewer.

- [ ] **Step 1: Write the failing component tests:** `READY row shows the generate button`; `200 seniors → one batch request, no batch refetch on an interval`;
      `edit save → one download after READY with the new render`; `POSTING_PENDING row shows
a disabled button with the reason`; `RUNNING row shows the stage text and no button`; `SUCCEEDED transition
triggers one download, not one per poll`; `copy writes the cover letter to the clipboard`; `regenerate asks for
confirmation and sends overwrite: true`; `edit dialog refuses a summary over RESUME_LIMITS.summary`; `batch GET 404 → no controls, no error text, no
refetch` (flag off).
- [ ] **Step 2: Write the E2E** (`playwright-patterns`): HR on `/job-queue` → card → generate (network mocked with
      `page.route` for POST and the progress GETs) → stage text → download event with a `.pdf` name → copy → edit →
      save → regenerate confirm. One unmocked assertion: the batch GET answers 200 for HR on the real stack.
- [ ] **Step 3: Run** `pnpm --filter @crm/web exec vitest run TailoredResumeControls` and the E2E locally — FAIL, then
      implement, then PASS (non-zero counts); `pnpm --filter @crm/web typecheck`, ESLint MCP.
- [ ] **Step 4: Commit** `feat(web): tailored resume controls`. PR body: `Skip-Design-Fidelity:` and
      `Skip-UI-UX-Review:` with the owner decision 2026-11-21; responsive check at mobile / tablet / laptop (the
      dialog); copy-reviewer for `uk` + `en`.

---

## Task 14: Go-live (owner, after PR 5 merges)

- [ ] Owner redeploys the extraction worker (`crm-extraction`) so `/resume-tailor` exists on prod.
- [ ] Owner sets `TAILORED_RESUME_ENABLED=true` on the API (defaults keep the caps at 2 runs and 50 a day per team).
- [ ] manual-qa on prod: one HR generates for one senior, downloads, edits, regenerates; an HR of another team gets 404. Rollback: set the flag to `false` (every route 404s; rows stay).

## Self-review

- Spec coverage: §4 flow → Tasks 11–13; §5 contract → Tasks 4, 7; §6.1 → 5; §6.2 → 6; §6.3 → 4, 7; §6.4 item 15 (coverage) → 10; gates 9–12 →
  7, 8; 13–18 → 9; §6.5 → 9; §7 → generation over the worker (Task 4), vision and entailment inherited, no package
  change but the route name; §8 → 2; §9 → 11, 12. §7's Cloudflare and OpenRouter `:free` routes are in the worker pool on `main` (CF chain), not
  rebuilt.
- Type names checked across tasks: `PreparedRun`, `TailoredDraft`, `RunResult`, `StartResult`, `TailorBody` /
  `TailorReply`, `TailoredVerification`.
- Proportion: signatures, test names and spec values only; no bodies.

<!-- tasks end -->
