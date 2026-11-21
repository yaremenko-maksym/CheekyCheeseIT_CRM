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
   reply that contains it fails the item and is repaired or reverted. Test: Task 6 `tailor payload carries no contact`
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

| Existing symbol (file)                                                                                                                                                                                                    | Use                        | Generalisation needed                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writingPayload(input: ContentInput)`, `fitToWorker`, `redactAll`, `hasContact`, `splitSentences`, `groupClaims`, `toFeedback`, `payloadStatements`, `RunFailure`, `GateResult` (`resumes/verification/content-gates.ts`) | as is                      | none. The tailor payload is `writingPayload({ facts: contentToFacts(base.content), frozen: base.content, … })`: `contentToFacts` maps each base bullet to a note, index-aligned, so `sourceIndices` index `experience[i].notes`.                         |
| private `gateTexts(texts, source, sources, input, deps)` (`content-gates.ts`)                                                                                                                                             | contact + fact + Jev       | **export it**, and take `sources: string[] \| ((index: number) => string[])` so each bullet is judged against its own `sourceIndices`. VBR callers keep passing an array. Task 7.                                                                        |
| private `cleaner(template)` (`content-gates.ts`)                                                                                                                                                                          | normalise model text       | **export it** unchanged (NFC + font coverage, spec §6.4 item 14). Task 7.                                                                                                                                                                                |
| `findUngroundedTokens(text, source: FactSource)` (`fact-gate.ts`)                                                                                                                                                         | fact gate                  | none: the cover-letter source appends `employerName` and `title` to `FactSource.text` (spec §5).                                                                                                                                                         |
| `ResumeEntailmentClient.score(claims)` (`inference-clients.ts`)                                                                                                                                                           | entailment on Jev          | none (Nest DI).                                                                                                                                                                                                                                          |
| `VisualCheckClient.check(pngPages)` + `visualGate(accepted, templateName, contacts, deps)` + `placeholderCopy` (`render-gates.ts`)                                                                                        | visual gate                | none. Part A swaps the client's backend; this module inherits it.                                                                                                                                                                                        |
| `renderAccepted(plan: RenderPlan, deps: RenderDeps)` (`render-gates.ts`)                                                                                                                                                  | glyph, render, ATS, layout | `RenderPlan` gains two optional fields: `maxPages?: number` (default `MAX_PDF_PAGES`) and `shrinkContent?: (c: ResumeContent) => ResumeContent \| null`, tried when `shrinkLayout` returns `null`. When both are absent, behaviour is unchanged. Task 9. |
| `checkResumeAts` (`resumes/ats/resume-ats-checker.ts`)                                                                                                                                                                    | through `renderAccepted`   | none.                                                                                                                                                                                                                                                    |
| `loadOwnerContacts(db, userId)` (`verification-runner.ts`)                                                                                                                                                                | contact contexts           | none.                                                                                                                                                                                                                                                    |
| `RunSlots` (`run-slots.ts`)                                                                                                                                                                                               | per-process FIFO cap       | none.                                                                                                                                                                                                                                                    |
| `callWorker`, `workerTransport`, `unavailableReplySchema`, `unavailableOrigin` (`inference-clients.ts`)                                                                                                                   | worker transport           | none.                                                                                                                                                                                                                                                    |
| `writingPayloadSchema`, `VISUAL_CHECKS` (`extraction-worker/link-contract.ts`)                                                                                                                                            | wire contract              | new exports next to them for `/resume-tailor` (Task 4).                                                                                                                                                                                                  |
| `stripContacts(input)` (`job-sourcing/structuring/contact-strip.ts`)                                                                                                                                                      | posting contact strip      | none.                                                                                                                                                                                                                                                    |
| `loadOpportunity(db, id, onDemandTypes)`, `detailFetchTargets`, `enqueueDirty(…, DETAIL_FETCH)`, `productionLedgerCatalog().onDemandTypes()`                                                                              | posting + detail enqueue   | none: the same calls `openOpportunity` makes.                                                                                                                                                                                                            |
| `vacancyTechnologies`, `canonicalSkill`, `mentionsSkill`, `SKILL_SYNONYM_GROUPS` (`@crm/shared`)                                                                                                                          | requirement extraction     | none.                                                                                                                                                                                                                                                    |
| `JobQueueScopeService.resolve`, `.assertVisible`; private `JobQueueActionsService.assertSeniorEligible`, `writeScope`                                                                                                     | RBAC                       | one new **public** method on `JobQueueActionsService`, `authorizeSenior(user, opportunityId, seniorId, teamId, tx)`, composed of the private ones. No SQL is copied. Task 11.                                                                            |
| `AuditLogService.record({ actorId, targetId, action, changes }, tx?)` + `auditActionSchema`                                                                                                                               | audit                      | two new `auditActionSchema` values. `user_audit_log.action` is `text`, so no DDL is needed.                                                                                                                                                              |
| `ResumeTypstService.render` / `renderPng`, `ResumeTextExtractionService.countRenderedPages` / `extractRenderedPages`, `S3Service.upload` / `getObject` / `delete` / `listObjects`                                         | render + storage           | none.                                                                                                                                                                                                                                                    |

**Not reusable, rebuilt in the module:** `ownsRun`, `failRun`, `run-columns.ts` and `sweepStalledVerifications` are
bound to `seniorResumes` and its staged columns. `writeGatedContent` / `writeGatedField` write from facts notes one
field per call, with no posting and no `sourceIndices`. The tailored module writes its own run columns, its own
claim/own/fail/publish, and its own gate loop on top of the exported primitives.

## Decisions the spec left open (A1 unless marked; each also goes into the PR body's Assumptions)

- **D1 — detail fetch cannot be awaited (spec §6.1 step 2 vs code; A2, in the decision brief).** On `main`,
  `openOpportunity` only enqueues `DETAIL_FETCH`. The consumer is the 08:30 weekday `handleDetailPass` cron, inert
  until a source is flipped to ON_DEMAND. A 10 min job cannot wait for it. Plan: when `loaded.detailPending` is true,
  eligibility is `POSTING_PENDING`, the button is disabled ("the full posting text is being fetched"), and the list
  GET enqueues the fetch the way `openOpportunity` does. When there is a description, generation uses it. When there
  is none and none is pending, generation uses title + `stackKeywords` with `postingPartial: true` (spec Q3 [call]).
  An inline fetch inside the job is an external GET and needs the owner's explicit "go"; it is not planned.
- **D2 — new worker route `/resume-tailor`**, not a third `task` of `/resume-write`. Its body has a posting block and
  its reply has `sourceIndices`. Neither fits `resumeWriteBodySchema` (strict, `task: 'summary' | 'bullets'`). The
  VBR wire stays byte-identical.
- **D3 — one generation call returns everything** (summary, skills, per-item bullets, cover letter). A repair call
  sends the whole payload again with feedback lines; only the failing items are taken from the new reply.
- **D4 — posting text cap 12 000 chars** after `stripContacts`, cut at the last sentence end before the cap.
  `postingTruncated: true` is recorded. This keeps the worker input (payload + posting + 20 feedback lines) under
  `MAX_WORKER_INPUT_CHARS` (50 000), and `fitToWorker` then trims trailing items as VBR does.
- **D5 — base page count** comes from the base's live PDF: `S3Service.getObject(base.pdfS3Key)` →
  `countRenderedPages`, read once in prepare (spec §6.4 item 16: "read from the base, not re-rendered").
- **D6 — reviewer is Jev only** (spec §6.4 item 12 [builder]: "start with Jev only").
- **D7 — thresholds.** Injection `noul` ≥ 0.7 = anomaly. Gap `choice` confidence < 0.6 falls back to the
  deterministic bucket. Reviewer `cut` only at confidence ≥ 0.7. Entailment uses the existing `ENTAILMENT_THRESHOLD`
  (0.8).
- **D8 — cover letter length gate:** a body of 100–220 words passes; outside that range it is a feedback item. The
  greeting `Dear Hiring Team,` and the closing `Kind regards,\n<display name>` are added by the service (spec §5).
- **D9 — a confirmed visual finding feeds layout repair.** It drops the lowest-ranked bullet, re-renders and
  re-checks. At most 3 repair rounds (spec §6.4), so at most 4 renders and 8 vision calls. Then `LAYOUT_UNFIXABLE`.
  `VISUAL_CHECK_UNAVAILABLE` never repairs; it fails closed.
- **D10 — batch status endpoint** `GET /job-queue/:id/tailored?teamId&seniorIds=` (at most 50 ids per request). One
  request per card gives every row its state and eligibility. A per-row GET would mean up to 200 requests per card
  (`SENIORS_PAGE` in `MatchedSeniors.tsx`). Spec §9's per-senior GET stays for the detail and for polling.
- **D11 — flag and limits** in `apps/api/src/config/env.ts`, in the existing boolean-preprocess style:
  `TAILORED_RESUME_ENABLED` (default `false`), `TAILORED_RESUME_MAX_CONCURRENT_RUNS` (default `2`) and
  `TAILORED_RESUME_DAILY_TEAM_CAP` (default `50`).
- **D12 — throttle** `@Throttle({ default: { limit: 10, ttl: 60_000 } })` on POST and PUT (the resume upload pattern).
  The daily cap counts today's `tailored_resume_generate` audit rows (Kyiv day) whose `changes.teamId.after` is the
  scope team, or `studio` for an ADMIN studio scope. Over the cap → 429 `TAILORED_RESUME_DAILY_CAP`.
- **D13 — audit** via `AuditLogService.record` into `user_audit_log`: `targetId` = senior, actions
  `tailored_resume_generate` (POST) and `tailored_resume_edit` (PUT). `changes` holds only ids and flags
  (`opportunityId`, `teamId`, `runId` or `renderId`, `overwrite`), never text. No `job_queue_actions` kind: that table
  is class B append-only with triggers, and a new kind needs DDL on it.
- **D14 — S3 keys:** prefix `tailored-resumes/<rowId>/`. Run key `…/run-<runId>.pdf`, edit key `…/edit-<renderId>.pdf`.
  The daily orphan sweep deletes objects under the prefix that no row references and that are older than 1 h.
- **D15 — file name** `<display name> - <title> - CV.pdf`. Each part is reduced to `[A-Za-z0-9 .,&()-]`, collapsed and
  cut to 80 chars, and sent as `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`.
- **D16 — DDL ships wired, not staged.** `drizzle/manual/2026-11-21_tailored_resumes.sql` is applied by the deploy
  before the grants file, class A in `PRIVILEGE_CLASSES`. The table is empty and unread until the flag flips, so
  wiring it at once is safe, and it avoids the staged-path trap of SFS U2-D/U4-D.

---

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
'VISUAL_CHECK_UNAVAILABLE','STALLED'])` — every code a reused gate can throw as `RunFailure.code` is a member,
    so a caught failure maps 1:1.
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
  - `tailoredListQuerySchema = z.object({ teamId: uuid.optional(), seniorIds: <comma list → uuid[], 1..50> })`
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
      `… refuses an unknown key`, `list query parses "a,b" into two uuids; refuses 51 ids and "not-a-uuid"`,
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
  (class A). MUST precede the grants file")

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
  `@Cron('50 5 * * *') sweepOrphans()`; never rethrows. Until Task 10 it passes an empty `waiting` set.

