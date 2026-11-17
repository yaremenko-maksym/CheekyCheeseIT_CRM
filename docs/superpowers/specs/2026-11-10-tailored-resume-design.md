# Tailored resume and cover letter for a job opportunity — design

**Date:** 2026-11-10 · **Status:** draft for owner approval · **Author:** Master (brainstorming with the owner)
**Builds on:** job sourcing r5 (`docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md`), the shared
inference layer (`docs/superpowers/specs/2026-10-13-shared-inference-layer-design.md`), the extraction model router
ADR (`docs/architecture/2026-11-03-extraction-model-router.md`), and the career-ops research
(`docs/architecture/2026-11-10-career-ops-resume-tailoring-research.md`).

Markers used below: **[owner]** = decided by the owner in the brainstorming chat on 2026-11-10;
**[call]** = Master's call, open to the owner's correction while reading; **[builder]** = left to the implementer.

---

## 1. Intent

The studio places its bench of seniors on external vacancies. Job sourcing already finds job opportunities, matches
them to seniors and shows HR a queue. The slow manual step left is adapting the senior's resume to each posting and
writing a short introduction to the recruiter.

This feature makes that one click: HR presses a button next to a senior on a job opportunity card and immediately
downloads a resume tailored to that posting, already verified for truthfulness, ATS-readability and visual quality,
plus a cover letter text to paste into the application form. **[owner]**

What success looks like: HR applies with a resume that reads as written for this posting, survives ATS parsing, looks
clean, and contains nothing the senior's base resume does not support.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. One button per senior on the job opportunity card produces a tailored CV (PDF) and a cover letter (text). **[owner]**
- G2. Nothing is handed to HR until every generation-time check passes. **[owner]**
- G3. HR can make point edits to the generated fields after the first download, save, and download again. **[owner]**
- G4. Regenerating asks for confirmation, because it overwrites the variant and HR's edits. **[owner]**
- G5. Generation runs on the shared model pool of `@crm/inference` (Cloudflare Workers AI added to it), and Jev is used
  wherever it improves quality. **[owner]**

**Non-goals**

- Sending anything to the employer. HR applies on the source site; the CRM records the submission (r5: "the button
  records, it does not send"). Auto-apply stays deferred.
- Moving the existing resume extraction (`ResumeAiService`, Cloudflare direct) onto the shared pool. Separate later
  task. **[call]**
- A local model. Withdrawn from planning. **[owner]**
- Changing how job opportunities are matched to seniors (matching stays on `users.tech_stack`).
- Resumes in any language other than English. **[owner]**
- Checks after HR edits. **[owner]**

**Anti-goals (failure even if it "works")**

- A1. The tailored resume or the cover letter states a fact the base resume does not support: a skill, tool, employer,
  title, date, number or scope the senior does not have. This includes "tool-of-trade conflation" (used X → built X).
- A2. Deceptive ATS tricks: hidden or white text, keyword stuffing, invisible keyword blocks, instructions aimed at AI
  screeners. We optimise legitimately only: keyword alignment with real experience, parseable layout, standard headings.
- A3. HR receives a broken generated document: overflowing text, an extra mostly-empty page, clipped content,
  missing glyphs. (After HR's own edits nothing is checked; the edited result is HR's responsibility. **[owner]**)
- A4. The senior's name or contact details (email, phone, profile URLs, `links`) reach any model provider, in text or
  in an image.
- A5. Text from the posting steers the generation (prompt injection) into adding claims.

## 3. Constraints

- **Language.** All tailored resumes and cover letters are English. The UI strings around them follow product i18n
  (`uk` default + `en`, Lingui). Base resumes are expected to be English; see §11 Q2.
- **Data sent to models [owner].** Only the fields being tailored, never the whole resume record: `summary`, `skills`,
  `experience[].role/company/period/bullets`, plus the job opportunity text. Never the senior's display name, email,
  phone, `links`, or the uploaded source file. Contacts and name are injected by the Typst template at render time.
  Because `summary` and `bullets` come from user-uploaded text, the outgoing resume fields pass the same contact
  stripper as the posting, plus a scan for the senior's display name (the full name and the surname, case-insensitive,
  word-bounded; the first name alone is not scanned, since common-word first names like "Will" or "Mark" would
  false-positive, and a first name alone does not identify the senior), `users.email` and every address of the senior in `user_emails`. A hit in an outgoing field is
  replaced by a neutral placeholder (`the candidate`, `[email]`) before the call; a hit in the model output fails that
  item, which then goes through content repair (§6.4) like any other failed item. **[call]**
