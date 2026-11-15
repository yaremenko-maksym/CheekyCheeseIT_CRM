# Design spec: Verified base resume screens (Mode A + Mode E)

**Slug:** `verified-base-resume`
**Date:** 2026-11-11
**Task:** 17 of the verified base resume plan (the design pass before Tasks 18–20)
**Design-gate:** `design-gate: degraded (no Chrome MCP in the session)`. Claude Design could not be
driven, so the bridge artifact is a static HTML mockup built only from our tokens, plus screenshots
taken with Playwright from the `file://` URL. This document is the coder-ready spec and the fidelity
reference.
**Authority:** `docs/superpowers/specs/2026-11-10-base-resume-ats-design.md` (§4 flow, §5 completeness,
§6 template runs, §7–§8 verification and statuses). Data contract: `packages/shared/src/schemas/resume-facts.ts`
(`seniorResumeDtoSchema`, `seniorResumeResponseSchema`), `resume-completeness.ts`,
`api-errors/resume.ts`.
**Replaces parts of:** `docs/design/senior-resume.md` (its section editor over `content` becomes the
facts form; its layout panel gains the template picker; its PDF preview stays). Its visual language is
kept: one `Card` per block, explicit Save, amber for "failed in the background, nothing lost".

> **To the coder (Tasks 18–20):** build with OUR components per this spec. `design.html` is a visual
> reference, NOT code to paste. Do not copy its raw HTML or CSS. Every string comes from the copy table
> (§10), wrapped in Lingui macros.

---

## 1. Artifacts

| Artifact                                                   | What                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `docs/design/assets/verified-base-resume/design.html`      | Static mockup, 6 screens; `?s=<screen>` shows one screen                                     |
| `docs/design/assets/verified-base-resume/<screen>-<w>.png` | Full-page shots, screens `facts empty progress confirm failure picker` × `320 768 1024 1440` |
| `docs/design/assets/verified-base-resume/design.png`       | The fidelity reference for Mode B: the 1440 confirm step                                     |

The mockup uses only the `.dark` tokens copied from `apps/web/app/styles/globals.css` and the Tailwind
default palette steps the app already uses (`emerald-300/500`, `amber-300/500`). The screen labels in
small caps above each screen are mockup annotations, not UI. Mockup data is synthetic ("Alex Doe",
"Dana Smith", `example.test`).

Measured on all 24 shots: `document.scrollWidth === clientWidth` (no horizontal overflow) and no button
below 44px tall at 320 or below 24px at the other widths.

## 2. Direction (Mode A)

- **Purpose:** HR turns a senior's facts into a VERIFIED base resume: fill the facts, submit, review
  what the AI wrote next to its sources, confirm. A senior may fill and submit their own; only HR or
  ADMIN confirms.
- **Audience:** HR, a few times per senior (onboarding, then after a facts change). The questions they
  scan for: "what is still missing", "is it checking", "is the generated text true to the facts", "why did
  it fail". A senior visits rarely.
- **Tone:** the CRM's own — dense, quiet, scannable. No hero, no illustration, no gradient.
- **Memorable detail:** **source on the left, written on the right.** Every AI-written block in the
  confirm step sits next to the facts it came from, separated by two vertical rules: a neutral
  `border-border` rule for the source and a `border-primary` rule for the generated text. HR reads across
  one row and sees whether a number or a claim has a source. Hand-edited text carries a dashed
  "edited by hand" badge, so a reviewer knows the gates did not write it.
- **Constraints:** Tailwind v4 tokens, shadcn/ui primitives, Lingui `uk` + `en`, WCAG 2.2 AA, four
  device classes, dark theme only (`design-gate.md`).

## 3. Where it lives

The resume tab of the profile shell (`/profile/:userId?tab=resume`, own `/profile?tab=resume`).
Root stays `data-testid="resume-tab"`. Content column `max-w-6xl` (1152px), left-aligned like the other
tabs. Order inside the tab, top to bottom:

```
<ResumeVerificationBar>     status badge + meta line + the primary action for the state
<ResumeVerificationProgress> only while verificationBusy
<ResumeVerificationFailure>  only when FAILED, or VERIFIED with verificationErrorCode (warning)
<ResumeConfirmStep>          whenever staged != null (AWAITING_CONFIRM, or QUEUED/CHECKING read-only)
<ResumeFactsForm>            DRAFT / FAILED / VERIFIED (and AWAITING_CONFIRM behind "Change the facts")
<ResumeLayoutPanel>          existing, gains <ResumeTemplatePicker> at the top; disabled while busy
<ResumePdfPreview>           existing, the live PDF (not the staged one)
```

Empty state (`resume === null`, `canEdit`) replaces everything with `<ResumeIntake variant="empty">`.

## 4. State → screen map

Busy is **only** `verificationBusy === true`. Never infer it from `verificationReport` or the status.

| DTO state                                              | Bar badge                              | What shows                                                                                                    |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `resume === null`, `canEdit`                           | —                                      | Empty state (screen 2)                                                                                        |
| `resume === null`, `!canEdit`                          | —                                      | Existing read-only "The resume is not filled in yet."                                                         |
| `DRAFT`                                                | Draft (outline)                        | Facts form + completeness panel (screen 1). Line "The facts changed…" only when `verifiedVersion !== null`    |
| `QUEUED` / `CHECKING`, `staged === null` (busy)        | Checking (primary outline)             | Progress (screen 3); form, Submit, picker, layout switches disabled                                           |
| `QUEUED` / `CHECKING`, `staged !== null` (busy)        | Checking (primary outline)             | Confirm step **read-only**: progress line "Updating and checking the text…" at the top, every action disabled |
| `AWAITING_CONFIRM`, `staged`                           | Awaiting confirmation                  | Confirm step (screen 4); facts form collapsed behind "Change the facts"                                       |
| `FAILED`                                               | Failed the check (amber)               | Failure panel (screen 5) above the facts form                                                                 |
| `VERIFIED`, `verificationErrorCode === null`, not busy | Verified (emerald)                     | Meta "Verified {date} · {name}", facts form, picker, layout panel                                             |
| `VERIFIED` + busy (template or layout run)             | Verified + Checking the new formatting | Picker and layout switches disabled, small progress line; everything else stays usable read-only              |
| `VERIFIED`, `verificationErrorCode !== null`, not busy | Verified (emerald)                     | Non-blocking warning row `failure.templateWarning` + the code body                                            |

A staged edit or regenerate puts the row back to `QUEUED` (then `CHECKING`) and keeps `staged`
non-null; there is no `AWAITING_CONFIRM` + busy state. The DTO does not say which block triggered the
run, so the UI shows **one** progress line for the whole step and never a per-block marker. A template
run and a layout run look the same in the DTO, so their texts name both.

## 5. Screens

### 5.1 Facts form + completeness panel (`facts-*.png`)

- **Layout.** `lg+`: two columns, form `minmax(0,1fr)` + panel `304px`, panel `sticky top-4`.
  Below `lg`: the panel moves **above** the form, full width, with a "Hide / Show" toggle on its list
  (`aria-expanded`, `aria-controls`); Submit stays visible in the panel header area at every width.