- [ ] **Step 1: Write the failing unit tests:** `isStalled: RUNNING started 10 min + 1 ms ago → true; 10 min − 1 ms →
false`; `isStalled: QUEUED past deadline but runId in waiting → false`; `isStalled: SUCCEEDED → false`;
      `isRenderStalled: RUNNING 2 min + 1 ms → true`; `runPdfKey('r','u') === 'tailored-resumes/r/run-u.pdf'` and
      starts with `tailoredPrefix('r')`.
- [ ] **Step 2: Write the failing integration tests** (scratch DB): `startRun creates a QUEUED row with runBaseVersion`;
      `startRun twice while QUEUED → ACTIVE with the first runId`; `startRun on a published row, overwrite=false →
CONFLICT PUBLISHED, content unchanged`; `startRun while pdf_status RUNNING → CONFLICT RENDERING`;
      `claimRun with a stale runId → null`; `failRun keeps content, cover_letter and pdf_s3_key`;
      `sweepRuns fails a RUNNING run past 10 min with STALLED and keeps the published variant`;
      `sweepRuns marks an edit render RUNNING past 2 min pdf_status FAILED, pdf_s3_key kept`;
      `sweepOrphans deletes an unreferenced object older than 1 h, keeps a referenced one and a 59-min one` (fake S3).
- [ ] **Step 3: Run** both — expected FAIL.
- [ ] **Step 4: Implement.** The module provides the cron only; nothing calls `startRun` yet.
- [ ] **Step 5: Run** both (PASS, non-zero count), `pnpm --filter @crm/api typecheck`, ESLint MCP on new files.
- [ ] **Step 6: Commit** `feat(api): tailored resume run lifecycle (inert)`. PR body: Assumptions D11, D14, D16;
      "inert: no code path writes the table"; rollback = revert the PR (the additive DDL stays; drop only on owner
      request).

<!-- tasks follow -->
