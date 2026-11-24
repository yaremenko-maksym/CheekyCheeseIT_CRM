# External vacancy intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR records a submission made on any external site with the vacancy fields pre-filled, and opens pre-filtered external feeds in one click.

**Architecture:** Four PRs on top of the existing `POST /job-queue/manual`. PR 1 adds the dialog, a `#external=` prefill entry and the per-team duplicate rule; PR 2 a parse route (Jev `isVacancy` + hosted extraction); PR 3 a bookmarklet that reads the HR's page and opens the dialog; PR 4 feed links built from the senior's `technicalRoles`.

**Tech Stack:** NestJS 11 + Fastify + Drizzle (raw `sql` in the queue services), Zod v4 in `@crm/shared`, React + TanStack Router/Query + shadcn/ui, Lingui (`uk` + `en`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-external-vacancy-intake-design.md`

## Global Constraints

- RBAC: every new or changed route is `@Roles('ADMIN', 'HR')`, with the role and scope re-checked in the service body (`JobQueueScopeService.resolve` / `writeScope`), never by the decorator alone.
- `descriptionMd` ≤ `DESCRIPTION_MD_MAX` (50 000); `applicationUrl` is `externalHttpsUrlSchema` (https only); parse input ≤ 50 000 chars (`MAX_EXTRACTION_INPUT_CHARS`).
- Visible text in `uk` (default) + `en` through Lingui macros; no literal strings in `apps/web`.
- Pasted and bookmarklet text is plain text: never rendered as HTML, never `dangerouslySetInnerHTML`.
- No server-side request to any external job site, ever.
- Free hosted routes only; `Jev-first: "is this a vacancy" -> Jev (noul)`; `Jev-first: field extraction -> hosted (free-form)`.
- Security review mandatory on PR 1, PR 2 and PR 4 (`contracts.md` critical-path).
- Push with `DATABASE_URL= git push`; integration specs only on a scratch DB, never `crm_db`.

## Review Focus

1. A `#external=` payload that is malformed, oversized, or not base64 → the dialog opens empty; no crash, no error page. Test in Task 1.2.
2. Team B registers a URL that only team A's **manual** card carries → allowed (201); a URL a **collected** card carries that team B cannot see → generic 409 with no `opportunityId`. Test in Task 1.1.
3. A senior without a resume, or with one that is not `READY` → Submit disabled with that reason, no 422 round-trip. Test in Task 1.3.
4. Not logged in when the bookmarklet opens CRM → after Google login the dialog opens with the payload, and the stash is gone after one read. Test in Task 1.4.
5. Parse provider outage or > 30 s → specific error, fields stay editable, collector budget untouched. Test in Task 2.1.

---

## PR 1 — dialog, prefill, post-login restore, per-team duplicates

### Task 1.1: Per-team manual URL key + 409 that names a visible card (API)

**Files:**

- Modify: `apps/api/src/job-sourcing/queue/queue-actions.service.ts` (`createManualCard` duplicate block and its doc comment; `manualDuplicate` helper)
- Modify: `packages/shared/src/schemas/job-sourcing.ts` (next to `jobQueuePossibleDuplicateConflictSchema`)
- Modify: `apps/api/src/job-sourcing/queue/job-queue.controller.ts` (`@ApiResponse` 409 docs only, if present)
- Test: `apps/api/src/job-sourcing/queue/queue-actions.integration.spec.ts`

**Interfaces:**

- Produces: `jobQueueManualDuplicateConflictSchema = z.object({ statusCode: z.literal(409), code: z.literal('JOB_QUEUE_MANUAL_DUPLICATE'), message: z.string(), params: z.record(z.string(), z.unknown()).optional(), opportunityId: z.string().uuid().optional() }).strict()` (the full `apiError` envelope plus `opportunityId`; check the real envelope keys in `apps/api/src/common/` before writing it) and type `JobQueueManualDuplicateConflict`, exported from `@crm/shared`.

- [ ] **Step 1: Write failing integration tests** in `queue-actions.integration.spec.ts`, `describe('createManualCard duplicates per team')`:
  - `team B may register a URL only team A's manual card carries` → 201.
  - `same team, same URL` → 409, body parses with `jobQueueManualDuplicateConflictSchema`, `opportunityId` = team's own card id.
  - `URL of a collected card visible to the actor` → 409 with that `opportunityId`.
  - `URL of a collected card NOT visible to the actor` → 409 and `opportunityId` is `undefined`.
- [ ] **Step 2: Run** `DATABASE_URL=<scratch> pnpm --filter @crm/api test -- queue-actions.integration` (there is no `test:integration` script) → the 4 new cases FAIL.
- [ ] **Step 3: Implement.** The `taken` query selects `id, manual_team_id` instead of `1`, ignores rows where `manual_team_id IS NOT NULL AND manual_team_id <> teamId`, and returns up to 10 rows (not `LIMIT 1` without an order, which could pick a card the actor cannot see while a visible one exists). Prefer the team's own manual row; otherwise the first row the actor can see; otherwise any row. Check visibility with a real query in the same `tx`: `SELECT EXISTS (SELECT 1 FROM job_opportunities o WHERE o.id = ${id} AND ${visibleOpportunityPredicate(scope, id)})` (the predicate `JobQueueScopeService.assertVisible` uses; it is a Drizzle `SQL` fragment, always truthy in JS, so never test it directly), and throw `new HttpException(jobQueueManualDuplicateConflictSchema.parse({ code, opportunityId: visible ? id : undefined }), HttpStatus.CONFLICT)`, keeping `statusCode` and `message` in the body like `apiError` does. Keep the advisory lock as is. Rewrite the "Duplicates, two layers" doc comment to say what is now true. The web reads `err.response.data` and parses it with this schema; a parse failure falls back to the generic "already registered" text. Add a test: two matching rows, the invisible one inserted first → `opportunityId` is the visible one.
- [ ] **Step 4: Run** the same command → all cases PASS, including the existing manual-card cases.
- [ ] **Step 5: Commit** `feat(job-queue): per-team manual URL key; duplicate 409 names a visible card`.

### Task 1.2: Prefill payload schema + hash codec (shared + web lib)

**Files:**

- Create: `packages/shared/src/schemas/external-vacancy-prefill.ts` (export from the schemas index)
- Create: `apps/web/app/lib/external-prefill.ts`
- Test: `packages/shared/src/schemas/external-vacancy-prefill.spec.ts`, `apps/web/app/lib/__tests__/external-prefill.test.ts`

**Interfaces:**

- Produces (shared): `externalFieldStatusSchema = z.enum(['found', 'guessed', 'missing'])`;
  `externalVacancyPrefillSchema = z.object({ v: z.literal(1), recognition: z.enum(['recognized', 'partial', 'none']), url: externalHttpsUrlSchema.optional().catch(undefined), title: capped(500), company: capped(255), description: capped(DESCRIPTION_MD_MAX), pageText: capped(15000), status: z.object({ url, title, company, description: externalFieldStatusSchema }) })` where `capped(n) = z.string().trim().transform((v) => v.slice(0, n)).optional()` (over-length text is cut and never rejects the whole payload; a non-https or malformed `url` becomes `undefined` with status `missing`; unknown keys stripped, not rejected); type `ExternalVacancyPrefill`.
- Produces (web): `encodePrefill(p: ExternalVacancyPrefill): string` (base64url of UTF-8 JSON), `decodePrefill(hash: string): ExternalVacancyPrefill | null` (accepts `#external=<b64>`; any failure → `null`), `PREFILL_STASH_KEY = 'crm.externalPrefill'`.

- [ ] **Step 1: Write failing tests:** round-trip with Cyrillic text; `decodePrefill('#external=%%%')` → `null`; `decodePrefill('#other=1')` → `null`; payload with `title` of 501 chars → decoded with a 500-char title; `url: 'http://x'` or `'javascript:alert(1)'` → decoded with `url` undefined; unknown extra key → decoded without it; encoded payload > 32 000 chars → `null` (transport cap, Safari/Firefox hash limits).
- [ ] **Step 2: Run** `pnpm --filter @crm/shared test -- external-vacancy-prefill` and `pnpm --filter @crm/web test -- external-prefill` → FAIL.
- [ ] **Step 3: Implement** with `TextEncoder`/`TextDecoder` + `btoa`/`atob` (base64url: `+/` ↔ `-_`, no padding). Build the binary string from the UTF-8 bytes in a loop or 8 KB chunks, never `String.fromCharCode(...bytes)` on the whole array (call-stack overflow on large input); `btoa` only ever sees that binary string, never raw Cyrillic. Test: a 32 000-char Cyrillic description round-trips.
- [ ] **Step 4: Run** both → PASS.
- [ ] **Step 5: Commit** `feat(job-queue): external vacancy prefill payload and hash codec`.

### Task 1.3: Register external submission dialog (web)

**Files:**

- Create: `apps/web/app/components/job-queue/ExternalSubmissionDialog.tsx`
- Modify: `apps/web/app/routes/_authenticated/job-queue/index.tsx` (header button; opens dialog; on mount reads the prefill **only** through `takeStashedPrefill()` (Task 1.4), never from `location.hash`; on success `go({ ...search, tab: 'SUBMITTED' })`)
- Modify: `packages/shared/src/i18n/locales/{uk,en}/messages.po` (via the root `pnpm i18n:extract`, then `pnpm i18n:compile`)
- Test: `apps/web/app/components/job-queue/__tests__/ExternalSubmissionDialog.test.tsx`

**Interfaces:**

- Consumes: `useCreateManualJobQueueCard(scope)`, `useSeniorResume(userId)`, `useJobQueueSeniorOptions`, `useActiveTeams()`, `ExternalVacancyPrefill` (Task 1.2), `jobQueueManualDuplicateConflictSchema` (Task 1.1), existing `PossibleDuplicates.tsx` for the possible-duplicate list.
- Produces: `<ExternalSubmissionDialog open onOpenChange scope teamId? seniorId? prefill?: ExternalVacancyPrefill | null onSubmitted(opportunityId: string) />`.

- [ ] **Step 1: Write failing component tests:**
  - prefill with `status.title = 'missing'` → title field has the "Not recognized — fill in manually" hint; `status.company = 'guessed'` → "Check this value" hint.
  - `recognition: 'none'` → error banner "No vacancy was recognized on this page…" and empty title/company/description; URL filled with the "check" hint.
  - resume query returns none / non-`READY` → Submit disabled with the reason text.
  - empty title, company or description → Submit disabled.
  - 409 `JOB_QUEUE_MANUAL_DUPLICATE` with `opportunityId` → "Already in the queue — open and submit there" link to that card; without → plain "already registered" error.
  - 409 `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` → duplicates list + "Submit anyway" resends with `confirmPossibleDuplicate: true` and the same idempotency key flow `useQueueWrite` provides.
- [ ] **Step 2: Run** `pnpm --filter @crm/web test -- ExternalSubmissionDialog` → FAIL.
- [ ] **Step 3: Implement** with the shadcn `Dialog` + TanStack Form patterns used by `TailoredResumeEditDialog.tsx`. Description is a `Textarea`; nothing is rendered as HTML. Responsive at 320 px (`responsive-design` rule).
- [ ] **Step 4: Run** the tests, `pnpm --filter @crm/web typecheck`, eslint MCP on changed files → PASS / clean.
- [ ] **Step 5: Commit** `feat(job-queue): register external submission dialog with prefill`.

### Task 1.4: Keep the prefill across login (web, auth zone)

**Files:**

- Modify: `apps/web/app/client.tsx` (app boot, before the router renders: `stashPrefillFromLocation(window.location)`, in `try/catch`; when it stashed, `history.replaceState` drops the hash. Boot runs before any auth redirect, so the redirect order no longer matters)
- Modify: the authenticated root/index route that `/` lands on after login (find with `grep -rn "to: '/'" apps/web/app/routes/login.tsx` and the `_authenticated/index` route)
- No change to `_authenticated/route.tsx` or `axios.ts`: the payload is already in `sessionStorage` when they redirect.
- Test: `apps/web/app/lib/__tests__/external-prefill.test.ts` (stash helpers), `apps/e2e/tests/job-queue-external-submission.spec.ts` (Task 1.5)

**Interfaces:**

- Produces in `external-prefill.ts`: `stashPrefillFromLocation(loc: Location): boolean` (valid `#external=` → `sessionStorage[PREFILL_STASH_KEY]`, returns `true`; else nothing, `false`; storage errors → `false`) and `takeStashedPrefill(): ExternalVacancyPrefill | null` (read + delete + validate).

- [ ] **Step 1: Write failing unit tests:** stash then take → payload; second take → `null`; invalid stash value → `null` and key removed.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; the boot call in `client.tsx` as above; on the authenticated landing, a stash present (peek, do not take) → `navigate({ to: '/job-queue' })`, where the job-queue route takes it. No redirect logic changes. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(auth): keep an external vacancy prefill across login`.

### Task 1.5: E2E + PR 1

**Files:** Create `apps/e2e/tests/job-queue-external-submission.spec.ts` (`playwright-patterns` skill).

- [ ] **Step 1:** Specs: HR opens `/job-queue#external=<payload>` → dialog pre-filled → Submit → `SUBMITTED` tab shows the card. Same URL again → "already in the queue" link. Logged-out visit with payload → dev-login → dialog opens pre-filled. A backend RBAC case: SENIOR `POST /job-queue/manual` → 403 (not mocked).
- [ ] **Step 2:** `pnpm --filter @crm/e2e test -- job-queue-external-submission` → PASS (non-zero count).
- [ ] **Step 3:** Commit; push; open PR 1 with `Jev-first: n/a (no model call)`; reviews: code, security, spec, copy; manual-qa User Testing.

## PR 2 — parse route (Jev `isVacancy` + hosted extraction) + paste box

### Task 2.1: `POST /job-queue/manual/parse` (API)

**Files:**

- Modify: `packages/shared/src/schemas/job-sourcing.ts` — `jobQueueManualParseRequestSchema = z.object({ text: z.string().trim().min(1).max(50000) }).strict()`, `jobQueueManualParseResponseSchema = z.object({ isVacancy: z.boolean(), title: z.string().max(500).optional(), companyName: z.string().max(255).optional(), descriptionMd: z.string().max(DESCRIPTION_MD_MAX).optional() }).strict()`; new api error code `JOB_QUEUE_PARSE_UNAVAILABLE` (503) in `api-errors/job-sourcing.ts` with `uk`/`en` text.
- Create: `apps/api/src/job-sourcing/queue/manual-parse.service.ts`
- Modify: `job-queue.controller.ts` (route **before** `@Post(':id/...')` routes), `job-sourcing` module wiring.
- Test: `apps/api/src/job-sourcing/queue/manual-parse.service.spec.ts`, controller RBAC case in `job-queue-rbac.integration.spec.ts`.

**Interfaces:**

- Produces: `ManualParseService.parse(user: SessionUser, text: string): Promise<JobQueueManualParseResponse>`. The service body re-checks the role (ADMIN or HR, through `JobQueueScopeService.resolve` like the other queue writes) before any model call; the decorator is not the only check.
- Consumes: `DecisionPort` (`packages/inference/src/contracts/decision.ts`, Jev adapter) for one `noul` question "Does this text describe one job vacancy?" (threshold 0.5); the extraction worker client used by `apps/api/src/job-sourcing/structuring/model-extraction-wiring.ts` for the field extraction.

- [ ] **Step 1: Failing unit tests** with fake ports: Jev says no → `{ isVacancy: false }` and extraction never called; Jev yes + extraction ok → fields trimmed and capped; extraction throws or exceeds the 30 000 ms timeout → `JOB_QUEUE_PARSE_UNAVAILABLE`; Jev down → treat as "yes" and continue (degrade, never break); the route uses `@RelaxableThrottle(JOB_QUEUE_THROTTLE.PARSE)` with a new `PARSE` entry (10) in `JOB_QUEUE_THROTTLE`, like `MANUAL`; a unit test asserts the decorator metadata. Assert the collector's `InMemoryModelBudget` instance is never touched (separate budget object).
- [ ] **Step 2:** Run `pnpm --filter @crm/api test -- manual-parse` → FAIL. **Step 3:** Implement; own budget + timeout; no storage; log only lengths and outcome, never the text. The model reply goes through `guardExtractionResult` (`structuring/extraction-result-guard.ts`: output size cap, schema) before any field is returned. `assertModelAllowed` (`structuring/ai-input-gate.ts`) is a per-source policy and does not apply: the text comes from the HR, not a source; say so in the service doc comment. **Step 4:** PASS + RBAC integration (SENIOR/JUNIOR/ACCOUNTANT → 403).
- [ ] **Step 5:** Commit `feat(job-queue): manual parse route (Jev isVacancy + hosted extraction)`.

### Task 2.2: Paste box in the dialog + automatic `pageText` parse (web)

**Files:** Modify `ExternalSubmissionDialog.tsx`; add `useParseExternalVacancy()` in `apps/web/app/hooks/use-job-queue.ts`; tests in the dialog test file.

- [ ] **Step 1: Failing tests:** paste + "Fill in" fills only empty fields and marks them "Check this value"; a prefill with `pageText` and `recognition` `partial|none` triggers the parse once on open (once per payload, never on re-render; a 429 shows a "too many requests, fill in by hand" banner); `isVacancy: false` → keep / show the "not recognized" banner; 503 → banner names the outage, fields editable.
- [ ] **Step 2–4:** Run → FAIL → implement → PASS (+ typecheck, eslint MCP).
- [ ] **Step 5:** Commit; push; PR 2 with the two `Jev-first:` lines; reviews: code, security, spec, copy.

## PR 3 — bookmarklet + install dialog + HR how-it-works

### Task 3.1: Bookmarklet extractor (pure module)

**Files:**

- Create: `apps/web/app/bookmarklet/extract.ts` (pure: `extractVacancy(doc: Document, loc: Location, selection: string): ExternalVacancyPrefill`)
- Create: `apps/web/app/bookmarklet/profiles.ts` (site profiles: DOU `h1.g-h2` / `.b-compinfo` / `.b-typo.vacancy-section`; LinkedIn job view; Greenhouse; Lever; Workable; Ashby; Djinni — selectors verified against saved HTML fixtures)
- Create: `apps/web/app/bookmarklet/__fixtures__/*.html` (DOU vacancy saved 2026-11-23 in `/tmp/feedcheck/dou_vac.html`, Greenhouse `/tmp/feedcheck/gh_job.html`, plus a JSON-LD `JobPosting` sample, a non-vacancy news page)
- Test: `apps/web/app/bookmarklet/__tests__/extract.test.ts` (jsdom)

- [ ] **Step 1: Failing tests:** DOU fixture → `recognized`, title "Senior Python AI Engineer", company and description found; JSON-LD sample → `recognized` from JSON-LD; Greenhouse → title from `og:title`/`h1`, description generic → `partial` or `recognized` with `guessed` statuses; news page → `none` with `pageText` set; selection ≥ 200 chars → description `found` from selection; `http:` canonical URL → `url` missing; description > 50 000 → capped. Order per field: selection → JSON-LD → profile → generic. `pageText` = body clone minus `nav, header, footer, aside, script, style`, `innerText`, cap 15 000, only when the description is missing (keeps the `#external=` hash under the 32 000-char transport cap of Task 1.2).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(job-queue): bookmarklet vacancy extractor`.

### Task 3.2: Build the `javascript:` URL + install dialog + how-it-works

**Files:**

- Create: `apps/web/app/bookmarklet/entry.ts` (wraps `extractVacancy` in `try/catch` → `alert(<reason>)`; `window.open(<CRM origin>/job-queue#external=<encodePrefill>, '_blank', 'noopener,noreferrer')` so the CRM tab gets no `window.opener` (no reverse tabnabbing). With `noopener` the return value is always `null`, so there is no pop-up-blocked detection; how-it-works tells HR to allow pop-ups for the CRM if nothing opens)
- Create: a Vite build step that bundles `entry.ts` (IIFE, minified) into a string exposed as virtual module `virtual:bookmarklet`, with a fixed placeholder for the CRM origin. There is no origin env in `apps/web/vite.config.ts`, so `BookmarkletInstallDialog` replaces the placeholder with `window.location.origin` at runtime and prefixes `javascript:`; the bookmarklet then always targets the CRM it was installed from
- Create: `apps/web/app/components/job-queue/BookmarkletInstallDialog.tsx`
- Modify: `index.tsx` (button "Add the script to bookmarks" + "?"; auto-open while `localStorage['crm.bookmarkletUsed']` is unset; set it when a `#external=` hash or stash is consumed)
- Test: `__tests__/BookmarkletInstallDialog.test.tsx`; e2e case in the PR 1 spec file.

- [ ] **Step 1: Failing tests:** "Copy the script" calls `navigator.clipboard.writeText` with a string starting `javascript:` and shows the copied toast; Chrome UA shows the `Cmd/Ctrl+Shift+O` steps, Firefox/Safari their own; the drag link's `href` is set via ref (`getAttribute('href')` starts with `javascript:`); dialog auto-opens on first visit, not after the flag is set; how-it-works lists the 4 steps and the "not recognized" meaning (copy from the spec §C).
- [ ] **Step 2–4:** FAIL → implement → PASS; e2e: load `/tmp`-free fixture page in Playwright, run the built bookmarklet via `page.evaluate`, assert the CRM dialog opens pre-filled.
- [ ] **Step 5:** Commit; push; PR 3; reviews: code, spec, copy; manual-qa in real Chrome on DOU and LinkedIn (CSP behaviour is reported, not assumed).

## PR 4 — feed links from `technicalRoles`

### Task 4.1: `technicalRoles` in `GET /job-queue/seniors`

**Files:** `packages/shared/src/schemas/job-sourcing-queue-api*` (`jobQueueSeniorOptionsResponseSchema` item gets `technicalRoles: z.array(technicalRoleSchema)`), the service query behind `seniorOptions`, its unit + RBAC integration spec.

- [ ] **Step 1:** Failing test: items carry the senior's `technical_roles`; HR sees only seniors already in their scope (unchanged set). **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit.

### Task 4.2: Feed URL builders + "External sources" block

**Files:**

- Create: `packages/shared/src/utils/external-feeds.ts` (built there: `src/job-sourcing/` does not exist) — `EXTERNAL_FEEDS: readonly { id: 'DOU' | 'LINKEDIN' | 'THE_MUSE' | 'EU_REMOTE_JOBS'; label: string; buildUrl(f: FeedFilters): string }[]`, `FeedFilters = { roles: TechnicalRole[] }`, `ROLE_TO_DOU_CATEGORY: Partial<Record<TechnicalRole, DouCategory>>`.
- Create: `apps/web/app/components/job-queue/ExternalSourcesBlock.tsx` (collapsible; links `target="_blank" rel="noopener noreferrer"`; "Register external submission" button; first selected senior from `seniorIds`, none → general filters)
- Test: `packages/shared/src/job-sourcing/external-feeds.spec.ts`, block component test.

- [ ] **Step 1: Failing tests:** DOU with a Python role → `https://jobs.dou.ua/vacancies/?category=Python&exp=5plus&remote`; a role without a DOU category → `?search=<label>&exp=5plus&remote`; no roles → `?exp=5plus&remote`; LinkedIn → `https://www.linkedin.com/jobs/search/?keywords=<K>&f_E=4&f_WT=2&sortBy=DD` (URL-encoded keywords); The Muse / EU Remote Jobs templates written after one owner-approved GET each and pinned the same way (WTTJ dropped: its search reads no URL filter).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit; push; PR 4; reviews: code, security, spec, copy; manual-qa checks LinkedIn filters logged in.