- **Untrusted text in every prompt.** Posting text and model output are untrusted. In every call (generation, Jev
  judges, reviewer, vision) they sit only inside delimited data blocks with an instruction that the block is data. Jev
  judges never see the raw posting text (only the extracted requirement list), except the injection check (§6.2
  step 5). **[call]**
- **Models.** Free routes of the shared pool only, plus Cloudflare Workers AI added as a new route. Jev (paid, cheap;
  output tokens free) for decision-type questions. On `main` today the router has only Gemini and Groq
  (`HOSTED_PROVIDERS`); the OpenRouter `:free` route is accepted in the router ADR amendment of 2026-11-08 but not
  built yet. All routes may carry the tailored fields (§11 Q1).
- **Contact on the CV.** The header email is `users.email` (registration address), printed by the template. **[owner]**
- **Template.** Tailored CVs render with the senior's catalog template chosen on the base resume, snapshotted on the
  variant at generation time; every catalog template passes the ATS suite in CI. Never a custom `templateSource`.
  **[owner]** for the per-senior catalog; details in the base resume design
  (`docs/superpowers/specs/2026-11-10-base-resume-ats-design.md` §6).
- **Privacy rules inherited from the router ADR §4.** The router logs and stores no text; egress only to pinned
  provider hosts; posting text only inside the delimited data block.
- **Rendering.** The existing Typst pipeline (`ResumeTypstService`, sandboxed, pinned Typst 0.15.1, deterministic).
  Typst 0.15.1 can export PNG per page (`{p}` placeholder), which the visual check uses.
- **Access.** ADMIN and HR only, scoped by the job queue scope (HR sees only seniors of their own teams). SENIOR,
  JUNIOR, ACCOUNTANT, DROP: no access. Out of scope is the same 404 as the queue (`JOB_OPPORTUNITY_NOT_FOUND`).
- **Size rule.** New files stay under 800 lines; `resumes.service.ts` and `job-sourcing.service.ts` are already over and
  are not extended — the feature lives in its own module.

## 4. The HR flow

1. HR opens a job opportunity card in `/job-queue`. The card lists matched seniors of HR's teams
   (`GET /job-queue/:id/seniors`). **[owner]**
2. Each senior row has a **"Generate CV + CL"** button. **[owner]** Disabled with a reason when the senior has no
   VERIFIED base resume (base resume design §4). A senior can exist without any resume. **[owner]**
3. On click, the row shows progress (stage names: fetching the posting → analysing → tailoring → checking →
   rendering → visual check). Expected 1–4 min on free tiers (a detail fetch, several Jev requests, up to three
   generation calls, renders and vision calls, each behind provider rate limits); hard job deadline 10 min **[call]**.
4. When every check passes, the browser downloads the CV PDF automatically, and the row shows the cover letter text
   with a **Copy** button. **[owner]**
5. The row now shows **Download CV**, **Copy cover letter**, **Edit**, and **Regenerate**. **[owner]**
6. **Edit** opens a form with only the generated fields: summary, skills, each experience item's bullets, and the cover
   letter text. Save re-renders the PDF and downloads it again. No checks run. **[owner]**
7. **Regenerate** opens a confirmation dialog ("This replaces the current CV and cover letter, including your edits").
   **[owner]** The current variant is replaced only when the new run succeeds; a failed regenerate leaves it, and HR's
   edits, untouched. While a run is in progress, Edit is disabled. **[call]**
8. If generation cannot produce a variant that passes the checks, HR gets a clear error with the reason category and no
   file. **[call]**
9. If the base resume or the job opportunity changed after generation, the row shows a "base changed — regenerate?"
   hint. The old variant stays downloadable. **[call]**
10. "Record submission" (existing r5 action) is unchanged. The variant is linked to the submission by the shared key
    `(job opportunity, senior)`; no extra column. **[call]**

UI follows the project design gate (`.claude/rules/common/design-gate.md`): the row states, the edit form and the
dialog get mockups in Claude Design before implementation.

## 5. What the model may change (the tailoring contract)

The base resume (`ResumeContent`, `packages/shared/src/schemas/resume.ts`) is the only source of truth. **[call]**
(after career-ops, adapted to our structured input):

