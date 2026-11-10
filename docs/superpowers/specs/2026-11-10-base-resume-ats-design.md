# Verified base resume, template catalog and the ATS gate — design

**Date:** 2026-11-10 · **Status:** draft for owner approval · **Author:** Master (brainstorming with the owner)
**Builds on:** the resume base feature (`senior_resumes`, `ResumeTypstService`, `ResumeAiService`), the ATS research
(`docs/architecture/2026-11-10-ats-resume-parsing-research.md`), the career-ops research
(`docs/architecture/2026-11-10-career-ops-resume-tailoring-research.md`).
**Feeds:** the tailored resume design (`docs/superpowers/specs/2026-11-10-tailored-resume-design.md`), which requires a
VERIFIED base resume and reuses this design's ATS checker and templates.

Markers: **[owner]** = decided by the owner on 2026-11-10; **[call]** = Master's call, open to correction;
**[builder]** = left to the implementer.

---

## 1. Intent

Most employers screen through an ATS. A resume the ATS parses badly is invisible to recruiter keyword search and to
AI grading, so our seniors' applications may never reach a person. The base resume is the source every tailored CV is
built from, so it has to be complete and ATS-safe before anything is generated from it. **[owner]**

At the same time, seniors from one studio applying to the same employer should not all look identical. HR picks a
visual template per senior from a catalog of templates that are all proven ATS-safe. **[owner]**

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. Creating a senior never requires a resume. HR adds it later; until the base resume is VERIFIED, per-vacancy
  generation is unavailable for that senior. **[owner]** (Verified in the code on 2026-11-10: user creation has no
  resume dependency today; only the resume tab's visibility uses the resume access predicate.)
- G2. HR fills the base resume as facts in fields. On submit, the system writes the "dynamic fields" (summary and
  experience bullets as polished English, normalised skills) from those facts with AI, checks them, and shows them to
  HR to confirm. **[owner]**
- G3. Upload of an existing PDF/DOCX stays, as a way to prefill the facts; manual entry from scratch is always
  possible. **[owner]**
- G4. A base resume becomes VERIFIED only when it is complete and passes the ATS, layout and visual gates. **[owner]**
- G5. A catalog of visually distinct templates; the template is chosen per senior and used for the base PDF and for
  every tailored CV of that senior. **[owner]**
- G6. A dedicated ATS test suite proves every template parses back correctly on a fixture set. **[owner]**

**Non-goals**

- Multi-column, sidebar, icon or graphic templates (research: the documented parser failure modes).
- HR-uploaded custom templates for verified resumes (breaks the ATS guarantee; `templateSource` stays as it is, but a
  resume with a custom template cannot be VERIFIED). **[call]**
- Languages other than English for the resume content (same rule as the tailored design, Q2). **[owner]**
- A commercial ATS parser in CI.

**Anti-goals**

- A1. AI-written text that states something the facts do not support (same fact and entailment gates as tailoring).
- A2. Any deceptive ATS trick: hidden text, keyword stuffing, white-on-white blocks.
- A3. Two templates that parse to different fields for the same content (visual variety must not change semantics).

## 3. Facts vs dynamic fields

Today `senior_resumes.content` (`ResumeContent`) is both what HR edits and what renders. This design separates the
author's input from the written result. **[call]**

- **Facts** (new JSONB `facts`, schema `ResumeFacts` in `@crm/shared`), written by HR (or prefilled by upload):
  - headline: the target role title (e.g. "Senior Backend Engineer");
  - location (city, country) and work format (remote / hybrid / on-site) **[call]**;
  - skills: a free list;
  - experience items: company, role, location (optional), start month, end month or "current", technologies, and
    free-form achievement notes (one per line, any style);
  - education items: institution, degree, start/end year;
  - languages: name + level (CEFR or native); English is required **[call]**;
  - links: label + https URL.
- **Dynamic fields** (the existing `content`, derived on submit, rendered by Typst):
  - deterministic: `period` formatted from the month fields as `Mon YYYY – Mon YYYY` / `Present` (one consistent
    format, research §4); total years of experience; skills merged from the skills list and every item's
    technologies, deduplicated and renamed to the canonical vocabulary spelling (`NodeJS` → `Node.js`, acronym plus
    full form where the vocabulary has one: `Amazon Web Services (AWS)`);
  - AI-written: `summary` (3–4 sentences built from headline, years, top skills and the strongest achievements) and
    each item's `bullets` (from that item's notes: action verb, scope, result, numbers only when the notes have them).