- **Form cards** (one `Card` each, no card-in-card except the per-job bordered block, which is a
  `border rounded-lg p-3` div, not a `Card`): Basics (target role, city, country, work format) ·
  Skills · Work experience (per job: company, position, location optional, start, end, "I work here
  now", technologies, achievement notes) · Education · Languages · Links.
- **Fields.** Month fields `MonthPickerField`; technologies `TechAutocompleteInput`; work format and
  language level `Select`; "I work here now" `Switch` (disables and clears End). Notes and skills are
  `Textarea`, one item per line, each with a muted hint under the label tied by `aria-describedby` ("One skill per line", "One note per line"). Job rows keep the existing reorder / delete icon buttons and their
  aria-labels ("Move job {position} up", "Delete job {position}").
- **Skills counter** next to the Skills title: `{own} + {fromJobs} from the jobs = {total} of 5`,
  `tabular-nums`, computed with the same `mergeSkills` as the check. Hide it at ≥ 5.
- **Live issues.** `checkResumeCompleteness(facts, { displayName, now })` on the local draft, on every
  change (debounce ≤ 150 ms). The panel lists each issue as a `button` row: field label on the first
  line (`Job 2 · Notes`), the code text on the second. Click / Enter focuses the field and scrolls it
  into view (`scrollIntoView({ block: 'center' })`). Path → field mapping: `headline`, `location.city`,
  `location.country`, `skills` / `skills.<i>`, `experience` (→ "Add a job" button),
  `experience.<i>.{company,role,location,start,end,notes}`, `experience.<i>.notes.<j>` and
  `experience.<i>.technologies.<j>` (→ the notes textarea / the technologies input of that job),
  `education.<i>.{institution,degree,endYear}`, `languages` (→ "Add a language" button),
  `languages.<i>.name`, `displayName` (→ no field here: the row text says to change the profile name).
- **Field errors.** The same code text under the field, `text-destructive text-xs`, field
  `aria-invalid="true"` + `aria-describedby` → the error id. Show field errors only after the field was
  touched or after a Submit attempt; the panel always shows all issues.
- **Actions.** Primary "Submit for checking" (disabled while issues exist, while busy, while saving;
  `aria-describedby` → the hint "Fill in the fields in the list first"). Secondary "Save the draft"
  (`PUT facts`, enabled when dirty). Submit with unsaved changes saves first (`PUT facts`), then
  `POST submit`, as one action with one spinner. [A1 — see Assumptions]
- **Clean panel:** title "Everything is filled in — ready to submit", no list, Submit enabled.
- **Upload stays a prefill.** After an upload, the extraction fills the facts form only. Its result is
  DRAFT like any other edit.

### 5.2 Empty state (`empty-*.png`)

`ResumeIntake variant="empty"`, restyled to two equal choice tiles (`sm+` two columns, mobile stacked),
max width 720px: **Fill in by hand** (primary) and **Upload to prefill** (outline, opens the existing
file intake: PDF/DOCX, paste-text fallback unchanged). Under the tiles, one muted line: upload only fills
the fields; the resume gets the Verified status after the check and HR confirmation. No other change to
the existing intake flow or its states. **Decided:** the button keeps the catalog wording "Fill in by
hand" (the brief said "Fill in manually"; copy review agreed: one concept, one wording).

### 5.3 Progress stages (`progress-*.png`)

- One `Card`, `role="status"` `aria-live="polite"`. Spinner (`Loader2`, `animate-spin`,
  `motion-reduce:animate-none`), title "Checking the resume", badge "Checking".
- Indeterminate bar: 4px track `bg-secondary`, fill `bg-primary`. Under
  `prefers-reduced-motion` the fill is static, full width, 40% opacity.
- Stage list (`<ol>`): **Queued** (done when `CHECKING`) → **Check** (current) → **HR confirmation**
  (pending). Under "Check" one muted line lists what the run does: writing the text · checking against
  the facts · building the PDF · ATS check · visual check. The DTO has no current-stage field, so these
  five are **not** ticked one by one (see Open questions, Q1). While `QUEUED`, "Queued" is the current
  step and the title is "Queued for checking".
- This screen is for `staged === null` only. With `staged !== null` (a staged edit or regenerate) the
  confirm step stays on screen read-only instead (§5.4).
- Below the card: one line with a lock icon, "Editing is unavailable while the check runs.", and the
  facts form at `opacity-50` inside `<fieldset disabled>`: the values stay readable, the controls leave
  the tab order. The picker and the layout switches are disabled the same way (§5.6, §5.7).
- Template or layout run on VERIFIED (`VERIFIED` + busy): no big card. The bar shows the Verified badge
  plus a "Checking the new formatting" badge (uk "Перевіряємо нове оформлення") and the line "The resume stays verified while the check
  runs." The DTO does not tell a template run from a layout run, so this badge text covers both
  (`progress.templateRun` is neutral on purpose; see Q6).
- Announcements: the live region announces the title change once per status change (Queued → Checking
  → result). Do not re-announce on every poll.

### 5.4 Confirm step (`confirm-*.png`, `design.png`)

- **Shown whenever `staged !== null`.** In `AWAITING_CONFIRM` it is interactive. In `QUEUED` /
  `CHECKING` (after a staged edit or regenerate) it is read-only: a progress line at the top of the
  header card (badge "Checking", the indeterminate bar, text "Updating and checking the text…",
  `role="status"`), and **every** action disabled — Confirm, Change the facts, Edit, Regenerate. No
  per-block marker: the DTO does not say which block started the run. When the run ends the step
  becomes interactive again (or the failure panel shows).
- **Header card:** badge "Awaiting confirmation", title "Review the resume text", sub-line, actions
  "Change the facts" (outline) and **Confirm** (primary, `Check` icon). Confirm renders only when
  `canConfirm`. Disabled while busy. On click: `POST confirm { runId: staged.runId, version }`. A
  `RESUME_CONFIRM_STALE` answer shows the catalog message as a toast and refetches.
- **SENIOR (`!canConfirm`):** no Confirm button; the header shows the line "HR confirms the resume. You
  can still change the facts and submit again." Edit and Regenerate stay available to them.
- **"Change the facts"** expands the facts form below. The first change shows an inline warning
  "Changing the facts discards this result." before saving (no modal).
- **Body:** `lg+` two columns: written blocks `minmax(0,1fr)` + the staged PDF `minmax(320px,420px)`,
  `sticky top-4`. Below `lg`: a two-tab switch **Text | PDF** (`Tabs`, full-width triggers, 44px tall
  on mobile) shows one pane at a time.
- **Written block** (one `Card` per block — summary, then one per experience item in order):
  - header: block title (summary: "About"; item: `{role} · {company}` + the period in `tabular-nums`
    muted), the badges, the actions;
  - body: a `.pair` grid — `sm+` `2fr | 3fr`, mobile stacked: **From the facts** (summary: headline ·
    years · top skills; item: the notes as a list), muted, `border-l-2 border-border pl-3`; then
    **Generated** (summary text; item bullets), `border-l-2 border-primary pl-3`. Labels are 11px
    uppercase muted.
  - **Summary:** actions Edit (`PUT staged`, path `summary`) and Regenerate (path `summary`).
  - **Item:** Regenerate for the whole item (path `experience.<i>.bullets`), and an icon-only Edit per
    bullet (path `experience.<i>.bullets.<j>`), aria-label and title "Edit bullet {j}, job {i}".
  - **Edited by hand:** a dashed outline `Badge` "Edited by hand" next to the title for every path in
    `staged.editedPaths` (summary) or on the item when any of its bullets is listed (plus the same
    badge, `sm` size, on the bullet itself). Tooltip: "A person edited this text — the fact check did
    not run on it."
  - **Fallback note:** for each path in `verificationReport.fallbacks` that belongs to the block, an amber
    note under the header: "The generated text did not pass the fact check — your notes are shown as
    they are."
- **Inline edit:** the text is replaced by a `Textarea` (autofocus, label "Bullet {j}, job {i}" or
  "About") with Save / Cancel. Save sends `PUT staged`; on success the row goes to `QUEUED` and the
  whole step turns read-only with the "Updating and checking the text…" line (above). A 4xx
  `RESUME_STAGED_TEXT_INVALID` shows the catalog message under the field (`aria-invalid`), the text
  stays in the textarea, and the matched text is never echoed. Escape = Cancel.
- **Staged PDF:** the existing `PdfPreview` fed by a blob hook on `GET …/resume/staged-pdf` (same
  pattern as `useResumePdfBlob`; never a raw `<object>` on the URL — `senior-resume.md` finding #1).
  Header "PDF before confirmation" + "Download PDF". Under the preview: template name and page count
  when known. No "PDF pending" state: the server sends `staged` only with a staged PDF, and
  `pdfAvailable` is always `true`. While the blob loads, the existing `PdfPreview` skeleton.

### 5.5 Failure panel (`failure-*.png`)

- **FAILED:** a panel `border-amber-500/40 bg-amber-500/10 rounded-xl p-4`, `role="alert"` (rendered
  once when the status flips; not re-mounted on poll), `TriangleAlert` icon `text-amber-500`. Title =
  the code title, badge "Failed the check", body = the code body (§10.3).
- **Items:** `verificationReport.gates[].items` of every gate with `ok === false`, as the same issue
  rows as the completeness panel (amber dot). Line 1 = the label from the path (§10.6), line 2 = the
  reason text (§10.5). Cap the list at 8 with "and {count} more".
  - **Path normalisation first:** the ATS checker writes bracket paths (`experience[0].period`,
    `skills[2]`, `pages[0]`), the other gates dot paths (`experience.0.bullets.1`, `pages.0`). Turn
    `x[i]` into `x.i` before the lookup, so one table serves both.
  - **A row is a button only when the path maps to a facts field** (§10.6). Click → focus that field.
    Paths that are not fields themselves (e.g. `experience.1.bullets`) map to the experience item's
    notes field.
  - **Empty path (`''`)** — UNREADABLE, DROPPED_GLYPHS, HEADING_ORDER, TOO_MANY_PAGES, TOO_LARGE and
    every layout item: a resume-level row, label "Whole resume", **not** a button (a plain `div`, no
    hover, no focus stop). Same for `pages.<n>` ("Page {n}", n = index + 1) and the profile `email` /
    `displayName` paths: no facts field to focus.
  - **Unknown path** (not in §10.6): if its first segment is a known section key, the row takes that
    section's label and behaves like the section row; otherwise "Whole resume", plain. Never an empty
    line 1.
  - **Unknown reason code:** the generic line "did not pass an automated check" (ruling R46). Never
    the raw code, never an empty line 2.
- **Actions by code:** retryable codes (`WRITER_UNAVAILABLE`, `ENTAILMENT_UNAVAILABLE`,
  `VISUAL_CHECK_UNAVAILABLE`, `RENDER_FAILED`, `STALLED`) → primary **Check again** (`POST submit`), no
  "Fix the facts"; `RENDER_FAILED` adds outline **Choose a template** (its body suggests one). `INCOMPLETE`, `LAYOUT_UNFIXABLE` → primary **Fix the facts** (focuses the first
  item that is a button, or the form) + outline **Check again**. `ATS_CHECK_FAILED`,
  `GLYPH_CHECK_FAILED`, `VISUAL_CHECK_FAILED` → the same two plus outline **Choose a template**
  (scrolls to the picker and focuses the selected tile), because the body offers another template.
  `CUSTOM_TEMPLATE` → primary **Choose a template**.
- **VERIFIED with a code (template or layout run failed):** no panel. A row under the Verified meta
  line: info icon `text-amber-500`, bold "The template or formatting change failed the check — the
  previous version is kept." + the code body, `role="status"`. The text names both because the DTO
  does not say which kind of run it was. The resume stays VERIFIED and fully usable.
- **DRAFT after an edit** of a VERIFIED resume: the outline Draft badge + "The facts changed. Submit
  the resume for checking again."
- Severity language: amber everywhere here (background failure, nothing lost), consistent with the
  extraction failure panel. `destructive` stays reserved for field errors and delete.

### 5.6 Template picker (`picker-*.png`)

- New `ResumeTemplatePicker` at the top of the existing `ResumeLayoutPanel`, title "Template".
- `RadioGroup` (Radix, `apps/web/app/components/ui/radio-group.tsx` semantics: roving tabindex, arrow
  keys) of four tiles from `RESUME_TEMPLATE_NAMES`. Grid: 2 columns below `md`, 4 from `md`, tile max
  200px at `xl+`.
- **Tile:** thumbnail (A4, `aspect-[1/1.414]`, `rounded-sm`, `bg-white` is the image itself — the
  thumbnail is a PNG, not drawn UI), name, one-line description, and "Current" badge (`yellow-subtle`
  bg, `text-primary`) under the text for `templateName`. Selected = `border-primary` + 1px primary ring.
  Hover `bg-accent`. Focus `ring-2 ring-ring ring-offset-2`.
- **Thumbnails** are static images rendered from **one named synthetic fixture**, the ATS fixture
  `current-job` (`apps/api/src/resumes/ats/__ats__/fixtures.ts`, "Casimir Oduya"), one per template, so
  the four differ only by look. `alt=""` (decorative; the tile's name is the label). How they are built
  and served: Open question Q2.
- **Selection = a write.** Picking a tile calls `PUT template` right away (no Apply). On VERIFIED it
  starts a template run (no Confirm); the note under the grid says so. On DRAFT / FAILED it only saves.
- **Disabled while busy:** the group `aria-disabled="true"`, tiles `opacity-50 cursor-not-allowed`, the
  line "You can change the template after the check."
- `hasCustomTemplate === true`: the picker shows the catalog message `RESUME_CUSTOM_TEMPLATE` as a
  muted note above the grid; picking a catalog tile clears it.

### 5.7 Layout panel (`picker-*.png`, cards "Оформлення")

- The existing `ResumeLayoutPanel` controls stay as they are: density `SegmentedToggle`
  (Normal / Compact), and per section a row with move up / down and hide / show icon buttons. Only the
  description changes: "The order and look of the sections. Edit the resume facts above."
- **A layout change is a write, like a template pick.** On VERIFIED it starts a check run with no
  Confirm (the same run kind as a template change; the resume stays VERIFIED). A muted note under the
  controls on VERIFIED: "Changing the formatting starts a layout check. The resume stays verified, and
  if the check fails, it keeps the previous formatting." On DRAFT / FAILED it only saves, no note.
- **Disabled while busy** (`verificationBusy`): the density toggle and every row button get
  `disabled` (native buttons, so they leave the tab order), the controls `opacity-50`, and one line
  under them: "You can change the formatting after the check." Every write answers 409 while busy, so
  nothing stays clickable.
- A failed layout run shows the VERIFIED warning row (§5.5); its items are resume-level rows (path
  `''`, reasons from the layout gate, §10.5).

## 6. Components

| Component                                                                                                       | Status   | Notes                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Card`, `Button`, `Badge`, `Input`, `Textarea`, `Select`, `Switch`, `Tabs`, `RadioGroup`, `Tooltip`, `Skeleton` | existing | shadcn/ui defaults; Button `size="sm"` for block actions, `size="icon"` for icon-only                                              |
| `MonthPickerField`                                                                                              | existing | start / end month                                                                                                                  |
| `TechAutocompleteInput`                                                                                         | existing | technologies per job                                                                                                               |
| `PdfPreview` + blob hook                                                                                        | existing | staged PDF; mirror `useResumePdfBlob` for `staged-pdf`                                                                             |
| `ResumeIntake`                                                                                                  | existing | `variant="empty"` restyled to two tiles; flow unchanged                                                                            |
| `ResumeLayoutPanel`, `ResumePdfPreview`                                                                         | existing | layout panel hosts the picker, gains `disabled` + the VERIFIED note (§5.7); live PDF preview unchanged                             |
| `ResumeStatusPanel`                                                                                             | existing | extraction state only, unchanged                                                                                                   |
| `ResumeVerificationBar`                                                                                         | **new**  | badge + meta + primary action per state (§4). Props: `resume`, `canConfirm`                                                        |
| `ResumeFactsForm`                                                                                               | **new**  | replaces the per-section `content` editor. Props: `facts`, `displayName`, `disabled`, `onSave`, `onSubmit`                         |
| `ResumeCompletenessPanel`                                                                                       | **new**  | Props: `issues: CompletenessIssue[]`, `onFocusPath(path)`, `submitDisabled`, `onSubmit`, `onSaveDraft`                             |
| `ResumeVerificationProgress`                                                                                    | **new**  | Props: `status`, `isTemplateRun` (derived: `verificationStatus === 'VERIFIED' && verificationBusy`; the DTO has no run-kind field) |
| `ResumeConfirmStep`                                                                                             | **new**  | Props: `staged`, `report`, `facts`, `canConfirm`, `busy` (busy = read-only); `WrittenBlock` per block                              |
| `ResumeVerificationFailure`                                                                                     | **new**  | Props: `code`, `report`, `variant: 'failed' \| 'warning'`, `onFocusPath`, `onRetry`, `onChooseTemplate`                            |
| `ResumeTemplatePicker`                                                                                          | **new**  | Props: `value`, `disabled`, `onChange`                                                                                             |

The issue row (`button` with dot + two lines) is shared by the completeness panel and the failure
panel: one small internal component, not a new `ui/` primitive. No new `ui/` primitive is needed.

## 7. Token map

| Purpose                                     | Token / class                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Cards                                       | `Card` (`bg-card border-border rounded-xl shadow-sm`)                       |
| Body / secondary text                       | `text-foreground` / `text-muted-foreground`                                 |
| Primary action, selected tile, written rule | `bg-primary text-primary-foreground` / `border-primary`                     |
| Source rule                                 | `border-l-2 border-border`                                                  |
| Badge Draft                                 | `Badge variant="outline"`                                                   |
| Badge Checking                              | `Badge variant="outline"` + `border-primary/30 text-primary`                |
| Badge Awaiting confirmation, Current        | `bg-yellow-subtle text-primary border-transparent`                          |
| Badge Verified                              | `bg-emerald-500/15 border-emerald-500/30 text-emerald-300`                  |
| Badge Failed, failure panel, notes          | `bg-amber-500/10 border-amber-500/40 text-amber-300`, icon `text-amber-500` |
| Badge Edited by hand                        | `Badge variant="outline"` + `border-dashed font-medium`                     |
| Field error                                 | `border-destructive`, `text-destructive text-xs`                            |
| Issue dot                                   | `bg-destructive` (completeness), `bg-amber-500` (failure)                   |
| Progress track / fill                       | `bg-secondary` / `bg-primary`                                               |
| Issue row hover                             | `hover:bg-accent`                                                           |
| Count badge                                 | `Badge variant="secondary"`                                                 |
| Focus                                       | `ring-ring` (inherited)                                                     |
| Numbers (periods, counters, dates)          | `tabular-nums`                                                              |

No new tokens. No raw hex. The emerald and amber steps are the Tailwind default palette already used in
`apps/web` (e.g. `bg-emerald-500/15`, `text-amber-300`).

## 8. Accessibility (WCAG 2.2 AA)

- **Focus order** follows the visual order at each width: bar → (progress | failure | confirm) → form
  → layout panel → PDF. Below `lg` the completeness panel precedes the form in DOM and visually.
- **Focus moves:** clicking an issue moves focus to its field. After Submit, focus stays on the Submit
  button (now disabled → move it to the progress card heading, `tabIndex={-1}`). After a run ends, do
  not steal focus; the live region announces. Opening inline edit focuses the textarea; Save / Cancel
  return focus to the block's Edit button.
- **Live regions:** progress card `role="status" aria-live="polite"`; failure panel `role="alert"` once;
  completeness count `aria-live="polite"` on the count badge only (not the whole list), so typing does
  not flood the reader. Template-run warning `role="status"`.
- **Labels:** every input has a visible `<Label htmlFor>`. Repeated fields keep the existing
  positional labels ("Company, job {position}"). Icon-only buttons have `aria-label` **and** `title`
  (closes the `senior-resume.md` MED finding for the new buttons). The picker is a `radiogroup`
  labelled by its "Template" heading; tiles are `radio` with the name as the accessible name and the
  description via `aria-describedby`.
- **Disabled while busy:** use `<fieldset disabled>` for the form (native semantics) and
  `aria-disabled` + a visible reason line for the picker; the reason is not color-only.
- **Status is not color-only:** every badge carries text; the issue dot sits next to text; the
  written/source rules are paired with "From the facts" / "Generated" labels.
- **Target size:** 44px tall on mobile for every button and tab (`h-11 sm:h-9`, icon `size-11 sm:size-9`,
  same pattern as the existing layout panel); ≥ 32px with ≥ 4px gaps from `sm` up. Issue rows ≥ 44px.
- **Contrast** (computed from the `.dark` oklch tokens, tints composited over `--card`
  `oklch(0.12 0 0)`): `muted-foreground` 4.74:1, `text-destructive` 5.67:1, `text-primary` on
  `yellow-subtle` 10.48:1, `text-emerald-300` on `emerald-500/15` 11.18:1, `text-amber-300` on
  `amber-500/10` 12.49:1. `muted-foreground` is the tightest pair: do not use it below 12px or on a tint.
  Disabled controls at 50% are exempt (SC 1.4.3), but the reason line is full contrast.
- **Motion:** spinner and bar stop under `prefers-reduced-motion`. No other motion.
- **Keyboard:** issue rows are buttons (Enter / Space). Inline edit: Escape cancels, Ctrl/Cmd+Enter
  saves. The picker uses arrow keys (Radix).

## 9. Responsive (4 classes)

| Class            | Rules                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile 320–639   | One column. Completeness panel above the form, list collapsible. Form grids one column. Confirm: Text / PDF tabs. Pair grid stacked (source above written). Buttons 44px, block actions wrap onto their own rows. Picker 2 columns. Failure actions stack. |
| Tablet 640–1023  | Form grids 2 columns (`sm:grid-cols-2`). Pair grid `2fr / 3fr`. Confirm still tabbed. Picker 4 columns from `md` (768).                                                                                                                                    |
| Laptop 1024–1439 | Form + sticky completeness panel (304px). Confirm: written + sticky staged PDF (320–420px).                                                                                                                                                                |
| Large ≥ 1440     | Same as laptop inside `max-w-6xl`; picker tiles capped at 200px.                                                                                                                                                                                           |

Long values: job titles and company names wrap (`break-words`, `min-w-0` on flex children); periods
never wrap (`whitespace-nowrap tabular-nums`); notes and bullets wrap freely; the issue row's second line
wraps. Max lists (`RESUME_LIMITS`): the form grows, the panel scrolls (`max-h-[60vh] overflow-auto` on
the list at `lg+`).

## 10. Copy

UI copy ships in `uk` (default, the Lingui source text) and `en`. Resume content (summary, bullets, the
PDF) is English only and is not in this table. In this project a Lingui `msgid` is the `uk` source text,
so the **Key** column is a suggested code-map / `context` name for the coder, not an explicit id —
except the `api-error.*` rows, which already have explicit ids. Code-to-text maps (completeness codes,
verification codes, gate reasons) follow the `api-errors/` pattern: a `Record<Code, MessageDescriptor>`
with `/* i18n */` descriptors, so every code has a text and a new code fails the type check.

The `en` column is written as its own original, not as a translation; the claim of each row is the same
in both languages (`copywriting` §5). Lengths were checked at 320px in `uk`, the longer language.
**Status: reviewed.** [x] `copy-reviewer` round 1 (sha `17304490d`): ISSUES (11), all applied in
fix round 1.

Not UI and not in the table: the screen labels in the mockup ("Варіант: …", "Стан: …"), the shell tabs
(existing), and the synthetic data.

### 10.1 Reused catalog strings (do not add new entries for these)

| Where                                     | uk (msgid)                                                                                                                                                                                      | en (msgstr)                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Badge Draft                               | Чернетка                                                                                                                                                                                        | Draft                                                                                                    |
| Confirm button                            | Підтвердити                                                                                                                                                                                     | Confirm                                                                                                  |
| Summary Edit button                       | Редагувати                                                                                                                                                                                      | Edit                                                                                                     |
| Inline edit                               | Зберегти · Скасувати                                                                                                                                                                            | Save · Cancel                                                                                            |
| Empty state title                         | Резюме ще не заповнено                                                                                                                                                                          | The resume is not filled in yet                                                                          |
| Empty state tile 1                        | Заповнити вручну                                                                                                                                                                                | Fill in by hand                                                                                          |
| Empty state file hint                     | PDF або DOCX, до {MAX_MB} МБ. Файл бачите тільки ви і команда найму.                                                                                                                            | PDF or DOCX, up to {MAX_MB} MB. Only you and the hiring team can see the file.                           |
| Form section titles                       | Навички · Досвід роботи · Освіта · Мови                                                                                                                                                         | Skills · Work experience · Education · Languages                                                         |
| Summary block title                       | Про себе                                                                                                                                                                                        | About                                                                                                    |
| Job block title / position label          | Місце роботи {position}                                                                                                                                                                         | Job {position}                                                                                           |
| Field labels                              | Посада · Мова · Рівень · Навчальний заклад · Ступінь / спеціальність                                                                                                                            | Position · Language · Level · Institution · Degree / field                                               |
| Positional labels                         | Компанія, місце роботи {position} · Посада, місце роботи {position}                                                                                                                             | Company, job {position} · Position, job {position}                                                       |
| Skills hint                               | По одній навичці в рядку                                                                                                                                                                        | One skill per line                                                                                       |
| Add buttons                               | Додати місце роботи · Додати мову · Додати освіту · Додати посилання                                                                                                                            | Add a job · Add a language · Add education · Add a link                                                  |
| Job row icon buttons                      | Перемістити місце роботи {position} вгору / вниз · Видалити місце роботи {position}                                                                                                             | Move job {position} up / down · Delete job {position}                                                    |
| Staged PDF header action                  | Завантажити PDF                                                                                                                                                                                 | Download PDF                                                                                             |
| RENDER_FAILED title                       | Не вдалося зібрати PDF                                                                                                                                                                          | Could not build the PDF                                                                                  |
| Layout panel title                        | Оформлення                                                                                                                                                                                      | Formatting                                                                                               |
| Layout panel controls (§5.7)              | Щільність верстки · Щільність · Звичайний · Щільно · Приховати «{label}» · Показати «{label}» · Перемістити «{label}» вгору / вниз                                                              | Layout density · Density · Normal · Compact · Hide “{label}” · Show “{label}” · Move “{label}” up / down |
| Toast / 409 on any write while busy       | `api-error.RESUME_VERIFICATION_BUSY`                                                                                                                                                            | (catalog)                                                                                                |
| Confirm on a stale run                    | `api-error.RESUME_CONFIRM_STALE`                                                                                                                                                                | (catalog)                                                                                                |
| Submit answered 4xx incomplete            | `api-error.RESUME_INCOMPLETE`                                                                                                                                                                   | (catalog)                                                                                                |
| `hasCustomTemplate`, CUSTOM_TEMPLATE body | `api-error.RESUME_CUSTOM_TEMPLATE` (uk unchanged)                                                                                                                                               | **changed:** "This resume template cannot be checked. Choose a template from the catalog."               |
| Staged edit rejected (`reason` select)    | `api-error.RESUME_STAGED_TEXT_INVALID` — "Текст не збережено: {reason, select, NON_LATIN {пишіть лише латиницею} CONTACT_IN_TEXT {приберіть ім’я, email або телефон} other {перевірте текст}}." | (catalog) — never append the matched text                                                                |

**Decided:** the empty-state button keeps the catalog "Fill in by hand" (the brief said "Fill in
manually"; copy review agreed: one concept, one wording).

**Changed catalog strings** (the coder edits both `.po` files and, for the api-error, the en fallback
`message` in `packages/shared/src/schemas/api-errors/resume.ts`; this design pass may not):

- `api-error.RESUME_CUSTOM_TEMPLATE` en → "This resume template cannot be checked. Choose a template
  from the catalog." The old en said "verification"; every new en string says "check".
- Layout panel description: uk "Порядок і вигляд розділів. Факти резюме редагуються вище." / en
  "The order and look of the sections. Edit the resume facts above." (the old text pointed at the resume
  text editor, which this feature removes).

### 10.2 New UI strings

| Key                               | uk                                                                                                                                   | en                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `verify.bar.draftChanged`         | Факти змінено. Надішліть резюме на перевірку знову.                                                                                  | The facts changed. Submit the resume for checking again.                                                                            |
| `verify.badge.checking`           | Перевіряється                                                                                                                        | Checking                                                                                                                            |
| `verify.badge.awaiting`           | Чекає підтвердження                                                                                                                  | Awaiting confirmation                                                                                                               |
| `verify.badge.verified`           | Перевірено                                                                                                                           | Verified                                                                                                                            |
| `verify.badge.failed`             | Не пройшло перевірку                                                                                                                 | Failed the check                                                                                                                    |
| `verify.bar.verifiedMeta`         | Перевірено {date} · {name}                                                                                                           | Verified {date} · {name}                                                                                                            |
| `completeness.title`              | Що ще потрібно                                                                                                                       | What is still missing                                                                                                               |
| `completeness.count`              | {count, plural, one {# поле} few {# поля} many {# полів} other {# поля}}                                                             | {count, plural, one {# field} other {# fields}}                                                                                     |
| `completeness.hide` / `.show`     | Сховати · Показати                                                                                                                   | Hide · Show                                                                                                                         |
| `completeness.listLabel` (aria)   | Незаповнені поля                                                                                                                     | Missing fields                                                                                                                      |
| `completeness.clean`              | Усе заповнено — можна надсилати                                                                                                      | Everything is filled in — ready to submit                                                                                           |
| `facts.submit`                    | Надіслати на перевірку                                                                                                               | Submit for checking                                                                                                                 |
| `facts.submitHint`                | Спершу заповніть поля зі списку                                                                                                      | Fill in the fields in the list first                                                                                                |
| `facts.saveDraft`                 | Зберегти чернетку                                                                                                                    | Save the draft                                                                                                                      |
| `facts.basics`                    | Основне                                                                                                                              | Basics                                                                                                                              |
| `facts.headline`                  | Цільова посада                                                                                                                       | Target role                                                                                                                         |
| `facts.city` / `facts.country`    | Місто · Країна                                                                                                                       | City · Country                                                                                                                      |
| `facts.workFormat`                | Формат роботи                                                                                                                        | Work format                                                                                                                         |
| `facts.workFormat.*`              | Віддалено · Гібридно · В офісі                                                                                                       | Remote · Hybrid · On-site                                                                                                           |
| `facts.skillsCounter`             | {own} + {fromJobs} з досвіду = {total} з 5                                                                                           | {own} + {fromJobs} from the jobs = {total} of 5                                                                                     |
| `facts.company`                   | Компанія                                                                                                                             | Company                                                                                                                             |
| `facts.location`                  | Локація (необов’язково)                                                                                                              | Location (optional)                                                                                                                 |
| `facts.start` / `facts.end`       | Початок · Кінець                                                                                                                     | Start · End                                                                                                                         |
| `facts.current`                   | Працюю тут зараз                                                                                                                     | I work here now                                                                                                                     |
| `facts.technologies`              | Технології                                                                                                                           | Technologies                                                                                                                        |
| `facts.notes`                     | Нотатки про досягнення                                                                                                               | Achievement notes                                                                                                                   |
| `facts.notesHint`                 | По одній нотатці в рядку                                                                                                             | One note per line                                                                                                                   |
| `facts.notesPlaceholder`          | Що ви зробили і з яким результатом                                                                                                   | What you did and what came of it                                                                                                    |
| `facts.level.native`              | Рідна                                                                                                                                | Native                                                                                                                              |
| `facts.toast.saved`               | Чернетку збережено                                                                                                                   | Draft saved                                                                                                                         |
| `facts.toast.submitted`           | Резюме надіслано на перевірку                                                                                                        | Resume sent for checking                                                                                                            |
| `facts.serverChanged`             | Збережена версія змінилася.                                                                                                          | The saved version changed.                                                                                                          |
| `facts.loadSaved`                 | Завантажити збережену версію                                                                                                         | Load the saved version                                                                                                              |
| `facts.link.label` / `.url`       | Назва · Адреса посилання                                                                                                             | Name · Link URL                                                                                                                     |
| `facts.link.a11yNames`            | Назва, посилання {n} · Адреса посилання, рядок {n}                                                                                   | Name, link {n} · Link URL, row {n}                                                                                                  |
| `facts.education.years`           | Рік початку · Рік завершення                                                                                                         | Start year · End year                                                                                                               |
| `empty.body`                      | Заповніть факти вручну або завантажте резюме — ми заповнимо з нього поля, а ви переглянете.                                          | Fill in the facts by hand or upload a resume — we’ll prefill the fields from it, and you review them.                               |
| `empty.manualHint`                | Порожня форма фактів. Перевірка запускається, коли все заповнено.                                                                    | An empty facts form. Checking starts once everything is filled in.                                                                  |
| `empty.upload`                    | Завантажити, щоб заповнити                                                                                                           | Upload to prefill                                                                                                                   |
| `empty.uploadNote`                | Завантаження лише заповнює поля. Статус «Перевірено» резюме отримає після перевірки й підтвердження HR.                              | Uploading only fills in the fields. The resume gets the Verified status after the check and HR confirmation.                        |
| `progress.title`                  | Перевіряємо резюме                                                                                                                   | Checking the resume                                                                                                                 |
| `progress.titleQueued`            | У черзі на перевірку                                                                                                                 | Queued for checking                                                                                                                 |
| `progress.stage.*`                | У черзі · Перевірка · Підтвердження HR                                                                                               | Queued · Check · HR confirmation                                                                                                    |
| `progress.checkDetail`            | Пишемо текст · Звіряємо з фактами · Збираємо PDF · ATS-перевірка · Візуальна перевірка                                               | Writing the text · Checking against the facts · Building the PDF · ATS check · Visual check                                         |
| `progress.canClose`               | Вкладку можна закрити: перевірка йде на сервері, результат буде тут.                                                                 | You can close this tab: the check runs on the server and the result shows up here.                                                  |
| `progress.locked`                 | Поки триває перевірка, редагування недоступне.                                                                                       | Editing is unavailable while the check runs.                                                                                        |
| `progress.templateRun`            | Перевіряємо нове оформлення                                                                                                          | Checking the new formatting                                                                                                         |
| `progress.templateRunNote`        | Резюме лишається перевіреним, поки триває перевірка.                                                                                 | The resume stays verified while the check runs.                                                                                     |
| `failure.templateWarning`         | Зміна шаблону чи оформлення не пройшла перевірку — залишено попередній варіант.                                                      | The template or formatting change failed the check — the previous version is kept.                                                  |
| `failure.chooseTemplate`          | Обрати шаблон                                                                                                                        | Choose a template                                                                                                                   |
| `failure.wholeResume`             | Резюме загалом                                                                                                                       | Whole resume                                                                                                                        |
| `failure.page`                    | Сторінка {n}                                                                                                                         | Page {n}                                                                                                                            |
| `failure.period`                  | Період                                                                                                                               | Period                                                                                                                              |
| `failure.profileEmail`            | Email у профілі                                                                                                                      | Profile email                                                                                                                       |
| `layout.verifiedNote`             | Зміна оформлення запустить перевірку макета. Резюме лишиться перевіреним, а якщо перевірка не пройде — збереже попереднє оформлення. | Changing the formatting starts a layout check. The resume stays verified, and if the check fails, it keeps the previous formatting. |
| `layout.busy`                     | Змінити оформлення можна після перевірки.                                                                                            | You can change the formatting after the check.                                                                                      |
| `confirm.title`                   | Перегляньте текст резюме                                                                                                             | Review the resume text                                                                                                              |
| `confirm.sub` (`canConfirm`)      | Текст згенеровано з ваших фактів. Підтвердьте, відредагуйте або згенеруйте заново.                                                   | The text is generated from your facts. Confirm it, edit it or regenerate it.                                                        |
| `confirm.subNoConfirm`            | Текст згенеровано з ваших фактів. Відредагуйте його або згенеруйте заново.                                                           | The text is generated from your facts. Edit it or regenerate it.                                                                    |
| `confirm.hrConfirms`              | Резюме підтверджує HR. Ви можете змінити факти й надіслати знову.                                                                    | HR confirms the resume. You can still change the facts and submit again.                                                            |
| `confirm.changeFacts`             | Змінити факти                                                                                                                        | Change the facts                                                                                                                    |
| `confirm.changeFactsWarning`      | Зміна фактів скасує результат цієї перевірки.                                                                                        | Changing the facts discards the result of this check.                                                                               |
| `confirm.tabs` (aria) / tabs      | Перегляд · Текст · PDF                                                                                                               | View · Text · PDF                                                                                                                   |
| `confirm.editedByHand`            | Змінено вручну                                                                                                                       | Edited by hand                                                                                                                      |
| `confirm.editedByHandTip`         | Цей текст змінила людина — перевірку фактів для нього не запускали.                                                                  | A person edited this text — the fact check did not run on it.                                                                       |
| `confirm.regenerate`              | Згенерувати заново                                                                                                                   | Regenerate                                                                                                                          |
| `confirm.regenerateItem` (aria)   | Згенерувати заново пункти, місце роботи {position}                                                                                   | Regenerate the bullets, job {position}                                                                                              |
| `confirm.editBullet` (aria+title) | Редагувати пункт {bullet}, місце роботи {position}                                                                                   | Edit bullet {bullet}, job {position}                                                                                                |
| `confirm.bulletLabel`             | Пункт {bullet}, місце роботи {position}                                                                                              | Bullet {bullet}, job {position}                                                                                                     |
| `confirm.fromFacts` / `.written`  | З фактів · Згенеровано                                                                                                               | From the facts · Generated                                                                                                          |
| `confirm.notes` / `.bullets`      | Нотатки · Пункти                                                                                                                     | Notes · Bullets                                                                                                                     |
| `confirm.years`                   | {count, plural, one {# рік} few {# роки} many {# років} other {# року}}                                                              | {count, plural, one {# year} other {# years}}                                                                                       |
| `confirm.fallbackNote`            | Згенерований текст не пройшов звірку з фактами — тут ваші нотатки як є.                                                              | The generated text did not pass the fact check — your notes are shown as they are.                                                  |
| `confirm.recheckNote`             | Після збереження перевіримо PDF ще раз.                                                                                              | Once you save, we check the PDF again.                                                                                              |
| `confirm.checkingChange`          | Оновлюємо й перевіряємо текст…                                                                                                       | Updating and checking the text…                                                                                                     |
| `confirm.locked`                  | Усі дії недоступні, поки триває перевірка.                                                                                           | Every action is unavailable while the check runs.                                                                                   |
| `confirm.toast.textSaved`         | Текст збережено                                                                                                                      | Text saved                                                                                                                          |
| `confirm.toast.confirmed`         | Резюме підтверджено                                                                                                                  | Resume confirmed                                                                                                                    |
| `confirm.pdfTitle`                | PDF до підтвердження                                                                                                                 | PDF before confirmation                                                                                                             |
| `confirm.pdfTemplate`             | Шаблон: {template}                                                                                                                   | Template: {template}                                                                                                                |
| `confirm.pdfLabel` (aria)         | Попередній перегляд PDF резюме до підтвердження                                                                                      | Preview of the resume PDF before confirmation                                                                                       |
| `confirm.pdfFilename`             | Резюме перед підтвердженням.pdf                                                                                                      | Resume before confirmation.pdf                                                                                                      |
| `failure.fixFacts`                | Виправити факти                                                                                                                      | Fix the facts                                                                                                                       |
| `failure.retry`                   | Перевірити ще раз                                                                                                                    | Check again                                                                                                                         |
| `failure.more`                    | і ще {count}                                                                                                                         | and {count} more                                                                                                                    |
| `picker.title`                    | Шаблон                                                                                                                               | Template                                                                                                                            |
| `picker.intro`                    | Усі шаблони каталогу підтримують перевірку. Мініатюри — на прикладі одного резюме.                                                   | Every catalog template supports the check. The thumbnails show one sample resume.                                                   |
| `picker.name.*`                   | Класичний · Сучасний · Стислий · Технічний                                                                                           | Classic · Modern · Condensed · Technical                                                                                            |
| `picker.desc.classic`             | Шрифт із засічками, ім’я по центру                                                                                                   | Serif font, centered name                                                                                                           |
| `picker.desc.modern`              | Без засічок, акцентна лінія під заголовками                                                                                          | Sans-serif, an accent rule under the headings                                                                                       |
| `picker.desc.compact`             | Дати праворуч, менше відступів                                                                                                       | Dates on the right, tighter spacing                                                                                                 |
| `picker.desc.technical`           | Навички за категоріями                                                                                                               | Skills grouped by category                                                                                                          |
| `picker.current`                  | Поточний                                                                                                                             | Current                                                                                                                             |
| `picker.verifiedNote`             | Зміна шаблону запустить перевірку макета. Резюме лишиться перевіреним, а якщо перевірка не пройде — збереже попередній шаблон.       | Changing the template starts a layout check. The resume stays verified, and if the check fails, it keeps the previous template.     |
| `picker.discardsStaged`           | Зміна шаблону чи оформлення скасує результат цієї перевірки.                                                                         | Changing the template or the layout discards the result of this check.                                                              |
| `picker.busy`                     | Шаблон можна змінити після перевірки.                                                                                                | You can change the template after the check.                                                                                        |
| `picker.toast.changed`            | Шаблон змінено                                                                                                                       | Template changed                                                                                                                    |

### 10.3 Verification error codes (`verificationErrorCode`, all 11)

Primary action: **R** = Check again (retryable), **F** = Fix the facts + outline Check again, **T** =
Choose a template, **F+T** = F plus outline Choose a template (`failure.chooseTemplate`, the body names
another template), **R+T** = R plus outline Choose a template. On a VERIFIED row with a code the title is replaced by `failure.templateWarning` and
the body is kept.

| Code                       | Act | uk title / body                                                                                                                                            | en title / body                                                                                                                                                              |
| -------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INCOMPLETE`               | F   | Заповнено не все / Перевірка не почалася: заповніть поля зі списку.                                                                                        | Some fields are missing / The check did not start: fill in the fields in the list.                                                                                           |
| `CUSTOM_TEMPLATE`          | T   | Шаблон не підтримує перевірку / body = `api-error.RESUME_CUSTOM_TEMPLATE` (reused)                                                                         | This template cannot be checked / body = `api-error.RESUME_CUSTOM_TEMPLATE` (en changed, §10.1)                                                                              |
| `WRITER_UNAVAILABLE`       | R   | Сервіс написання тексту недоступний / Це тимчасово. Спробуйте ще раз за кілька хвилин.                                                                     | The writing service is unavailable / This is temporary. Try again in a few minutes.                                                                                          |
| `ENTAILMENT_UNAVAILABLE`   | R   | Сервіс звірки з фактами недоступний / Це тимчасово. Спробуйте ще раз за кілька хвилин.                                                                     | The fact-check service is unavailable / This is temporary. Try again in a few minutes.                                                                                       |
| `RENDER_FAILED`            | R+T | Не вдалося зібрати PDF (reused) / Спробуйте ще раз. Якщо повториться — змініть шаблон або зверніться до адміністратора.                                    | Could not build the PDF (reused) / Try again. If it happens again, change the template or contact an admin.                                                                  |
| `ATS_CHECK_FAILED`         | F+T | ATS не прочитав PDF / Частина тексту не читається з PDF. Скоротіть поля зі списку або оберіть інший шаблон.                                                | An ATS could not read the PDF / Part of the text cannot be read from the PDF. Shorten the fields in the list or choose another template.                                     |
| `GLYPH_CHECK_FAILED`       | F+T | Шрифт не показує частину символів / У PDF випали символи з полів зі списку. Замініть їх звичайними латинськими літерами або оберіть інший шаблон.          | The font cannot show some characters / Some characters from the fields in the list are missing in the PDF. Replace them with plain Latin letters or choose another template. |
| `LAYOUT_UNFIXABLE`         | F   | Резюме не вміщується в макет / Резюме не вміщується у 2 сторінки або остання сторінка майже порожня. Скоротіть нотатки або змініть щільність в оформленні. | The resume does not fit the layout / The resume does not fit in 2 pages, or the last page is almost empty. Shorten the notes or change the density in the formatting.        |
| `VISUAL_CHECK_FAILED`      | F+T | PDF не пройшов візуальну перевірку / На сторінці знайдено накладання або обрізаний текст. Скоротіть поля зі списку або оберіть інший шаблон.               | The PDF failed the visual check / Overlapping or cut-off text was found on the page. Shorten the fields in the list or choose another template.                              |
| `VISUAL_CHECK_UNAVAILABLE` | R   | Візуальна перевірка недоступна / Це тимчасово. Спробуйте ще раз за кілька хвилин.                                                                          | The visual check is unavailable / This is temporary. Try again in a few minutes.                                                                                             |
| `STALLED`                  | R   | Перевірка зупинилася / Перевірка тривала надто довго й зупинилась. Запустіть її ще раз — факти збережено.                                                  | The check stopped / The check ran too long and stopped. Start it again — the facts are saved.                                                                                |

`RESUME_STAGED_TEXT_INVALID` (an API error on `PUT staged`, not a status code) and `RESUME_INCOMPLETE`
(a 4xx on `POST submit` when the server finds issues the local check missed) render the reused catalog
messages from §10.1: the first under the inline edit field, the second as a toast followed by a refetch
of the live issues. `RESUME_CUSTOM_TEMPLATE` is both the picker note and the CUSTOM_TEMPLATE body.

### 10.4 Completeness codes (all 17)

The panel row is `<field label>` (§10.6) on line one and this text on line two; the same text goes under
the field. `END_BEFORE_START` also fires on `education.<i>.endYear`; the same text fits both.

| Code               | uk                                                                                      | en                                                                              |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `HEADLINE_MISSING` | Вкажіть цільову посаду                                                                  | Enter the target role                                                           |
| `NO_EXPERIENCE`    | Додайте хоча б одне місце роботи                                                        | Add at least one job                                                            |
| `COMPANY_MISSING`  | Вкажіть компанію                                                                        | Enter the company                                                               |
| `ROLE_MISSING`     | Вкажіть посаду                                                                          | Enter the position                                                              |
| `START_MISSING`    | Вкажіть місяць початку                                                                  | Enter the start month                                                           |
| `END_MISSING`      | Вкажіть місяць завершення або позначте «Працюю тут зараз»                               | Enter the end month or tick “I work here now”                                   |
| `END_BEFORE_START` | Кінець не може бути раніше за початок                                                   | The end cannot be before the start                                              |
| `START_IN_FUTURE`  | Початок не може бути в майбутньому                                                      | The start cannot be in the future                                               |
| `END_IN_FUTURE`    | Кінець не може бути в майбутньому. Якщо ви ще тут працюєте, позначте «Працюю тут зараз» | The end cannot be in the future. If you still work here, tick “I work here now” |
| `NO_NOTES`         | Додайте хоча б одну нотатку про досягнення                                              | Add at least one achievement note                                               |
| `TOO_FEW_SKILLS`   | Потрібно щонайменше 5 навичок разом із технологіями з досвіду                           | Add at least 5 skills, counting the technologies from the jobs                  |
| `ENGLISH_MISSING`  | Додайте англійську до мов                                                               | Add English to the languages                                                    |
| `NON_LATIN`        | Пишіть лише латиницею — резюме англійською                                              | Use Latin letters only — the resume is in English                               |
| `NAME_NON_LATIN`   | Ім’я в профілі має бути латиницею. Змініть його в профілі                               | The profile name must be in Latin letters. Change it in the profile             |
| `CONTACT_IN_TEXT`  | Приберіть ім’я, email або телефон — контакти не потрапляють у текст резюме              | Remove the name, email or phone number — contacts never go into the resume text |
| `LINK_INVALID`     | Вкажіть назву й адресу https:// або mailto:                                             | Enter a label and an https:// or mailto: address                                |
| `YEAR_INVALID`     | Рік має бути між 1950 і 2100                                                            | The year must be between 1950 and 2100                                          |

`LINK_INVALID` refuses what `resumeLinkSchema` refuses (url length and scheme, label length), plus a blank
label: that one is deliberately stricter than the server (R66), since a link needs a name on the page.

### 10.5 Gate reason codes (`verificationReport.gates[].items[].reason`)

Second line of a failure-panel row. Read from the producers on the branch: the content gates
(`resume-verification.service.ts`), `render-gates.ts`, the ATS checker (`resume-ats-checker.ts`), the
layout gate (`LAYOUT_CODES`) and the visual gate (`VISUAL_CHECKS` in
`apps/api/src/extraction-worker/link-contract.ts`). The list is not typed in `@crm/shared` (Q4), so a
code the map does not know gets the **generic line** (ruling R46), never the raw code. The path column
shows what the producer writes; `''` = a resume-level row (§5.5).

| Gate    | Reason                   | Path the producer writes                           | uk                                    | en                              |
| ------- | ------------------------ | -------------------------------------------------- | ------------------------------------- | ------------------------------- |
| content | `EMPTY`                  | `summary`, `experience.<i>.bullets[.<j>]`          | порожньо                              | empty                           |
| content | `UNGROUNDED`             | same                                               | немає у фактах                        | not in the facts                |
| content | `NON_LATIN`              | same                                               | не латиницею                          | not in Latin letters            |
| content | `CONTACT_IN_TEXT`        | same                                               | містить контакти                      | contains contact details        |
| content | `NOT_SUPPORTED`          | same                                               | шаблон це не підтримує                | not supported by the template   |
| content | `HUMAN_EDITED`           | the edited path                                    | змінено вручну                        | edited by hand                  |
| content | `BAD_INDEX`              | same                                               | generic line                          | generic line                    |
| ats     | `MISSING_TEXT`           | `summary`, `skills[i]`, `experience[i].<field>`, … | текст не знайдено в PDF               | text not found in the PDF       |
| ats     | `HEADING_MISSING`        | section key (`summary`, `skills`, `experience`, …) | немає заголовка розділу               | section heading missing         |
| ats     | `HEADING_ORDER`          | `''`                                               | заголовки розділів не в тому порядку  | section headings out of order   |
| ats     | `HIDDEN_SECTION_PRESENT` | section key                                        | прихований розділ потрапив у PDF      | a hidden section is in the PDF  |
| ats     | `ITEM_ORDER`             | `experience[i].<field>`                            | текст стоїть не у своєму місці роботи | text sits under the wrong job   |
| ats     | `PERIOD_FORMAT`          | `experience[i].period`                             | дати у неправильному форматі          | dates in the wrong format       |
| ats     | `CONTACT_NOT_IN_BODY`    | `displayName`, `email`                             | немає в шапці першої сторінки         | missing from the page 1 header  |
| ats     | `REPLACEMENT_CHAR`       | `pages[i]`                                         | нечитабельні символи                  | unreadable characters           |
| ats     | `LIGATURE`               | `pages[i]`                                         | злиті літери (лігатури)               | joined letters (ligatures)      |
| ats     | `LETTER_SPACED`          | `pages[i]`                                         | заголовок набрано врозрядку           | heading spaced letter by letter |
| ats     | `TOO_MANY_PAGES`         | `''`                                               | більше 2 сторінок                     | more than 2 pages               |
| ats     | `TOO_LARGE`              | `''`                                               | файл більший за 1 МБ                  | file larger than 1 MB           |
| ats     | `UNREADABLE`             | `''`                                               | PDF не читається як текст             | the PDF cannot be read as text  |
| glyph   | `DROPPED_GLYPHS`         | `''`                                               | символи випали з PDF                  | characters missing in the PDF   |
| layout  | `LAST_PAGE_UNDERFILLED`  | `''`                                               | остання сторінка майже порожня        | the last page is almost empty   |
| layout  | `TOO_MANY_PAGES`         | `''`                                               | більше 2 сторінок                     | more than 2 pages               |
| layout  | `TOO_LARGE`              | `''`                                               | файл більший за 1 МБ                  | file larger than 1 MB           |
| visual  | `overflow`               | `pages.<n>`                                        | текст виходить за поле                | text runs past the margin       |
| visual  | `overlap`                | `pages.<n>`                                        | рядки накладаються                    | lines overlap                   |
| visual  | `ragged`                 | `pages.<n>`                                        | нерівний край тексту                  | ragged text edge                |
| visual  | `orphan`                 | `pages.<n>`                                        | висячий рядок                         | lone line on the page           |
| visual  | `broken-bullet`          | `pages.<n>`                                        | пункт розірвано                       | broken bullet                   |
| visual  | `uneven-spacing`         | `pages.<n>`                                        | нерівні відступи                      | uneven spacing                  |
| visual  | `cut-off`                | `pages.<n>`                                        | текст обрізано                        | text is cut off                 |
| any     | unknown code (R46)       | any                                                | автоматична перевірка не пройдена     | did not pass an automated check |

The map is keyed by reason only (one text per code): `TOO_MANY_PAGES` / `TOO_LARGE` read the same in
the ATS and the layout gate. Visual codes are lower-case with hyphens as the gate sends them. The 1 MB
and 2-page figures mirror `ATS_MAX_BYTES` / `ATS_MAX_PAGES` in `resume-ats-checker.ts` (API-only today);
if they move to `@crm/shared`, interpolate them instead of the literal numbers.

**Mockup example** (`failure-*.png`, ATS_CHECK_FAILED): `experience[1].bullets[0]` + `MISSING_TEXT` →
button "Місце роботи 2 · Пункти" / "текст не знайдено в PDF"; `''` + `HEADING_ORDER` → plain row
"Резюме загалом" / "заголовки розділів не в тому порядку".

### 10.6 Field labels for issue rows (from the path)

Pattern `{section} · {field}`, where a numbered section uses the position (index + 1). Normalise first:
`x[i]` → `x.i` (`experience[0].period` → `experience.0.period`, `pages[0]` → `pages.0`). The last column
says whether the row is a button (focuses a facts field) or a plain resume-level row (§5.5).

| Path                                                                                        | uk                                                                                  | en                                                                                | Row                                |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| `''` (empty)                                                                                | Резюме загалом                                                                      | Whole resume                                                                      | plain                              |
| `pages.<i>`                                                                                 | Сторінка {n}                                                                        | Page {n}                                                                          | plain                              |
| `email`                                                                                     | Email у профілі                                                                     | Profile email                                                                     | plain (lives in the profile)       |
| `experience.<i>.period`                                                                     | Місце роботи {n} · Період                                                           | Job {n} · Period                                                                  | button → the start month           |
| `education.<i>.period`                                                                      | Освіта {n} · Період                                                                 | Education {n} · Period                                                            | button → the start year            |
| section key (`skills`, `experience`, `education`, `languages`, `links`; `summary` as below) | the section title (§10.1)                                                           | the section title (§10.1)                                                         | button → the section's first field |
| `displayName`                                                                               | Ім’я в профілі                                                                      | Profile name                                                                      | plain (lives in the profile)       |
| `headline`                                                                                  | Цільова посада                                                                      | Target role                                                                       | button                             |
| `location.city` / `location.country`                                                        | Місто · Країна                                                                      | City · Country                                                                    | button                             |
| `skills`, `skills.<i>`                                                                      | Навички · Навичка {n}                                                               | Skills · Skill {n}                                                                | button                             |
| `experience`                                                                                | Досвід роботи                                                                       | Work experience                                                                   | button                             |
| `experience.<i>.<field>`                                                                    | Місце роботи {n} · {field label}                                                    | Job {n} · {field label}                                                           | button                             |
| `experience.<i>.notes[.<j>]`                                                                | Місце роботи {n} · Нотатки                                                          | Job {n} · Notes                                                                   | button                             |
| `experience.<i>.technologies.<j>`                                                           | Місце роботи {n} · Технології                                                       | Job {n} · Technologies                                                            | button                             |
| `experience.<i>.bullets[.<j>]` (report)                                                     | Місце роботи {n} · Пункти                                                           | Job {n} · Bullets                                                                 | button → the job notes             |
| `summary` (report)                                                                          | Про себе                                                                            | About                                                                             | plain (generated from all facts)   |
| `education.<i>.<field>`                                                                     | Освіта {n} · {field label}                                                          | Education {n} · {field label}                                                     | button                             |
| `languages`, `languages.<i>`, `languages.<i>.name`                                          | Мови · Мова {n}                                                                     | Languages · Language {n}                                                          | button                             |
| `links`, `links.<i>.label`, `links.<i>.url`                                                 | Посилання · Посилання {n}                                                           | Links · Link {n}                                                                  | button                             |
| any other path (fallback)                                                                   | the section title if the first segment is a known section, otherwise Резюме загалом | the section title if the first segment is a known section, otherwise Whole resume | as the section row / plain         |

## 11. Edge cases

| Case                                      | Behaviour                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Loading the tab                           | Existing tab skeleton; the bar shows a `Skeleton` badge; no layout shift when the badge text arrives                    |
| `PUT facts` / `POST submit` in flight     | Buttons show a spinner and stay the same width; form inputs stay enabled until the server says busy                     |
| Any write answers 409 busy                | Toast `api-error.RESUME_VERIFICATION_BUSY`, then refetch; the UI becomes the busy state                                 |
| The run ends while the tab is open        | Poll (existing interval) flips the screen; live region announces once                                                   |
| `staged === null` with `AWAITING_CONFIRM` | Should not happen (the DTO says `staged` is set once a staged PDF exists). Show the bar and "Check again" only          |
| Staged edit / regenerate in flight        | Status QUEUED / CHECKING with `staged` kept: the confirm step stays, read-only, under "Updating and checking the text…" |
| A report item with path `''`              | "Whole resume" plain row with the reason line; never an empty label                                                     |
| A reason code the map does not know       | The generic line "did not pass an automated check" (R46)                                                                |
| Many issues (> 15)                        | Panel list scrolls at `lg+`; count badge exact; mobile list collapsed by default when > 5                               |
| Long company / role / city                | Wrap; never truncate a fact the reviewer must read                                                                      |
| Long bullet in the confirm step           | Wraps; the edit icon button stays top-aligned in its own grid column                                                    |
| No fallbacks, no edited paths             | No notes, no badges; nothing reserves their space                                                                       |
| Every field fell back to notes            | One note per block (not per bullet), so the step stays readable                                                         |
| `!canEdit` viewer                         | Existing read-only view; no facts form, no picker, no confirm actions; the badge and verified meta still show           |
| `verifiedByName === null` on VERIFIED     | Meta line shows the date only                                                                                           |

## 12. Open design questions

| #   | Question                                                                                                                                                                                                                  | Recommendation                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Q1  | The DTO has no current runner stage, so progress can only show Queued vs Check. Expose `verificationStage` (writing / entailment / render / ats / visual)?                                                                | Not for Task 18: ship the static list. Add the field later if HR asks "where is it stuck".           |
| Q2  | How are the four thumbnails produced and served — PNGs committed to `apps/web/public` from the `current-job` fixture, or an API endpoint?                                                                                 | Committed PNGs, regenerated by a script from the fixture when a template changes; no endpoint.       |
| Q3  | Submit with unsaved changes: save then submit in one action (as specified), or force an explicit save first?                                                                                                              | One action (A1, see Assumptions).                                                                    |
| Q4  | Gate reason codes are free strings in the report schema. Type them in `@crm/shared` so §10.5 is exhaustive?                                                                                                               | Yes: an enum next to `resumeVerificationReportSchema` and a typed map in web.                        |
| Q5  | The 320px profile tab bar clips the last tab (pre-existing shell issue, not this feature).                                                                                                                                | Separate backlog item.                                                                               |
| Q6  | The DTO does not say whether a VERIFIED run is a template run or a layout run, so the badge is neutral ("Checking the new formatting", uk "Перевіряємо нове оформлення") and the warning names both. Expose the run kind? | Not for Task 18: the combined texts are correct for both. Add a field only if users find them vague. |

## Assumptions

- A1: Submit with dirty facts saves (`PUT facts`) then submits (`POST submit`) as one action with one
  spinner; "Save the draft" stays as a separate secondary action.
- A1: FAILED and the template-run warning use amber, not `destructive`, matching the existing
  extraction failure panel (background failure, nothing lost). `destructive` is for field errors only.
- A1: Below `lg` the confirm step uses Text / PDF tabs instead of stacking a 600px PDF under the text.
- A1: Selecting a template tile saves immediately (no Apply button), as the existing layout switches do.