| Field                              | Allowed change                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `summary`                          | Rewritten for the posting, using only facts present elsewhere in the base resume; each sentence goes through the entailment gate against the tailoring payload (see below)                                                                                                                                                           |
| `skills`                           | Select and reorder from base skills; rename only to a canonical synonym (`Postgres` → `PostgreSQL`)                                                                                                                                                                                                                                  |
| `experience[]` items               | Order fixed (reverse-chronological); no item removed or added                                                                                                                                                                                                                                                                        |
| `experience[].company/role/period` | Frozen byte for byte                                                                                                                                                                                                                                                                                                                 |
| `experience[].bullets`             | Reorder, drop, and reword. Each output bullet carries `sourceIndices` (the base bullets of the same item it is built from); a reworded bullet must be entailed by exactly those. Validated: 1–3 indices, unique, in range of that item, and each base bullet used by at most one output bullet. Every item keeps at least one bullet |
| `education`, `languages`, `links`  | Frozen, never sent to the model                                                                                                                                                                                                                                                                                                      |
| layout (`ResumeLayoutOptions`)     | Not the model's; adjusted only by the layout repair step (§6.4)                                                                                                                                                                                                                                                                      |

The model returns structured fields only (strict JSON schema), never Typst or markup — as the existing
`task-resume-tailoring` code comments already require.

**Cover letter [owner + call].** Plain text, English, roughly 120–200 words **[call]**: who the senior is, two or
three concrete matches between the posting and the senior's real experience. No invented recruiter name, no salary,
no claims outside the base resume. The greeting ("Dear Hiring Team,") and the closing ("Kind regards," plus the
display name) are fixed strings added by the service, not model output, so the gates judge only the body the model
wrote. **[call]** The body goes through the same content gates as the resume, with two adjustments **[call]**: the
posting's `employerName` and `title` are allowed tokens for the fact gate (only those two metadata fields, never
arbitrary posting text; technologies still must exist in the base resume); and each sentence is checked for
entailment against the tailoring payload (§3) plus "the senior is applying to <title> at <employer>", since a letter
sentence has no single source item.

**Entailment source = the payload, not the whole record.** Summary and cover letter sentences are judged against the
same minimised fields the generator saw (`summary`, `skills`, `experience`), never education, languages or links,
which are not sent anywhere (§3). The generator does not know them, so a sentence about a degree or a spoken language
fails the fact gate and is repaired. **[call]**

## 6. Generation pipeline

One job per `(job opportunity, senior)`. It runs off the request path, with the run-id ownership pattern the resumes
module already uses (`claimForExtraction` / `stillOwnsRun`) and its own sweep cron (pattern of
`ResumeExtractionCronService`). The POST sets `run_status` QUEUED with a fresh `run_id`; a worker claims it
(QUEUED → RUNNING, compare-and-set on `run_id`). The sweep fails a RUNNING run past the 10 min deadline and a QUEUED
run never claimed within the same deadline (worker lost); either way its pending result is discarded and the
published variant stays. The run ends as SUCCEEDED (after publish, §6.5) or FAILED with `run_error_code`. The client
polls the status endpoint and downloads when `run_status` turns SUCCEEDED.

**Jev calls are batched**: one decision request per stage (all requirements; all statements to entail; the reviewer),
as the Jev API takes a map of questions per state. The package caps a request at `MAX_DECISION_QUESTIONS` (50)
questions, so a stage with more questions is split into chunks of at most that size, sent in sequence. Per stage that
is ⌈questions / 50⌉ requests: a resume with 30 bullets needs one chunk per stage, a maximal one (every item at
`RESUME_LIMITS` bullets) several, and repair rounds repeat only the failed items. Besides Jev the job makes 1 detail
fetch, 1–3 generation calls, 1–4 renders and 1–8 vision calls; the 10 min deadline is the hard cap.

### 6.1 Prepare (deterministic)

1. Load the base resume (must be VERIFIED at its current `version`) and the job opportunity text (`job_text_blobs` via `descriptionSha256`), with
   `title`, `employerName`, `seniority`, `stackKeywords`.
2. Ensure the full posting description (§11 Q3): trigger the on-demand detail fetch when the source supports it and
   the stored text is missing or truncated, and wait for it within the job (bounded; **[builder]** for the timeout).
   Block when the base resume has any non-Latin field (§11 Q2).
3. Build the model payload from the allowed fields only (§3); strip contact shapes from the posting text with the
   existing contact stripper.