- The display name and `users.email` are not facts; the template prints them from the user row (tailored design,
  Q-contact).

Existing resumes: their `content` is mapped into facts once (bullets become notes, free-text `period` is parsed into
months where it can be and left for HR to fix where it cannot), and they start as DRAFT. **[call]**

## 4. The HR flow

1. A new senior has no resume. The resume tab shows the empty state: **Fill in manually** or **Upload to prefill**
   (the existing intake). The job queue shows "Generate CV + CL" disabled with "no verified base resume".
2. Upload runs the existing extraction; its result fills the facts form, never the dynamic fields directly.
3. HR edits the facts. A completeness panel lists what is missing, live (§5.1). **Submit** is enabled when the panel
   is clean.
4. Submit starts a check run (progress stages: writing → checking facts → rendering → ATS check → visual check). The
   run writes its result to staged columns (§8); the current content and PDF stay untouched until Confirm.
5. On success HR sees the written summary and bullets next to the facts they came from, and the staged PDF. HR can
   **Confirm**, **Edit** a written field, or **Regenerate** it. Confirm promotes the staged result and makes the
   resume VERIFIED.
6. An edit of a written field in this step re-runs every gate except the content gates (completeness, ATS, layout
   and visual) on the staged result before Confirm is enabled again: HR is the author of the facts and may phrase
   them. **[call]**
7. A later change to facts or written fields sets the resume back to DRAFT; the generation button is disabled until
   it is submitted again. A template change follows §6. Tailored variants already generated stay downloadable with
   the existing "base changed" hint.
8. A failed run shows the reason category and the item it concerns (e.g. "experience 2: no achievement notes",
   "template overflow on page 3").

**State machine [call].** DRAFT → (submit) QUEUED → (worker claims) CHECKING → AWAITING_CONFIRM → (confirm) VERIFIED.
Any gate failure → FAILED, from which a new submit starts over. Facts and written fields cannot be edited while QUEUED
or CHECKING (409). A facts edit in AWAITING_CONFIRM discards the staged result and returns to DRAFT. The run uses the
claim / sweep pattern of the tailored design §6 (`verification_run_id`, queued and started timestamps, a sweep that
fails a run QUEUED or CHECKING past its deadline as STALLED and discards its staged result).

**Who may do what [call, owner to confirm as Q-C].** Editing facts and Submit follow today's resume write rule
(`canAccessResume` write: ADMIN, HR, and the SENIOR for their own resume). **Confirm** is ADMIN and HR only: a senior
cannot mark their own resume VERIFIED.

## 5. Gates on submit

Shared with the tailored design: the ATS checker, the layout gate and the visual check are one module used by both
(`ResumeAtsCheckService` or similar, **[builder]** for the name).

### 5.1 Completeness (deterministic, block)

- headline present; at least one experience item;
- every item: company, role, start month; end month or "current"; end ≥ start; no future start; at least one
  achievement note **[call]**;
- at least 5 skills after the merge **[call]**;
- English among languages;
- every text field Latin-script (tailored design Q2), display name Latin;
- links: `https:` or `mailto:` only (already enforced by `resumeLinkSchema` via `isSafeResumeUrl`);
- no contact data inside free text (phone/email shapes in notes are flagged, since the header carries contacts), and
  the same name/email scan as the tailored design §3 on every fact that is sent to a model.

