# Verified Base Resume + Template Catalog + ATS Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR enters a senior's resume as facts. On submit the system writes summary and bullets with AI and checks
them against the facts. It renders the PDF with the senior's catalog template and runs ATS, layout and visual gates.
HR or ADMIN confirms the result, which makes the resume VERIFIED. This is the prerequisite for per-vacancy CV
generation.

**Architecture:** Shared Zod schemas and pure functions live in `@crm/shared`: facts, completeness, the skills
vocabulary and the catalog enum. The api work goes in new files under `apps/api/src/resumes/verification/` and
`apps/api/src/resumes/ats/`. `resumes.service.ts` is already 1181 lines and must not grow by more than the
delegation lines. Check runs follow the module's existing pattern: an in-process fire-and-forget job, run-id CAS
ownership and a sweep cron. Model calls go through the extraction worker. The prompts and schemas for those calls are
fixed inside the worker, never supplied by the caller. Entailment goes to Jev through `@crm/inference`'s
`createJevDecisionAdapter`.

**Tech Stack:** NestJS 11 + Fastify, Drizzle (Postgres), Zod v4, Typst 0.15.1 (sandboxed, pinned), `unpdf`, Vitest,
React + TanStack Query/Form, Lingui (uk/en), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-base-resume-ats-design.md` (approved by the owner 2026-11-10). Context:
`docs/architecture/2026-11-10-ats-resume-parsing-research.md`. The tailored design
(`docs/superpowers/specs/2026-11-10-tailored-resume-design.md`) consumes this plan's interfaces. It gets its own plan
after Phase B of this one lands.

## Global Constraints

- Typst stays at 0.15.1 (pinned in `apps/api/Dockerfile`, installed in CI by `install-typst-from-dockerfile.sh`). No
  bump in this plan.
- No new npm runtime dependency. Fonts are repo assets with their license file
  (`apps/api/src/assets/fonts/LICENSE.txt`).
- Resume content is English only. Every text field must be Latin-script, display name included (spec §5.1).
- Every visible web string goes through Lingui in `uk` + `en` catalogs. Server error `message` fallbacks stay English.
- Only the shared pool may be called. Never call a paid OpenRouter model. A model call never carries the display
  name, `users.email`, any `user_emails` address, location, education, languages or links (spec §5.2).
- Never write to live `crm_db`. Schema sync, seeds and integration specs run on a scratch DB, with `DATABASE_URL` set
  inline. Push feature branches as `DATABASE_URL= git push`.
- `version` is bumped on every write to facts, content, layout or template. VERIFIED holds only while
  `verified_version = version` (spec §8).
- Confirm is ADMIN/HR only. Facts edit and Submit follow `canAccessResume` write (spec §4, Q-C).
- A resume with `templateSource` set (custom template) can never become VERIFIED (spec §2 non-goals).
- The visual gate fails closed with `VISUAL_CHECK_UNAVAILABLE` (tailored spec §6.4 item 18).
- Zones: `.github/workflows/**` = DevOps agent; `apps/**` and `packages/**` = Coder. Security review is mandatory on
  Phases C and D (PII to providers, RBAC on confirm).
- Run E2E locally before pushing code. UI tasks pass the design gate (`.claude/rules/common/design-gate.md`).

## Review Focus

1. **Existing resume with an unparseable free-text period** (`"2019 — наст. время"`, Cyrillic content). Lazy mapping
   must not crash. The month stays empty, completeness lists `experience.N.start` and `NON_LATIN` per field, and
   Submit stays disabled. Test: Task 3, `contentToFacts` cases; Task 4, NON_LATIN case.
2. **Facts edited from a second tab while a run is CHECKING.** PUT returns 409 `RESUME_VERIFICATION_BUSY` and the
   run's result is not overwritten. A facts edit in AWAITING_CONFIRM sets DRAFT and deletes the staged object.
   Test: Task 13.
3. **Two HRs click Confirm at once, or Confirm races a facts edit.** Exactly one promotion happens; the loser gets
   409 and `version` is unchanged by the loser. Test: Task 15, concurrent-confirm integration spec.
4. **Notes contain a phone, an email or the senior's own full name.** Completeness flags `CONTACT_IN_TEXT`. The
   payload sent to the writer carries `[REDACTED]` instead, and a model output that still contains a hit fails that
   item into repair. Test: Task 9, contact scan; Task 14, runner redaction.
5. **Writer, Jev or vision is unconfigured or exhausted, including during a template change of a VERIFIED resume.**
   The run fails with `WRITER_UNAVAILABLE` / `ENTAILMENT_UNAVAILABLE` / `VISUAL_CHECK_UNAVAILABLE`. The live content,
   template and PDF stay untouched, and the resume stays VERIFIED. Test: Task 16.

---

## Phase A — Shared contracts (spec slice 1)

### Task 1: Facts, catalog and verification schemas

**Files:**

- Create: `packages/shared/src/schemas/resume-facts.ts`, `packages/shared/src/schemas/resume-facts.spec.ts`
- Modify: `packages/shared/src/schemas/resume.ts` (DTO fields), the shared schemas barrel that exports `resume.ts`,
  `packages/shared/src/schemas/api-errors/` (codes `RESUME_VERIFICATION_BUSY`, `RESUME_CONFIRM_STALE`,
  `RESUME_INCOMPLETE`, `RESUME_CUSTOM_TEMPLATE`, following that directory's pattern)

**Interfaces:**

- Produces:
  - `resumeMonthSchema`: string `/^\d{4}-(0[1-9]|1[0-2])$/` (`YYYY-MM`).
  - `resumeFactsExperienceSchema`: `{ company, role, location: string | null, start: month | null, end: month | null,
current: boolean, technologies: string[], notes: string[] }`. `start` is nullable because a DRAFT may be
    incomplete; completeness blocks Submit instead.
  - `resumeFactsSchema`:
    - `headline`;
    - `location: { city, country }`;
    - `workFormat: 'remote' | 'hybrid' | 'onsite' | null`;
    - `skills: string[]`;
    - `experience`;
    - `education: { institution, degree, startYear: int | null, endYear: int | null }[]`;
    - `languages: { name, level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' | 'native' }[]`;
    - `links: resumeLinkSchema[]`.

    Limits reuse `RESUME_LIMITS`. Type `ResumeFacts`.

  - `EMPTY_RESUME_FACTS`.
  - `RESUME_TEMPLATE_NAMES = ['classic', 'modern', 'compact', 'technical'] as const`, `resumeTemplateNameSchema`, type
    `ResumeTemplateName`.
  - `resumeVerificationStatusSchema = z.enum(['DRAFT', 'QUEUED', 'CHECKING', 'AWAITING_CONFIRM', 'VERIFIED', 'FAILED'])`.
  - `resumeVerificationErrorCodeSchema = z.enum(['INCOMPLETE', 'CUSTOM_TEMPLATE', 'WRITER_UNAVAILABLE',
'ENTAILMENT_UNAVAILABLE', 'RENDER_FAILED', 'ATS_CHECK_FAILED', 'GLYPH_CHECK_FAILED', 'LAYOUT_UNFIXABLE',
'VISUAL_CHECK_FAILED', 'VISUAL_CHECK_UNAVAILABLE', 'STALLED'])`.
  - `resumeVerificationReportSchema`: `{ gates: { gate: string; ok: boolean; items: { path: string; reason: string }[] }[];
fallbacks: string[] }`. `fallbacks` lists the content paths that reverted to note text.
  - `updateResumeFactsSchema = { facts }`, `updateResumeTemplateSchema = { templateName }`,
    `confirmResumeSchema = { runId: uuid, version: int }`,
    `editStagedFieldSchema = { runId: uuid, path: string, text: string }`,
    `regenerateStagedFieldSchema = { runId: uuid, path: string }`.
  - `seniorResumeDtoSchema` gains:
    - `facts`, `verificationStatus`, `verificationErrorCode` (nullable), `verificationReport` (nullable);
    - `verifiedVersion` (nullable int), `verifiedAt` (nullable), `verifiedByName` (nullable);
    - `staged: { runId; content; layout; templateName; pdfAvailable: boolean } | null`.

    `templateName` becomes `resumeTemplateNameSchema`. `seniorResumeResponseSchema` gains `canConfirm: boolean`,
    which sits next to `canEdit` for the same reason.

- [ ] **Step 1: Write failing tests** in `resume-facts.spec.ts`:
  - `rejects month "2021-13"` and `accepts "2021-03"`;
  - `facts with start null parse (draft allowed)`;
  - `templateName "fancy" is rejected`;
  - `link "javascript:alert(1)" is rejected` (reuses `isSafeResumeUrl`);
  - `EMPTY_RESUME_FACTS parses`.
- [ ] **Step 2:** Run `pnpm --filter @crm/shared test resume-facts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the schemas above. Export them from the shared barrel.
- [ ] **Step 4:** Run the same command, then `pnpm --filter @crm/shared typecheck`. Expected: PASS, non-zero case
      count.
- [ ] **Step 5:** Commit `feat(shared): resume facts, template catalog and verification schemas`.

### Task 2: Canonical skills vocabulary

**Files:**

- Create: `packages/shared/src/schemas/resume-skills.ts`, `packages/shared/src/schemas/resume-skills.spec.ts`

**Interfaces:**

- Produces:
  - `SKILL_SYNONYM_GROUPS: readonly { canonical: string; aliases: readonly string[] }[]`;
  - `canonicalSkill(raw: string): string`;
  - `mergeSkills(skills: string[], technologies: string[][]): string[]`;
  - `mentionsSkill(text: string, skill: string): boolean`, word-boundary safe. The tailored plan reuses it in its
    fact gate.
- Values (spec §3): `NodeJS`/`node`/`Node JS` → `Node.js`. Acronym plus full form where the vocabulary has one:
  `AWS` → `Amazon Web Services (AWS)`. Symbols survive: `C#`, `C++`, `.NET`, `CI/CD`.
  - Seed groups: JavaScript, TypeScript, Node.js, React, Next.js, Vue.js, Angular, Python, Go, Java, Kotlin, C#, C++,
    .NET, PostgreSQL, MySQL, MongoDB, Redis, Docker, Kubernetes, AWS, GCP, Azure, Terraform, CI/CD, GraphQL, REST.
  - **[builder]** may add more groups.

- [ ] **Step 1: Failing tests:**
  - `canonicalSkill("nodejs") === "Node.js"`;
  - `canonicalSkill("aws") === "Amazon Web Services (AWS)"`;
  - `canonicalSkill("Elixir") === "Elixir"` (unknown passes through, trimmed);
  - `mergeSkills(["React","react"],[["TypeScript","Node JS"]])` deep-equals `["React","TypeScript","Node.js"]`
    (first-seen order, deduplicated);
  - `mentionsSkill("JavaScript developer","Java") === false`;
  - `mentionsSkill("used C# daily","C#") === true`;
  - `mentionsSkill("on .NET 8",".NET") === true`.
- [ ] **Step 2:** Run `pnpm --filter @crm/shared test resume-skills`. Expected: FAIL.
- [ ] **Step 3:** Implement. Matching is case-insensitive on a normalised key (lowercase; spaces, dots and hyphens
      collapsed). `mentionsSkill` uses boundaries that treat `#`, `+` and `.` as part of the token.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shared): canonical resume skills vocabulary`.

### Task 3: Deterministic content and legacy mapping

**Files:**

- Create: `apps/api/src/resumes/verification/derive-content.ts`, `.../derive-content.spec.ts`

**Interfaces:**

- Consumes: `ResumeFacts`, `canonicalSkill`, `mergeSkills`.
- Produces:
  - `formatPeriod(start: string, end: string | null, current: boolean): string`. Outputs `"Mar 2021 – May 2023"` and
    `"Mar 2021 – Present"` (en dash U+2013 with spaces, English 3-letter months).
  - `formatYears(start: number | null, end: number | null): string`. Outputs `"2015 – 2019"`; with only one year
    known, that year alone.
  - `yearsOfExperience(items: ResumeFacts['experience'], now: Date): number`. Union of the intervals, floored to whole
    years; overlapping jobs count once.
  - `deriveFrozenContent(facts: ResumeFacts): ResumeContent`. It fills everything except `summary` (`''`) and each
    item's `bullets` (`[]`); skills come from `mergeSkills`.
  - `contentToFacts(content: ResumeContent): ResumeFacts`. This is the lazy mapping for legacy rows (spec §3): bullets
    become notes, and the period is parsed by `parseFreePeriod`.
  - `parseFreePeriod(text: string): { start: string | null; end: string | null; current: boolean }`. It accepts:
    - `Mar 2021 – Present`;
    - `2021-03 – 2023-05`;
    - `03/2021 - 05/2023`;
    - a year only (the month stays `null`);
    - `Present`/`Current`/`Now` and the Cyrillic forms `наст`, `тепер`, `по н.в.` as `current`.

    Anything else gives `null` months and never throws.

- [ ] **Step 1: Failing tests:**
  - `formatPeriod("2021-03", null, true) === "Mar 2021 – Present"`;
  - `yearsOfExperience` with the overlapping items 2015-01..2018-12 and 2017-01..2020-12 at now=2021-01 is `6`;
  - `parseFreePeriod("2019 — наст. время")` gives `{ start: null, end: null, current: true }` with `start` null
    because no month;
  - `parseFreePeriod("garbage")` gives all null and false;
  - `contentToFacts(EMPTY_RESUME_CONTENT)` parses with `resumeFactsSchema`.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test derive-content`. Expected: FAIL.
- [ ] **Step 3:** Implement. Pure functions with no Nest dependencies.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): deterministic resume fields and legacy facts mapping`.

### Task 4: Completeness check (shared, live in the UI and enforced on the server)

**Files:**

- Create: `packages/shared/src/schemas/resume-completeness.ts`, `.../resume-completeness.spec.ts`

**Interfaces:**

- Produces:
  - `checkResumeCompleteness(facts: ResumeFacts, ctx: { displayName: string; now: Date }): CompletenessIssue[]`;
  - `CompletenessIssue = { path: string; code: CompletenessCode }`. Paths look like `experience.1.start` and
    `skills`.
  - `CompletenessCode`, from spec §5.1: `HEADLINE_MISSING`, `NO_EXPERIENCE`, `COMPANY_MISSING`, `ROLE_MISSING`,
    `START_MISSING`, `END_MISSING`, `END_BEFORE_START`, `START_IN_FUTURE`, `NO_NOTES`, `TOO_FEW_SKILLS` (<5 after
    `mergeSkills`), `ENGLISH_MISSING`, `NON_LATIN`, `NAME_NON_LATIN`, `CONTACT_IN_TEXT` (phone or email shapes in notes,
    headline or skills);
  - `isLatinScript(text: string): boolean`. Every `\p{L}` must be `\p{Script=Latin}`.

  **[builder]** Reuse an existing Latin helper if `ast-grep` finds one.

- [ ] **Step 1: Failing tests, one per code.** Also:
  - a `José Müller` display name passes;
  - a note `"call me +380 67 123 45 67"` gives `CONTACT_IN_TEXT` at `experience.0.notes.0`;
  - a fully filled fixture gives `[]`.
- [ ] **Step 2:** Run `pnpm --filter @crm/shared test resume-completeness`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shared): resume completeness check`.

## Phase B — Templates, ATS checker, CI suite (spec slice 2)

### Task 5: Template catalog on one skeleton

**Files:**

- Create:
  - `apps/api/src/assets/typst/resume-skeleton.typ`;
  - `apps/api/src/assets/typst/themes/{classic,modern,compact,technical}.typ`;
  - one OFL serif font family (regular and bold, Latin Extended) for `classic` under `apps/api/src/assets/fonts/`,
    with its license appended to `LICENSE.txt`.
- Modify:
  - `apps/api/src/resumes/resume-typst.service.ts`: replace `loadDefaultTemplate` with `loadCatalogTemplate`, and add
    `templateName` to `ResumeRenderInput`;
  - `apps/api/src/resumes/resume-glyphs.ts`: coverage per template font;
  - `resume-typst.service.spec.ts`.
- Delete: `apps/api/src/assets/typst/default-resume.typ`, once its content has moved into the skeleton.

**Interfaces:**

- Produces:
  - `loadCatalogTemplate(name: ResumeTemplateName): string`. It returns the theme's `#let theme = (...)` dictionary
    concatenated with the skeleton, as one source string. The sandbox (`--root` on a scratch dir) and
    `ResumeRenderInput.templateSource` stay single-file, and the fingerprint covers the theme automatically.
  - `resumeFontCoverage(template: ResumeTemplateName): Set<number>`.
  - `findUnrenderable(text, template)`.

  `ResumeRenderInput` becomes `{ displayName, email, content, layout, templateName, templateSource: string | null }`.
  `email` is printed as body text under the name. Existing render callers (`runRender`) load `users.email` together
  with the display name.

- Skeleton rules (spec §6), each one a test:
  - single column;
  - fixed headings `Summary` / `Experience` / `Skills` / `Education` / `Languages` / `Links` as real Typst headings,
    in `layout.sectionOrder`, and absent when hidden;
  - name and contacts as body text, never in `page(header:)`/`footer`;
  - no images, icons, `place` or floats;
  - `#set text(ligatures: false)`;
  - `#set document(title: <displayName> + " — Resume")`;
  - no letter-spaced headings (`tracking` 0).

  Themes may change only font, accent colour, size and weight, rules, margins and spacing, and header style.
  Experience items print role, company and period on the lines before their bullets.

- **[builder]** Run `typst compile --help` on 0.15.1 for the PDF standard flag. If `ua-1` compiles every fixture,
  pass it. Otherwise keep the tagged default and record why in the report.

- [ ] **Step 1: Failing tests:**
  - `loadCatalogTemplate` returns distinct sources for all 4 names;
  - `render()` with each name produces a PDF that starts with `%PDF`;
  - a theme source containing `place(` or `image(` fails a static lint test (`themes do not use place/image/header`).
- [ ] **Step 2:** Run `pnpm --filter @crm/api test resume-typst`. Expected: FAIL.
- [ ] **Step 3:** Implement the skeleton and the themes. Point existing callers at
      `loadCatalogTemplate(row.templateName ?? 'classic')`.
- [ ] **Step 4:** Run `pnpm --filter @crm/api test resume-typst resume-glyphs`. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(api): resume template catalog on a shared ATS-safe skeleton`.

### Task 6: ATS checker

**Files:**

- Create: `apps/api/src/resumes/ats/resume-ats-checker.ts`, `.../resume-ats-checker.spec.ts`
- Modify: `apps/api/src/resumes/resume-text-extraction.service.ts`. Add `extractRenderedPages`, reusing the existing
  sandbox and limits.

**Interfaces:**

- Produces:
  - `extractRenderedPages(pdf: Buffer): Promise<string[]>`: one string per page, line breaks preserved.
  - `checkResumeAts(input: AtsCheckInput): AtsReport`, pure.
  - `AtsCheckInput = { content: ResumeContent; layout: ResumeLayoutOptions; displayName: string; email: string;
pages: string[]; pdfBytes: number }`.
  - `AtsReport = { ok: boolean; failures: AtsFailure[] }`, `AtsFailure = { code: AtsFailureCode; path?: string;
detail: string }`.
  - `AtsFailureCode`: `MISSING_TEXT`, `HEADING_MISSING`, `HEADING_ORDER`, `HIDDEN_SECTION_PRESENT`, `ITEM_ORDER`,
    `PERIOD_FORMAT`, `CONTACT_NOT_IN_BODY`, `REPLACEMENT_CHAR`, `LIGATURE`, `LETTER_SPACED`, `TOO_MANY_PAGES`,
    `TOO_LARGE`.
  - Constants `ATS_MAX_PAGES = 2`, `ATS_MAX_BYTES = 1_048_576`, `PERIOD_PATTERN`. `PERIOD_PATTERN` matches exactly
    the output of `formatPeriod`.
- Rules (spec §5.3):
  - Compare after whitespace normalisation. A bullet that wraps across lines still matches.
  - Each heading is alone on a line, in effective order (`normalizeResumeLayout`).
  - The name and the email appear on page 1 before the first heading.
  - Letter-spacing is detected by `/\b(?:\p{L} ){3,}\p{L}\b/u`, any case.
  - Ligature code points are U+FB00–U+FB06.

- [ ] **Step 1: Failing tests** on hand-written `pages` arrays, one per failure code. Also:
  - a clean case gives `ok: true`;
  - an extracted bullet split over two lines still passes;
  - `e x p e r i e n c e` (lowercase) fails with `LETTER_SPACED`, and `A B testing` passes.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test resume-ats-checker`. Expected: FAIL.
- [ ] **Step 3:** Implement `checkResumeAts` and `extractRenderedPages`. **[builder]** confirms that `unpdf` with
      `mergePages: false` keeps line ends. The test `extractRenderedPages keeps heading on its own line` renders the
      `classic` fixture and asserts it.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): ATS checker on the rendered PDF text layer`.

### Task 7: ATS suite (matrix, equivalence, golden, negative controls)

**Files:**

- Create:
  - `apps/api/src/resumes/ats/__ats__/fixtures.ts`: the synthetic people of spec §7;
  - `apps/api/src/resumes/ats/__ats__/ats-matrix.ats.spec.ts`;
  - `apps/api/src/resumes/ats/__ats__/golden/<template>.<fixture>.txt`;
  - `apps/api/src/resumes/ats/__ats__/negative/{two-column,letter-spaced}.typ`.
- Modify: `apps/api/package.json`, adding `"test:ats": "vitest run --dir src/resumes/ats/__ats__"`. Exclude
  `*.ats.spec.ts` from the default `test` run, following the existing vitest include config.

**Interfaces:**

- Consumes: `loadCatalogTemplate`, `ResumeTypstService.render`, `extractRenderedPages`, `checkResumeAts`.
- Produces: an env var `ATS_MATRIX_OUT=<dir>` that makes the suite write every matrix PDF to `<dir>` for Task 8.

- [ ] **Step 1: Write the suite:**
  - `every template × every fixture passes checkResumeAts`.
  - `parsed field set is identical across templates` (A3). Map extracted text back to `{headings, items:
[{role, company, period}], skills}` and deep-equal across templates.
  - `extracted text equals golden`. Update the goldens only with `ATS_UPDATE_GOLDEN=1`.
  - `two-column negative control fails with ITEM_ORDER or MISSING_TEXT`.
  - `letter-spaced negative control fails with LETTER_SPACED`.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test:ats`. Expected: FAIL (no goldens), then
      `ATS_UPDATE_GOLDEN=1 pnpm --filter @crm/api test:ats`. Review the goldens by reading two of them.
- [ ] **Step 3:** Run `pnpm --filter @crm/api test:ats` again. Expected: PASS. The case count is non-zero and equals
      4 templates × N fixtures + equivalence + golden + 2 negatives.
- [ ] **Step 4:** Commit and push `test(api): ATS matrix suite with goldens and negative controls`.

### Task 8: CI jobs (DevOps agent)

**Files:**

- Modify: `.github/workflows/ci.yml`. Two jobs, both path-filtered to the templates, fonts, `resume-typst.service.ts`,
  `resume-glyphs.ts`, `ats/**` and the Dockerfile Typst stage.
- Create: `scripts/devops/openresume-oracle.mjs`.

**Interfaces:**

- Job `ATS suite`: installs Typst with the existing step, then runs `pnpm --filter @crm/api test:ats`.
- Job `ATS oracle (OpenResume)`:
  - runs `ATS_MATRIX_OUT=$RUNNER_TEMP/ats-pdfs pnpm --filter @crm/api test:ats`;
  - checks out OpenResume at a pinned commit sha into `$RUNNER_TEMP`, never into the repo (AGPL, spec §9 Q-A);
  - runs its PDF parser over the PDFs and asserts name, email, every company, role and period.

  Do not register either job as a required check without the owner. Renaming a required job breaks merges.

- [ ] **Step 1: Spike.** Make OpenResume's parser (`src/app/lib/parse-resume-from-pdf`) run under Node on one PDF. If
      that takes more than one working day, stop and report to Master with the blocker. The oracle is then an A2
      decision for the owner, and Task 8's first job still ships.
- [ ] **Step 2:** Write both jobs and the script.
- [ ] **Step 3:** Push and run `gh pr checks`. Expected: both jobs listed and green, and the oracle log names a
      non-zero PDF count.
- [ ] **Step 4:** Commit `ci: ATS suite and OpenResume oracle jobs`.

## Phase C — Model access (writer, vision, Jev)

### Task 9: Contact scan and fact gate (pure)

**Files:**

- Create: `apps/api/src/resumes/verification/contact-scan.ts`, `fact-gate.ts`, and their specs.

**Interfaces:**

- Produces:
  - `scanContacts(text: string, ctx: ContactContext): ContactHit[]`.
    - `ContactContext = { fullName: string; emails: string[] }`. `emails` is `users.email` plus all `user_emails`
      rows.
    - `ContactHit = { kind: 'phone' | 'email' | 'name'; match: string }`. A name hit means the full name or the
      surname at a word boundary, never the first name alone (tailored spec §3).
  - `redactContacts(text: string, ctx: ContactContext): string`. Each hit is replaced by `[REDACTED]`.
  - `findUngroundedTokens(text: string, source: { text: string; skills: string[] }): string[]`. It returns numbers,
    vocabulary skill tokens (`mentionsSkill`) and capitalised non-sentence-initial words of `text` that are absent
    from `source`. Shared with the tailored plan.

- [ ] **Step 1: Failing tests:**
  - first name "Mark" alone is no hit;
  - "Mark Levin" and "Levin" are name hits;
  - `+380671234567` is a phone hit;
  - `"cut latency by 40%"` against a source without `40` gives `["40"]`;
  - `"Built Kafka pipeline"` against skills without Kafka gives `["Kafka"]`;
  - a sentence-initial `"Led"` is not flagged.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test contact-scan fact-gate`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): contact scan and deterministic fact gate`.

### Task 10: Worker endpoint `POST /resume-write`

**Files:**

- Create: `apps/api/src/extraction-worker/resume-write.ts` (prompts, schemas, handler) and its spec.
- Modify:
  - `apps/api/src/extraction-worker/server.ts` (route);
  - `apps/api/src/extraction-worker/schema.ts` (body schema);
  - `packages/inference/src/contracts/extraction.ts`: `ExtractionRequest` gains `modelPreference?: 'largest'`;
  - `packages/inference/src/router/router.ts`: with `'largest'`, order the healthy candidates by model size, largest
    first; without it, behaviour is unchanged. `model-picks.ts` feeds only `model-refresh.ts`, not per-call routing,
    so the preference belongs in the router. Add a spec for it.

**Interfaces:**

- Body `{ task: 'summary' | 'bullets'; payload: string; feedback: string[] }`. `payload` is JSON of the minimised
  facts of spec §5.2, at most `MAX_WORKER_INPUT_CHARS`.
- Reply `{ kind: 'ok'; summary: string } | { kind: 'ok'; items: { index: number; bullets: string[] }[] } |
{ kind: 'unavailable'; reason: string }`.
- Prompts are fixed strings in the worker. The caller cannot send an instruction. The rules carry the adopted
  career-ops wording "Reformulate, never fabricate" and "no ownership-verb inflation". Bullets are action verb +
  scope + result, with numbers only from the notes. The summary is 3–4 sentences.
- `resume-write` calls the router with `modelPreference: 'largest'`. Tests in the router spec:
  - `largest preference never picks the smallest model when a larger one is healthy`;
  - `no preference keeps today's order`.
- Same shared-secret auth as `/extract`.

- [ ] **Step 1: Failing tests:**
  - an unknown `task` gives 400;
  - a missing secret gives 401;
  - a fake router returning `{summary}` gives `kind ok`;
  - router exhausted gives `kind unavailable`;
  - a payload over the limit gives 400.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test resume-write` and `pnpm --filter @crm/inference test router`.
      Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(inference): worker resume-write endpoint with strong-model pick`.

### Task 11: Worker endpoint `POST /visual-check` (vision)

**Files:**

- Create: `apps/api/src/extraction-worker/visual-check.ts` and its spec. Write
  `docs/architecture/2026-11-XX-vision-routes-research.md` first, using the `external-research` skill: which free
  Gemini and Groq models accept OpenAI-compatible `image_url` data URLs, and their limits.
- Modify: `packages/inference/src/internal/chat-completions.ts` (image content parts) and its spec;
  `apps/api/src/extraction-worker/server.ts`.

**Interfaces:**

- Body `{ pages: string[] }`: base64 PNG, at most 2 pages of at most 1.5 MB each.
- Reply `{ kind: 'ok'; findings: { check: VisualCheck; page: number; text: string }[] } |
{ kind: 'unavailable'; reason: string }`.
- `VisualCheck` is one of `overflow`, `overlap`, `ragged`, `orphan`, `broken-bullet`, `uneven-spacing`, `cut-off`.
- Image parts are sent only to routes the research marks as vision-capable. With no such route, the reply is
  `unavailable`.

- [ ] **Step 1: Failing tests:**
  - with no vision route configured, the reply is `unavailable`;
  - the fake model's findings are parsed;
  - 3 pages give 400;
  - the image part serialises as `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test visual-check` and `pnpm --filter @crm/inference test
chat-completions`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(inference): worker visual-check endpoint with image parts`.

### Task 12: api-side clients (writer, vision, Jev entailment)

**Files:**

- Create: `apps/api/src/resumes/verification/inference-clients.ts` and its spec.

**Interfaces:**

- Consumes:
  - `JEV_API_KEY` from `apps/api/src/config/env.ts`, which already defines it;
  - `EXTRACTION_WORKER_URL` / `EXTRACTION_WORKER_SECRET`. These are **not** in `env.ts`.
    `apps/api/src/job-sourcing/structuring/model-extraction-wiring.ts` reads them with its own `envSchema` over
    `MODEL_EXTRACTION_ENV_KEYS`. Move that reading into an exported `readExtractionWorkerEnv(rawEnv)` next to it and
    use it from both places. Do not add the keys to `env.ts` a second time, and do not change the deploy env, because
    the keys already exist wherever job sourcing runs;
  - `createExtractionWorkerAdapter`'s HTTP transport;
  - `createJevDecisionAdapter`, `MAX_DECISION_QUESTIONS`.
- Produces three Nest providers. Each is `unavailable` when its env is unset:
  - `ResumeWriterClient.write(task, payload, feedback): Promise<WriterReply>`.
  - `VisualCheckClient.check(pngPages: Buffer[]): Promise<VisualReply>`.
  - `ResumeEntailmentClient.score(claims: { id: string; text: string; sources: string[] }[]): Promise<Map<string,
number> | 'unavailable'>`.
    - Jev questions go in chunks of ≤ 50 (⌈q/50⌉ requests).
    - Each question is of kind `noul`: "Is this statement fully supported by these source statements? Inflated
      ownership verbs count as unsupported."
    - Constant `ENTAILMENT_THRESHOLD = 0.8` **[call]**. A Jev `noul` answer is `{ value: boolean, probability }`. The
      returned score is `value ? probability : 1 - probability`, and a claim counts as supported only when
      `value === true && probability >= ENTAILMENT_THRESHOLD`.

- [ ] **Step 1: Failing tests:**
  - 120 claims give 3 Jev requests;
  - a missing key gives `'unavailable'`;
  - a writer at an unset URL gives `unavailable`, never a throw;
  - `noul {value:false, probability:0.9}` is not supported;
  - `model-extraction-wiring` tests still pass after the env move.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test inference-clients`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): writer, vision and entailment clients for resume verification`.

## Phase D — Backend flow (spec slice 3; security review mandatory)

### Task 13: Columns, facts write, DRAFT reset, 409 while busy

**Files:**

- Modify:
  - `apps/api/src/database/schema/resumes.ts`: the columns of spec §8, plus:
    - `verification_kind` (`full` / `item` / `staged-edit` / `template`);
    - `verification_target_path`;
    - `verification_base_version` (the `version` the run started from);
    - `staged_edited_paths` (JSONB `{ path, userId }[]`, Task 15).

    `verification_status` defaults to `'DRAFT'`, so every existing row starts as DRAFT (spec §3).

  - `apps/api/src/database/schema/enums.ts`: `resume_verification_status`;
  - `apps/api/src/resumes/resumes.service.ts` (delegation only), applying the status rule below to its writes:
    - content writes (`updateContent`, `ingestText`);
    - layout writes (`updateLayout`);
    - the extraction terminal write in `runExtraction`. It now writes `facts = contentToFacts(extracted)` and leaves
      `content` untouched (spec §4 step 2: upload fills the facts, never the dynamic fields);
  - `apps/api/src/resumes/resumes.controller.ts`.
- Create:
  - `apps/api/drizzle/manual/2026-11-XX_senior_resumes_verification.sql`: idempotent
    `ADD COLUMN IF NOT EXISTS`/`CREATE TYPE` guards. **[builder]** confirms `manual/` versus `manual-staged/` in
    `.claude/agents/project-state.md` §5 and the newest file of each.
  - `apps/api/src/resumes/verification/resume-verification.service.ts` and its spec.
- Test: extend `apps/api/src/resumes/resumes-rbac.integration.spec.ts`. It runs on the scratch DB only.

**Interfaces:**

- Produces `ResumeVerificationService`:
  - `saveFacts(viewer: SessionUser, targetUserId: string, facts: ResumeFacts): Promise<SeniorResumeResponse>`
  - `setTemplate(viewer, targetUserId, name: ResumeTemplateName): Promise<SeniorResumeResponse>`
  - `toDtoFields(row): Pick<SeniorResumeDto, 'facts' | 'verificationStatus' | … | 'staged'>`. When `facts` is null
    (a legacy row never saved since), the facts come from `contentToFacts(row.content)`. Reads never write. The first
    facts save persists the mapping, which satisfies "mapped once" in spec §3.
  - `isVerificationBusy(row): boolean`. It is true when status is QUEUED or CHECKING, or when status is VERIFIED and
    `verification_run_id IS NOT NULL` (a template run in flight, Task 16). A VERIFIED row holds
    `verification_run_id = NULL` at every other time.
- Endpoints, under the existing `@Controller` path:
  - `PUT facts` (`updateResumeFactsSchema`);
  - `PUT template` (`updateResumeTemplateSchema`).
- **Status rule for every write** (facts, content, layout, template, extraction result):
  - busy → 409 `RESUME_VERIFICATION_BUSY`, row unchanged. The busy check is in the UPDATE's `WHERE`, not a prior
    read.
  - facts, content or extraction result → bump `version` and set DRAFT. If the row was AWAITING_CONFIRM, also clear
    the staged columns and delete the staged S3 object after commit.
  - layout or template on VERIFIED → a template run (Task 16), with no DRAFT.
  - layout or template on AWAITING_CONFIRM → DRAFT plus the staged cleanup above, because the staged PDF was
    rendered with the old look.
  - layout or template on DRAFT or FAILED → write it and bump `version`.

- `templateName` for a new row: the catalog name least used among the senior's team members (`team_members`), ties
  broken by `sha256(userId)` modulo 4 (spec §6). Test: `new resume in a team using classic×2, modern×1 gets compact or
technical deterministically`.

- [ ] **Step 1: Failing tests:**
  - `PUT facts bumps version and sets DRAFT`;
  - `PUT facts while CHECKING returns 409 and leaves the row unchanged`;
  - `facts edit in AWAITING_CONFIRM clears staged columns`;
  - `SENIOR may PUT own facts, not another senior's (403)`;
  - `ACCOUNTANT gets 403`;
  - `legacy row without facts reads mapped facts and status DRAFT`;
  - `PUT layout on DRAFT writes it without a run`;
  - `PUT layout on VERIFIED does not set DRAFT`;
  - `extraction result lands in facts, content unchanged`.
- [ ] **Step 2:** Run `DATABASE_URL=<scratch> pnpm --filter @crm/api test resume-verification resumes-rbac`.
      Expected: FAIL.
- [ ] **Step 3:** Implement. Apply the schema to the scratch DB only:
      `DATABASE_URL=<scratch> pnpm --filter @crm/api db:push`. First run `SELECT current_database()`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(api): resume facts, verification columns and DRAFT reset`.

### Task 14: Submit and the check run

**Files:**

- Create: `apps/api/src/resumes/verification/verification-runner.ts` and its spec.
- Modify: `resume-verification.service.ts` (`submit`), `resumes.controller.ts`.

**Interfaces:**

- `submit(viewer, targetUserId): Promise<SeniorResumeResponse>` returns 202.
  - It answers 422 `INCOMPLETE` with the `CompletenessIssue[]` in the error details when completeness fails, and 422
    `CUSTOM_TEMPLATE` when `templateSource` is set.
  - It answers 409 `RESUME_VERIFICATION_BUSY` when `isVerificationBusy`. The check is in the UPDATE's `WHERE`, so two
    concurrent submits start one run.
  - Submit is allowed from DRAFT, FAILED and AWAITING_CONFIRM. From AWAITING_CONFIRM the old staged columns are
    cleared, and the old staged object is deleted after commit.
  - Otherwise it sets QUEUED with a new `verification_run_id`, `verification_queued_at`, `verification_base_version
= version` and kind `full`, then calls `void runner.run(resumeId, runId)`.
- `VerificationRunner.run(resumeId: string, runId: string): Promise<void>` runs the stages below in order. Each
  stage's result goes into `verification_report.gates`.
  1. Claim with a CAS: QUEUED and `run_id` match → CHECKING, set `verification_started_at`.
  2. Derive: `deriveFrozenContent(facts)`.
  3. Writing:
     - build the minimised payload of §5.2, passed through `redactContacts`;
     - call `ResumeWriterClient` for the summary and for the bullets;
     - `unavailable` → FAILED `WRITER_UNAVAILABLE`.
  4. Content gates, per item:
     - `scanContacts` on the output;
     - `findUngroundedTokens` against the item notes and skills (the summary checks against the whole payload);
     - Jev entailment, which fails closed on `'unavailable'` → FAILED `ENTAILMENT_UNAVAILABLE`.

     A failing item is regenerated up to 2 times with the reasons as `feedback`. Still failing, it falls back to the
     cleaned note text, and the path is recorded in `fallbacks`.

  5. Render the staged PDF:
     - normalise every string with NFC and `toRenderableText`;
     - render with `loadCatalogTemplate(templateName)`;
     - upload under `resumes/<resumeId>/staged/<runId>.pdf`;
     - a render error → FAILED `RENDER_FAILED`.
  6. ATS: run `extractRenderedPages` + `checkResumeAts`.
     - `TOO_MANY_PAGES` and `TOO_LARGE` are layout failures. They go to stage 7's repair loop, never terminal here.
     - Any other failure on an AI-written item reverts that item to the note text and re-renders once. Still failing
       → `ATS_CHECK_FAILED`.
     - Dropped glyphs → `GLYPH_CHECK_FAILED`.
     - The ATS check re-runs after every layout repair render.
  7. Layout:
     - pages ≤ `ATS_MAX_PAGES` and bytes ≤ `ATS_MAX_BYTES`;
     - the last page holds at least 25 % of the average line count of the full pages when there is more than one page
       **[call]**: line-count ratio, no extra Typst query.

     Repair adjusts `density` first, then `fontScale` within the layout enums. It runs at most 3 rounds, else
     `LAYOUT_UNFIXABLE`.

  8. Visual:
     - render a placeholder copy as PNG pages: name → `Firstname Lastname`, email → `name@example.com`, and every
       `links` entry → label `Link`, URL `https://example.com` (tailored spec §6.4 item 18). Education and languages
       stay as they are;
     - call `VisualCheckClient`;
     - a finding counts only when a second call confirms the same `check` and `page`;
     - `unavailable` → `VISUAL_CHECK_UNAVAILABLE`, a confirmed finding → `VISUAL_CHECK_FAILED`.
  9. Stage: with a CAS on `run_id` and `version = verification_base_version`, write `staged_*` and set
     AWAITING_CONFIRM.
     - Losing the CAS deletes the uploaded object and writes nothing.
     - If the row already had a staged object from an earlier run (edit or regenerate, Task 15), it is deleted after
       commit.

  Every FAILED terminal write CASes on `run_id`. It deletes the run's own object and any earlier staged object, and
  clears the staged columns. A run started from AWAITING_CONFIRM that fails leaves FAILED, and HR submits again.

- `RendererPng`: add `renderPng(input: ResumeRenderInput): Promise<Buffer[]>` to `ResumeTypstService`, through the
  same sandbox (`--format png`, one file per page).

- [ ] **Step 1: Failing tests** with fake clients and a fake S3:
  - `happy path ends AWAITING_CONFIRM with staged content and report`;
  - `writer unavailable → FAILED WRITER_UNAVAILABLE, live columns untouched`;
  - `bullet with invented "40%" is regenerated, then falls back to notes and is listed in fallbacks`;
  - `payload sent to writer contains no displayName, email, location, education, languages, links` (assert on the
    captured payload);
  - `model output containing the full name fails that item`;
  - `superseded run (run_id changed mid-run) writes nothing and deletes its object`;
  - `vision unconfirmed finding does not fail`;
  - `vision unavailable → VISUAL_CHECK_UNAVAILABLE`;
  - `3-page first render is repaired by density, not failed by the ATS stage`;
  - `PNG copy sent to vision contains no real name, email or link URL` (extract the placeholder render's text);
  - `two concurrent submits → one run`;
  - `re-submit from AWAITING_CONFIRM deletes the old staged object`.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test verification-runner`. Expected: FAIL.
- [ ] **Step 3:** Implement. Each stage is a private method; the runner file stays under 400 lines. Split the
      content-gate loop into `content-gates.ts` if it grows past that.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(api): resume verification run with content, ATS, layout and visual gates`.

### Task 15: Confirm, staged edit, regenerate item

**Files:**

- Modify: `resume-verification.service.ts`, `verification-runner.ts`, `resumes.controller.ts`, and the integration
  spec.

**Interfaces:**

- `confirm(viewer, targetUserId, { runId, version }): Promise<SeniorResumeResponse>`.
  - ADMIN/HR only; anyone else gets 403.
  - It is one UPDATE with `WHERE verification_run_id = $runId AND version = $version AND verification_status =
'AWAITING_CONFIRM'`. That UPDATE promotes the staged content, layout, template and PDF key to the live columns,
    sets `version = version + 1, verified_version = version + 1` (both read the pre-update `version`),
    `verified_at` and `verified_by_user_id`, sets VERIFIED, clears `verification_run_id` and the staged columns.
  - 0 rows → 409 `RESUME_CONFIRM_STALE`. After commit the replaced live PDF object is deleted.
- `editStagedField(viewer, targetUserId, { runId, path, text })`:
  - only in AWAITING_CONFIRM with a matching `runId`;
  - `path` is `summary` or `experience.<i>.bullets.<j>`;
  - `text` must pass `isLatinScript` and have no `scanContacts` hit; otherwise 422 with the hit;
  - it appends `{ path, userId: viewer.id }` to `staged_edited_paths`;
  - it starts a run of kind `staged-edit` with a new run id. That run applies the text to the staged content and
    re-runs stages 5–9, without the writer and entailment gates (spec §4 step 6).
- `regenerateStagedField(viewer, targetUserId, { runId, path })` starts a run of kind `item`. That run re-runs stages
  3–9 for that one path and keeps the other staged texts. It removes `path` from `staged_edited_paths`.
- During either run the row keeps its previous staged columns, so the UI still shows the last staged PDF. The run's
  stage 9 replaces them and deletes the previous staged object (Task 14).
- Both edits follow `canAccessResume` write, as editing does (spec Q-C). The confirmer sees each staged-edited path
  marked "edited by a person, not fact-checked" (Task 19), so a SENIOR edit never reaches VERIFIED unseen.
- `getStagedPdf(viewer, targetUserId)`: `GET /users/:id/resume/staged-pdf`, `canAccessResume` read. It streams the
  staged object. No staged object, or no access → the same 404 as the live PDF endpoint.

- [ ] **Step 1: Failing tests:**
  - `two concurrent confirms → exactly one 200, one 409, version bumped once` (`Promise.all` on the scratch DB);
  - `confirm after a facts edit → 409`;
  - `SENIOR cannot confirm own resume (403)`;
  - `HR can confirm`;
  - `staged-edit skips writer and entailment clients` (call counts are 0);
  - `confirm deletes the old live PDF object`;
  - `confirm sets verified_version equal to the new version`;
  - `staged edit with an email address → 422, no run started`;
  - `staged edit records { path, userId } in staged_edited_paths`;
  - `staged edit run replaces the previous staged object and deletes it`;
  - `staged-pdf: owner SENIOR gets the file, foreign SENIOR and no-staged both get 404`.
- [ ] **Step 2:** Run `DATABASE_URL=<scratch> pnpm --filter @crm/api test resume-verification resumes-rbac`.
      Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(api): confirm with CAS, staged edit and item regenerate`.

### Task 16: Template/layout runs on a VERIFIED resume, and the sweep

**Files:**

- Modify:
  - `resume-verification.service.ts`;
  - `verification-runner.ts`;
  - `resumes.service.ts`: `updateLayout` delegates to the runner when VERIFIED;
  - `apps/api/src/resumes/resume-extraction.cron.ts`: add a sweep call to the existing 5-minute cron.

**Interfaces:**

- On a VERIFIED resume, `setTemplate` and `updateLayout` start a run of kind `template`:
  - it sets `verification_run_id`, `verification_kind = 'template'`, `verification_base_version = version` and
    `verification_queued_at`; the status stays VERIFIED, and `isVerificationBusy` now returns true (Task 13);
  - the staged template or layout is the requested one, and the staged content is the live content;
  - stages 5–8 run;
  - every terminal write CASes on `verification_run_id = $runId AND version = verification_base_version`, and clears
    `verification_run_id`;
  - pass → promote PDF and template or layout, set `version = version + 1, verified_version = version + 1`, stay
    VERIFIED; after commit delete the replaced live PDF object;
  - fail → the live columns stay untouched and the status stays VERIFIED; `verification_error_code` and
    `verification_report` are set, the run's object is deleted, and the UI shows them as the result of the last
    template check.
- `sweepStalledVerifications(now: Date): Promise<number>`, with `VERIFICATION_DEADLINE_MS = 600_000`:
  - status QUEUED or CHECKING and `verification_queued_at < now − deadline` → FAILED `STALLED`;
  - status VERIFIED, `verification_run_id IS NOT NULL` and `verification_queued_at < now − deadline` → clear
    `verification_run_id`, set `verification_error_code = 'STALLED'`, stay VERIFIED;
  - each UPDATE CASes on the run id it read; the run's staged object is deleted after commit.

- [ ] **Step 1: Failing tests:**
  - `template change on VERIFIED passes → VERIFIED with new template and verified_version == version`;
  - `template change fails (vision unavailable) → previous template and PDF kept, VERIFIED`;
  - `sweep fails a CHECKING run older than 10 min and deletes its object`;
  - `sweep ignores a run 9 min old`;
  - `sweep clears a stalled template run and keeps VERIFIED`;
  - `facts PUT during a template run → 409`;
  - `template pass deletes the replaced live PDF object`;
  - `template run that lost the CAS writes nothing and deletes its object`.
- [ ] **Step 2:** Run `pnpm --filter @crm/api test resume-verification verification-runner resume-extraction.cron`.
      Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again, then `pnpm --filter @crm/api typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(api): template runs on verified resumes and stalled-run sweep`. Then dispatch
      `security-reviewer` on Phases C–D.

## Phase E — Web (spec slice 4; design gate)

### Task 17: Design pass (ui-ux-designer, Claude Design Tier per `design-gate.md`)

Mockups go in the repo as the bridge artifact:

- facts form with the completeness panel;
- empty state (**Fill in manually** / **Upload to prefill**);
- progress stages;
- the confirm step: written text next to its facts, staged PDF preview, Confirm / Edit / Regenerate;
- the failure panel;
- the template thumbnail picker.

Each is shown at mobile, tablet, laptop and large.

- [ ] Deliver the mockups and the copy (uk + en) through `copy-reviewer`. Commit `docs(design): verified base
resume screens`.

### Task 18: Facts form and completeness panel

**Files:**

- Create: `apps/web/app/components/user-profile/resume/ResumeFactsForm.tsx`, `ResumeCompletenessPanel.tsx`, and
  tests in `__tests__/`.
- Modify:
  - `apps/web/app/hooks/use-senior-resume.ts`: `useSaveResumeFacts`, `useSubmitResume`;
  - `ResumeTab.tsx`;
  - `ResumeIntake.tsx`: the extraction result fills the facts form, never the content.

**Interfaces:**

- Consumes: `checkResumeCompleteness` (live, the same function the server runs), `resumeFactsSchema`.
- `ResumeExperienceEditor.tsx` is replaced by the facts experience editor. Delete it if nothing else imports it
  (`codegraph_callers`).

- [ ] **Step 1: Failing tests:**
  - `Submit disabled while completeness lists issues`;
  - `each issue links to its field`;
  - `409 from save shows "a check is running" and keeps the form values`;
  - `upload result fills facts fields`.
- [ ] **Step 2:** Run `pnpm --filter @crm/web test ResumeFactsForm ResumeCompletenessPanel`. Expected: FAIL.
- [ ] **Step 3:** Implement. Wrap all strings in Lingui macros, then run `pnpm --filter @crm/web i18n:extract`.
- [ ] **Step 4:** Run again plus `pnpm --filter @crm/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(web): resume facts form with live completeness`.

### Task 19: Progress, confirm step and failure panel

**Files:**

- Create: `ResumeVerificationPanel.tsx` (progress, confirm, edit, regenerate, failure) and its tests.
- Modify: `use-senior-resume.ts`: `useConfirmResume`, `useEditStagedField`, `useRegenerateStagedField`. Polling uses
  the existing resume query refetch interval while QUEUED or CHECKING.

**Interfaces:**

- Confirm is shown only when `canConfirm`. Every action sends the `staged.runId`. A 409 refetches and shows "the
  resume changed, review again". Failure codes map to localized reasons with the report item path.
- The preview loads `GET /users/:id/resume/staged-pdf` (Task 15). Each `staged_edited_paths` entry is marked
  "edited by a person, not fact-checked" next to its text.

- [ ] **Step 1: Failing tests:**
  - `SENIOR sees no Confirm button`;
  - `Confirm sends runId and version`;
  - `409 on confirm refetches`;
  - `FAILED ATS_CHECK_FAILED shows the item path`;
  - `fallbacks listed as "kept from your notes"`;
  - `staged-edited path shows the "not fact-checked" mark`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `i18n:extract`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(web): resume verification progress and confirm step`.

### Task 20: Template picker

**Files:**

- Modify: `ResumeLayoutPanel.tsx`, adding a thumbnail picker of `RESUME_TEMPLATE_NAMES`. Static thumbnails are
  rendered once from the `classic` ATS fixture and committed under `apps/web/public/resume-templates/`.
- Modify: `use-senior-resume.ts`: `useSetResumeTemplate`.

- [ ] **Step 1: Failing tests:**
  - `picker lists 4 templates`;
  - `selecting one calls PUT template`;
  - `on VERIFIED shows "checking the new template"`, and the previous PDF stays downloadable.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit and push `feat(web): resume template picker`.

### Task 21: E2E and manual QA

**Files:**

- Create: `apps/e2e/tests/resume-verification.spec.ts` (AutoTest agent; `playwright-patterns` skill).

- [ ] **Step 1:** Specs:
  - `HR fills facts, submits, confirms → VERIFIED badge`, with the worker, Jev and vision stubbed at the api env
    level, following the existing E2E stub pattern;
  - `SENIOR cannot confirm`, including a real 403 from the API, not a hidden button only;
  - `facts edit after VERIFIED returns to DRAFT`;
  - `320 px has no horizontal overflow on the facts form`.
- [ ] **Step 2:** Run `pnpm --filter @crm/e2e test resume-verification`. Expected: PASS with a non-zero count.
- [ ] **Step 3:** manual-qa on the real stack. It walks the golden path plus Review Focus items 1–5 and takes
      screenshots at four widths.
- [ ] **Step 4:** Commit and push `test(e2e): verified base resume flow`.

## Out of this plan

- The one-off Affinda check per template is owner-run with synthetic fixtures (spec §9 Q-B). Task 7's
  `ATS_MATRIX_OUT` produces the PDFs for it.
- Cloudflare as a pool route, `tailored_resumes`, and the job-queue button belong to the tailored plan.