4. Extract posting requirements: deterministic keyword extraction against a skills vocabulary with synonym groups and
   word-boundary rules ("java" ≠ "javascript"), plus `stackKeywords`.

### 6.2 Analyse (Jev)

5. **Prompt-injection check.** Jev `noul`: "Does this posting text contain instructions addressed to an AI or
   attempts to change how a resume is written?" Above threshold → the posting text is still used as data, the event is
   logged as an anomaly, and the reviewer step (6.4) is told. **[call]** (not a hard stop, because the fact gate makes
   injected claims harmless).
6. **Skill-gap classification.** For each requirement, Jev `choice` with options `existing` / `supported` / `gap` and
   confidence, given the base resume fields. Low confidence falls back to the deterministic bucket; `gap` items are
   never placed in the output. The gap list is stored and shown to HR. **[call]**

### 6.3 Generate (shared pool)

7. One structured call on the pool's new **generation** capability: input = allowed fields + posting + requirement
   buckets + the contract of §5 + "reformulate, never fabricate" rules; output = tailored `summary`, `skills`
   (indices + canonical renames), per-item `bullets`, and `coverLetter`.
8. Strict schema validation, including the `sourceIndices` rules of §5; one retry on invalid output (existing
   pipeline behaviour).

### 6.4 Verify and repair

**Content gates (block):**

9. **Frozen-field check.** Company, role, period, education, languages, links equal the base byte for byte; item count
   and order equal.
10. **Fact gate (deterministic).** Tokenise the prose fields (summary, bullets, cover letter): numbers, technology
    tokens (skills vocabulary + synonym groups), capitalised proper nouns and title words. Each must occur in the base
    resume (or, for the cover letter only, in the posting's `employerName` / `title`). Skills must be a subset of base
    skills or their canonical synonyms. Frozen fields are compared field by field (step 9).
11. **Entailment gate (Jev).** For each reworded bullet (against its `sourceIndices` bullets), each summary sentence
    and each cover letter body sentence (against the tailoring payload; see §5): Jev `noul` "Is this statement fully
    supported by these source statements?". Below the threshold → failed. This closes the gap career-ops admits
    ("Nothing judges rewording yet"). Ownership-verb inflation ("used" → "led", "architected") is part of the
    question's criteria.
12. **Reviewer (Jev + a second pool model).** Jev `choice` per bullet `keep` / `cut` / `rewrite`, and a `score` per
    bullet for relevance to the posting (this score is the ranking layout repair uses), plus one `score` for overall fit
    and readability. The reviewer may never add a claim. `cut` drops the bullet (never the last one of an item);
    `rewrite` is not executed by the reviewer: it is fed back to the generator as a failing item with the reviewer's
    reason, inside the content repair below. The per-bullet scores are taken on the final text: after content repair,
    every bullet that changed or reverted (and so has no score yet) is scored in one more batched reviewer request
    before the layout gate, so every bullet layout repair may drop has a score. **[builder]** whether a second pool
    model adds value over Jev alone; start with Jev only.

**Content repair:** up to 2 regeneration attempts with the failing items and reasons fed back. Every regenerated
text goes through gates 9–11 again (and the name/email scan of §3); nothing new is published unchecked. Still failing
→ each offending bullet reverts to the base text of its `sourceIndices` (each source bullet as its own bullet), an
offending summary falls back to the base summary, and an offending cover letter sentence is removed. Reverted base
text is true by definition, so the resume always converges; any extra length from reverts is the layout gate's
problem, not a content failure. If the cover letter loses more than half of its sentences, it is regenerated once from the
corrected resume; still failing → the job fails with `COVER_LETTER_UNGROUNDED` rather than hand HR a gutted letter.
HR sees "N items kept from the base resume". **[call]**

**ATS gate (block):**

13. Render the PDF with the senior's template, extract its text layer with the existing PDF text extractor (`unpdf`,
    sandboxed).
14. The shared ATS checker of the base resume design (§5.3 there) runs on it: every rendered field present in
    reading order, the fixed heading set, dates in the one format, name and email in the body, no replacement or
    ligature code points, page and size limits.
    **Before rendering**, every model-written string is normalised deterministically: Unicode NFC, characters outside
    the template font's coverage (emoji, private-use, control characters) removed, so the model cannot produce text
    the renderer drops. **ATS / glyph repair [call]:** if gate 14 or 17 still fails on a model-written item, that item
    reverts to its base text (which passed the same checker when the base resume was VERIFIED) and the render is
    re-checked; a failure that survives the reverts (a template or renderer defect) fails the job with
    `ATS_CHECK_FAILED` / `GLYPH_CHECK_FAILED` and HR gets no file.