### 5.2 Content gates on the AI-written fields (block, with repair)

The same mechanism as the tailored design §6.4, with the facts as the source: frozen fields untouched; deterministic
fact gate (numbers, technologies, proper nouns in the written text must occur in the facts); Jev entailment for each
bullet against its item's notes and for each summary sentence against the writing payload; a failing item is
regenerated up to twice, then falls back to the cleaned note text itself.

**Writing payload = minimised facts.** Only headline, skills, and per experience item: company, role, dates,
technologies and notes. Never the name, `users.email`, location, education, languages or links (the summary is not
written from them, so it cannot claim them). The generator and Jev see the same payload. **[call]**

### 5.3 ATS gate (block)

Run on the real PDF rendered with the senior's template, via the existing text extractor (`unpdf`). Input: the
rendered `content`, the effective layout (`normalizeResumeLayout`: section order and hidden sections) and the PDF.

- every rendered string of `content` occurs in the extracted text (0 missing);
- the headings of the visible sections, from the fixed set (Summary, Experience, Skills, Education, Languages,
  Links), each alone on a line, in the effective section order; hidden sections absent;
- inside each experience item: role, company and dates precede its bullets; no two items interleave;
- every `period` string of `content` extracts verbatim and matches the one date format of §3 (for the base resume it
  is generated from the month fields; for a tailored CV it is the frozen snapshot value, so the checker needs no
  facts);
- name and email occur in the body text (not only in a page header/footer artifact);
- no `U+FFFD`, no ligature code points (`U+FB00`–`U+FB06`), no letter-spaced headings;
- page count ≤ 2 **[call]**; file size ≤ 1 MB **[call]**.

### 5.4 Layout and visual gates (block)

As in the tailored design §6.4 (last-page fill rule, glyph check, placeholder copy for the vision model, fail closed
when no vision route is available).

## 6. Template catalog

- A fixed catalog in the repo, four to start **[call]**: `classic` (serif, centered name), `modern` (sans, accent rule
  under headings), `compact` (denser spacing, dates right-aligned on the role line), `technical` (skills grouped by
  category, one line each). All share one skeleton: single column, the fixed heading set, sections in the layout's
  order,
  contacts as body text under the name, no images, no icons, no `place`/floats for content, ligatures off in body
  text, document title set.
- Allowed differences: font family (embedded, with a correct Unicode map), accent color, size and weight hierarchy,
  rules and dividers, margins and spacing, header style.
- `templateName` (already on `senior_resumes` and in the DTO) becomes an enum of the catalog. A new resume gets the
  template least used among the seniors of its team(s), ties broken by a hash of the senior id, so neighbours differ
  without HR doing anything. **[call]** HR changes it in the layout panel with a thumbnail picker.
- Changing the template (or the layout) of a VERIFIED resume is a check run of its own: it renders into the staged
  columns and re-runs 5.3–5.4 (not the content gates). A pass promotes the staged PDF and template, bumps `version`
  and sets `verified_version` to it, so the resume stays VERIFIED; a fail leaves the previous template and PDF in
  place, still VERIFIED, and shows the reason. **[call]**
- Tailored CVs render with the senior's base template, snapshotted on the variant at generation time.
- Adding a template is a code change that must pass the CI suite of §7 before it can be selected.

## 7. The ATS test suite

A dedicated suite in the api package, separate from the unit tests of the service, run in CI on every change to
templates, the renderer, the checker or the Typst pin.

- **Fixtures** (synthetic people, no real data): one-job junior; 15-year career with 10 items; long company and role
  names; Latin diacritics (`José Müller`); symbol-heavy skills (`C#`, `C++`, `.NET`, `Node.js`, `CI/CD`); empty
  education; current job; maximum bullets per item; maximum skills.
- **Matrix:** every template × every fixture → render → extract → the 5.3 assertions.
- **Cross-template equivalence:** for one fixture, the parsed field set is identical across templates (A3).
- **Golden text:** the extracted text per template × fixture is committed; a Typst bump or template edit that changes
  it fails until the new golden is reviewed. **[call]**