15. Keyword coverage of the posting requirements (only `existing` / `supported` ones) is computed and stored for HR as
    information. It never triggers keyword injection. **[call]**

**Layout gate (block):**

16. Page count: CV ≤ 2 pages and ≤ the page count of the senior's VERIFIED base PDF, which was rendered with the same
    catalog template (the snapshot of §3) and is read from the base, not re-rendered. **[call]** When the CV has more than one page, the last page is filled at
    least ~25 % (no near-empty trailing page); a one-page CV has no fill rule. **[builder]** exact measure via Typst
    `query`/metadata.
17. Glyph check: no dropped glyphs (`findUnrenderable` is already there).
18. **Visual check.** To keep A4, a check-only copy is rendered with placeholders for the name, the email and every
    `links` entry; the PNGs of that copy are what the model sees, never the real ones. Education and languages appear
    as they are (accepted with Q1). **[call]** The template gives the header block a fixed height and single-line
    contact fields, so placeholder widths cannot change the flow of the body; the real PDF's header is covered by the
    deterministic gates 13–17, which run on the real PDF. Typst exports each page as PNG; a vision-capable pool model
    answers a fixed checklist (overflow, overlapping text, ragged or orphan lines, broken bullets, uneven spacing,
    cut-off content) as structured booleans, each with the page and the text it concerns. **[call]** The vision model
    is an extra layer on top of 13–17, never a substitute for them. Against false positives: a failure counts only if
    a second vision call (another model of the pool when available, otherwise the same model again) confirms the same
    item; if that confirming call cannot run, the first finding counts.
    **Fail closed [call]:** the visual check is a required gate (G2). When no vision-capable route is configured, or
    every vision route fails or is exhausted for this run, the job fails with `VISUAL_CHECK_UNAVAILABLE` and HR gets no
    file; HR can retry later. The deterministic gates alone never publish.

**Layout repair:** first adjust layout knobs (`density`, `fontScale` within template bounds), then drop the
lowest-ranked bullets (by the reviewer's per-bullet relevance score; never the last bullet of an item), then
re-render and re-check; at most 3 rounds **[call]**. Still
failing → the job fails with `LAYOUT_UNFIXABLE` and HR gets no file.

### 6.5 Publish

19. The run's PDF is uploaded under a run-scoped key (it contains the `run_id`), so a run never overwrites the
    published file. Then, in one transaction, still owning the run (compare-and-set on `run_id`), and only if the base
    resume is still VERIFIED at `run_base_version` (else the run fails with `BASE_CHANGED`,
    nothing is published, and HR may regenerate): replace the published variant (tailored content, cover letter,
    layout, template, verification report, gap list, coverage, PDF key) with the run's result; `run_status` SUCCEEDED,
    `pdf_status` READY, and `pdf_render_id` set to a fresh value, so a late write from an older edit re-render (which
    compare-and-sets on its own `pdf_render_id`) can never overwrite the new PDF. Until this step the previous variant
    is untouched (§4 step 7). After commit the previous PDF object is deleted; a failed or swept run deletes its own uploaded
    object, and the sweep cron also removes objects under the table's prefix that no row references (crash between
    upload and commit). The client downloads the new file.

## 7. Inference changes (`@crm/inference`)

- **Cloudflare Workers AI route** added to the router's provider set (`HOSTED_PROVIDERS`), with pinned host
  `api.cloudflare.com`, own caps at 50 % of the free limit (ADR D5 pattern), and the ADR's failure classification.
  Unlike Gemini and Groq, its base URL carries the account id
  (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/`, OpenAI-compatible), so `HOSTED_BASE_URLS`
  becomes a constant template plus a validated account id from config (hex only), never a configurable host; the
  route config takes the account id next to the key. **[call]** The ADR needs an amendment for this.
  Keys: `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` already exist; r5 C-21 reserved them for resume generation,
  which this is. **[owner]** for Cloudflare in the pool; key reuse **[call]**.
- **Generation capability.** Today the package has only `extraction` (text → schema) and `decision` (Jev). Tailoring is
  schema-bound output too, so it can ride the extraction contract with a different instruction and a larger output
  budget; whether it is a new named port or the same port with a `purpose` is **[builder]**. Requirement: the caller
  can ask for "strong" models (the router's model choice must not pick the smallest free model for generation).
- **Vision input.** The visual check needs an image-capable call. The router speaks OpenAI-compatible chat; image
  parts must be supported on routes that offer vision (Gemini free and Cloudflare vision models are candidates;
  **[builder]** confirms against provider docs, `external-research` skill).
- **Jev questions** live in the feature module, not in the package (inference spec: "relevance questions live in the
  feature").
- **All-exhausted day.** Use the router's `LIMITS_EXHAUSTED` outcome and its localized HR notice (ADR H.2, H.8).
  Not on `main` yet: if job sourcing has not built it by slice 1, slice 1 builds it.
- **OpenRouter `:free` route** (ADR amendment 2026-11-08, §3.5): not built yet; it joins the generation pool when job
  sourcing builds it. Not a dependency of this feature.

## 8. Data model

New table `tailored_resumes` **[call]**, one row per `(job opportunity, senior)`:

- `id`, `job_opportunity_id` (FK, cascade), `senior_user_id` (FK users, cascade), unique on the pair.
- `base_resume_id` (FK `senior_resumes`), `base_version`, `opportunity_revision` — for the "base changed" hint.
- `content` (JSONB `ResumeContent`, the tailored fields merged over the frozen base), `cover_letter` (text),
  `layout` (JSONB `ResumeLayoutOptions`), `template_name` (the base resume's catalog template at generation time).
- Published variant columns (above) are written only by a successful run's publish step (§6.5) or by HR's edit.
- Run columns, separate from the published variant: `run_status` (QUEUED / RUNNING / SUCCEEDED / FAILED; null before
  the first run), `run_id`, `run_base_version` (the base `version` the run started from; checked at publish), `run_stage` (for progress), `run_queued_at`, `run_started_at`, `run_error_code`. A row with
  no published variant yet has `content` null.
- `verification` (JSONB: gate results, reverted items, coverage, gap list, model routes used — no posting text).
- PDF columns, separate from the generation run because an HR edit re-renders without a run: `pdf_status` (the
  existing `resumeRenderStatusSchema` values, as the base resume PDF uses; IDLE until the first publish),
  `pdf_render_id` (ownership of the re-render; every write of a rendered PDF compare-and-sets on it),
  `pdf_render_started_at`, `pdf_render_error`, `pdf_s3_key` (run- or render-scoped, §6.5), `pdf_fingerprint`. The
  sweep cron also fails a re-render RUNNING past 2 min **[call]**: `pdf_status` FAILED with the error, the previous
  PDF key stays served, and HR can save again.
- **The variant is a snapshot.** `content` holds the frozen fields as they were when verified. An edit re-render uses
  the snapshot, not the current base resume; a later base change only raises the "base changed" hint (§4 step 9).
  Only the header (display name and `users.email`) is read from the current user row at every render. **[call]**
- `generated_by_user_id`, `generated_at`, `edited_by_user_id`, `edited_at`.

A successful regenerate overwrites the published variant. Old content is not kept (G4 asks for confirmation
instead). Migration via the normal
Drizzle path; prod DDL via `deploy.yml` as usual.

## 9. API

All under the job queue controller's scope rules, ADMIN and HR. Every request carries `teamId` like the other queue
endpoints (query or body; absent = an ADMIN's studio scope, an HR's first team), resolved by
`JobQueueScopeService.resolve`; the senior is authorised with the same eligibility check the submission path uses
(`assertSeniorEligible`: senior in the resolved scope and matched to the opportunity). Any failure is the queue's
uniform `JOB_OPPORTUNITY_NOT_FOUND` 404.

| Method + path                                        | Purpose                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /job-queue/:id/seniors/:seniorId/tailored`     | Start generation. Body `{ teamId?, overwrite: boolean }`. Idempotent while a run is QUEUED/RUNNING: returns 202 with that run (a double click starts nothing new). 409 if a published variant exists and `overwrite` is false, and 409 while an edit re-render is in flight (`pdf_status` QUEUED/RUNNING) |
| `GET  /job-queue/:id/seniors/:seniorId/tailored`     | Status, stage, cover letter, editable fields, verification summary, "base changed" flag                                                                                                                                                                                                                   |
| `GET  /job-queue/:id/seniors/:seniorId/tailored/pdf` | The published PDF. 202 while `pdf_status` is QUEUED/RUNNING, or while a run is QUEUED/RUNNING and nothing is published yet; during a regenerate run the previous PDF is served. 404 (the uniform one) when nothing is published and no run is active                                                      |
| `PUT  /job-queue/:id/seniors/:seniorId/tailored`     | HR edits: summary, skills, bullets, cover letter. Zod-validated against `RESUME_LIMITS`; re-render only. One conditional UPDATE (`run_status` not QUEUED/RUNNING), so it cannot race a POST; 409 otherwise                                                                                                |

Throttle generation per user (pattern of the resume upload throttle, e.g. 10/min) and a per-day generation cap per
team **[builder]** for the numbers. Every generate / edit writes an audit row (`jobQueueActions` gains kinds, or the
audit interceptor) **[builder]**.

The downloaded file name: `<Senior name> - <Job title> - CV.pdf`, sanitised **[call]**.

## 10. Delivery slices (proposal for the plan)

0. **Prerequisites:** job sourcing SFS U10 part 3 (detail-on-demand consumer) merged and ON_DEMAND enabled (§11 Q3);
   the base resume design shipped (facts, VERIFIED status, template catalog, shared ATS checker, CI suite).
1. Inference: Cloudflare route in the router + generation capability + vision input. Inert until a consumer exists.
   The base resume design needs it too, so it ships before that design's backend slice.
2. Renderer: an `email` field in `ResumeRenderInput` printed in the header (today the input has only `displayName`,
   `content`, `layout`, `templateSource`) + placeholder mode for the check-only copy + page count / PNG export in
   `ResumeTypstService`. Template hardening itself moves to the base resume design.
3. Backend module `tailored-resumes`: table, run lifecycle + sweep cron, prepare + generate + content gates + repair,
   Jev questions.
4. Wiring of the shared ATS / layout / visual gates + layout repair.
5. API + RBAC + audit.
6. Web: row states, edit form, dialog, auto-download, copy (design gate first).
7. Manual QA on the real stack with real seniors' resumes (owner-run where it needs live keys).

Security review is mandatory on slices 3 and 5 (PII to providers, RBAC). Each slice ships tests first.

## 11. Open questions for the owner

All answered by the owner on 2026-11-10 (after the builder check).

- **Q1. Providers for senior resume fields → the whole pool, Gemini included. [owner]** The owner accepts that
  Gemini's free tier may train on and human-review the tailored fields (router ADR §4), and that company + role +
  period can identify a person without the name. Name and contacts still never leave (A4). The pool for generation is
  Gemini + Groq + Cloudflare; the OpenRouter `:free` route joins when job sourcing builds it and is not a dependency.
- **Q-contact. The CV header email is the senior's registration email, `users.email`. [owner]** It is the work
  address the studio creates for each senior, not one of the extra addresses in `user_emails`. The template prints it;
  the ATS gate checks it. It is never sent to a model (A4).
- **Q2. Base resume not fully in English → generation is blocked. [owner]** Every field counts, the frozen ones
  included (`period` is free text). The button is disabled with "the base resume must be in English"; no translation.
  Detection is deterministic (non-Latin letters in any field) **[call]**. The senior's display name printed on the
  CV must be Latin too; otherwise the same block applies with "set the English name" **[call]**.
- **Q3. Posting text truncated or missing → fetch the full text on demand first. [owner]** Generation always works
  from the full posting description: the prepare step (§6.1) triggers the on-demand detail fetch and waits for it.
  This makes the SFS U10 detail-on-demand consumer (DETAIL_ONLY run scope, open endpoint, ON_DEMAND flip) a
  **prerequisite** of this feature. If a source cannot return a full description even after the fetch, generation
  proceeds with what exists and the row says "posting text was partial" **[call]**.

## 12. Risks

- **Free-tier quality and quota.** Strong-enough free models may hit daily limits; generation then waits for the next
  day with the router's notice. Paid fallback is out of scope.
- **Vision-model false alarms** can make layout repair drop good bullets. Mitigation: deterministic gates first; vision
  findings need evidence; repair is bounded.
- **Over-conservative fact gate** may revert most rewording on resumes with thin bullets. Measured in slice 7 QA.
- **"100 % valid"** is guaranteed for the deterministic checks; the vision check reduces but cannot exclude a visual
  defect a model misses.