- **Negative controls:** a deliberately broken two-column fixture template and a letter-spaced heading must fail the
  checker, proving the checker can see the failures it claims to catch (verification-integrity).
- **Independent parser oracle (owner decision, §9 Q-A):** the OpenResume parser (pdf.js-based, built for
  single-column English resumes) run as a separate CI job against the matrix PDFs, asserting name, email, company,
  role and dates. It is AGPL-3.0: run from its own checkout, never copied into this repo.
- **One-off manual check:** each new template through a commercial parser trial (Affinda) before release, owner-run
  (§9 Q-B).

## 8. Data model and API

- `senior_resumes` gains `facts` (JSONB `ResumeFacts`), `verification_status` (DRAFT / QUEUED / CHECKING /
  AWAITING_CONFIRM / VERIFIED / FAILED), `verification_run_id`, `verification_queued_at`, `verification_started_at`,
  `verification_error_code`, `verification_report` (JSONB: gate results, fallbacks used), `verified_version`,
  `verified_at`, `verified_by_user_id`. The existing extraction `status` keeps meaning "extraction state" only.
  **[call]**
- Staged columns written only by a check run: `staged_content`, `staged_layout`, `staged_template_name`,
  `staged_pdf_s3_key` (run-scoped key containing the run id). Confirm (or a passing template run) promotes them to the
  live columns in one transaction and deletes the replaced PDF object; a failed, discarded or swept run deletes its
  own staged object.
- **`version` is bumped on every write** to facts, content, layout or template (today it is bumped on content saves
  only; this extends it). VERIFIED always means `verified_version = version`. **[call]**
- `templateName` constrained to the catalog.
- Endpoints next to the existing resume endpoints: `PUT …/facts`, `POST …/submit` (202, run), `GET` status (existing
  resume GET gains the new fields), `POST …/confirm` (ADMIN/HR; compare-and-set on `verification_run_id`, `version`
  and status AWAITING_CONFIRM, so a confirm cannot race an edit or a newer run), `PUT …/template`. **[builder]** for
  exact paths, following the existing resume controller.
- The tailored design reads "base resume READY" as `verification_status = VERIFIED` and `verified_version = version`.

## 9. Owner decisions still open (A2, not blocking the design)

- **Q-A.** Run the AGPL OpenResume parser as a separate CI job (recommended), or skip the oracle and rely on our own
  checker plus negative controls.
- **Q-B.** One-off Affinda check of each new template with synthetic fixtures only (recommended; it is an external
  send, so synthetic data, never a real senior).
- **Q-C (RBAC).** A senior may edit and submit their own base resume, but only ADMIN or HR may Confirm it
  (recommended, as written in §4), or seniors get no write access to the base resume at all.

## 10. Delivery slices

1. Shared: `ResumeFacts` schema, catalog enum, canonical skills vocabulary with synonym groups (also used by the
   tailored design).
2. Templates: harden the default into the shared skeleton, add the other three; ATS checker module; the CI suite of
   §7 with negative controls and golden text.
3. Backend: facts column + mapping of existing resumes; submit run (completeness, deterministic fields, AI writing,
   content gates, ATS/layout/visual gates); confirm; template change; DRAFT reset on edit.
4. Web: facts form with the completeness panel, upload-to-prefill, the confirm step, template picker (design gate).
5. Manual QA on the real stack.

The tailored design's slices 2 and 4 shrink to reuse of slices 1–2 here. Security review on slice 3 (PII to
providers).

## 11. Risks

- AI-written bullets can flatten a senior's voice; HR edits in the confirm step cover it.
- Free-text `period` of existing resumes will not always parse; those resumes need an HR pass before VERIFIED.
- The checker proves parseability by our extractor and one open parser, not by every commercial ATS (research: the
  engines behind the big ATSs are not public).
