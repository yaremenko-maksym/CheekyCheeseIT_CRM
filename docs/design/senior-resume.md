# Design spec: Senior resume (Tier 2, retroactive)

**Slug:** `senior-resume`
**Date:** 2026-08-07, revised 2026-08-10 (PR #504 — "template + data" rebuild; closes a
design-gate `BLOCK` code-review raised on this PR)
**Design tier:** 2 (conformance — existing shadcn/ui primitives + the visual language of the
neighbouring profile tabs; the two components new in this pass, `ResumeLayoutPanel` and
`ResumePdfPreview`, are also built entirely from existing primitives — `Button`, `SegmentedToggle`,
Lucide icons — no new tokens, no new visual direction)
**Routes affected:** `/profile/:userId?tab=resume`, `/profile?tab=resume` (own profile)
**Design-gate status:** PR #497 shipped `design-gate: degraded` and this document was written to
close that gap. PR #504 **rebuilt the feature on a different data model** (a resume is now a
**layout**, i.e. a server-side Typst template, plus **data** — the structured fields — joined into a
PDF by a background render job) and ported this spec byte-for-byte from the closed branch without
updating it. Code review correctly flagged the gate as open again: the spec described a model that
no longer matches the code, and two new components (`ResumeLayoutPanel`, 240 lines;
`ResumePdfPreview`, 100 lines) existed with no design coverage at all. **This revision replaces the
stale sections below and adds a live fidelity audit against the running branch.**

---

## Brief

A **canonical, editable CV** for a SENIOR, living as the last tab on the profile card
(`apps/web/app/components/user-profile/UserProfileShell.tsx`). HR (team-scoped) and ADMIN manage
any senior's resume; a SENIOR manages only their own. The flow: upload a PDF/DOCX (or paste text) →
a background extraction turns it into structured content (summary / skills / experience /
education / languages / links) → the person edits that structure in place, section by section.

**What changed in PR #504 — the flow now has a second, independent half:** the resume is no longer
"structured content in, PDF out" as one step. It is **content + a small, closed set of typesetting
switches**, joined server-side by a Typst template into a PDF, rendered by a **detached background
job** (never inside the request — the render is CPU-bound and can take ~1.5s, see the PR body's
AC3 measurement). A human can change six things about the PDF: the **order** of its sections, which
sections are **hidden**, the **density** (vertical rhythm), and the **font scale**. Nothing else —
the template itself is executable code and stays server-side; no endpoint ever writes it.

- **Purpose:** turn a messy uploaded document into ONE structured, reusable, editable resume, laid
  out by a controlled template a non-technical person can adjust without touching typesetting code.
- **Audience:** HR doing this occasionally per senior (batch onboarding, filling gaps before a
  client submission) and a SENIOR doing it rarely for themselves — not a daily-use screen.
- **Tone:** same as the rest of the CRM — dense, quiet, scannable operations tool. The layout panel
  is a settings strip, not a design tool: six labelled rows and two segmented toggles, no
  drag-and-drop, no live WYSIWYG canvas.
- **Memorable detail:** none by design — Tier 2 conformance explicitly avoids a new visual idea.
  The one deliberate interaction choice carried over from the previous pass (explicit Save per
  section, not autosave) still holds — see `ResumeTab.tsx` file-header comment.
- **Constraints:** Tailwind v4 tokens only, shadcn/ui primitives only, Russian UI, WCAG 2.2 AA,
  responsive 320–1920, dark-default with light parity (verified this pass — see §"Dark/light
  parity" below).

---

## Reference: existing patterns reused

- `Card` / `CardHeader` / `CardContent` (`ResumeSectionCard` — one card per resume section).
- `Button`, `Input`, `Textarea`, `Skeleton` — shadcn/ui defaults, no overrides.
- `SegmentedToggle` (`apps/web/app/components/ui/segmented-toggle.tsx`) — **new to this feature**,
  not new to the codebase — used for the two 3-way switches (density, font scale). Correct choice:
  a closed 3-value set is exactly what this primitive is for, and it comes with its own
  `radiogroup`/`radio` ARIA roles for free (verified — see §A11y).
- The profile shell's existing tab bar and dirty-guard `AlertDialog` — unchanged from before.

**What was NOT reused, and should have been (this pass's main finding):**
`apps/web/app/components/documents/pdf-preview.tsx` (`PdfPreview`) is this exact codebase's
established "inline PDF preview" primitive — iframe + `<object>` progressive fallback, 3s
"blocked the embed" timeout, error state — paired with a blob-fetch hook
(`use-resume-blob.ts`'s `useApplicationResumeBlob`, or its sibling `use-document-blob.ts`). Both
already exist, are already used by `ResumePreviewDialog.tsx` (candidate resumes) and
`DocumentDetailDialog` (uploaded documents), and both exist **specifically because** a presigned
URL on this codebase's storage layer is served `Content-Disposition: attachment` for security
reasons that also apply here (`apps/api/src/vacancies/applications.service.ts:551-560` documents the
exact reasoning) — `fetch()` ignores that header, a Blob URL has no header at all, and only that
combination reliably renders inline. `ResumePdfPreview.tsx` does not use it: it points a raw
`<object data={pdfUrl}>` straight at the PDF endpoint. See §"Findings from this pass, #1" — this is
the reason the preview never renders anything.

---

## Token map (from `globals.css`)

| Purpose                                       | Token                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Section card surface                          | `bg-card` + `border-border` (via `Card`)                               |
| Section card text                             | `text-card-foreground`                                                 |
| Secondary text (period, hints, version)       | `text-muted-foreground`                                                |
| Skill / language chips                        | `bg-muted` (skills), `border` (languages)                              |
| Primary action (Скачать PDF, Применить)       | `bg-primary` / `text-primary-foreground` (`Button` default)            |
| Extraction progress panel (QUEUED/RUNNING)    | `border-primary/30` + `bg-primary/5`                                   |
| Extraction failure panel (FAILED)             | `border-amber-500/40` + `bg-amber-500/10`, icon `text-amber-500`       |
| **PDF render failure panel (NEW, this pass)** | `border-destructive/40` + `bg-destructive/5`, icon `text-destructive`  |
| Layout panel surface (NEW)                    | `border-border/60` + `bg-card/50`                                      |
| Layout panel row, hidden-section state (NEW)  | `opacity-55` + `line-through` on the label                             |
| Links (safe URL)                              | `text-primary` + `underline`                                           |
| Row divider (experience list, view mode)      | `divide-border`                                                        |
| Destructive (remove row/link, delete resume)  | `text-destructive`                                                     |
| Focus ring                                    | `ring-ring` (inherited from shadcn `Button`/`Input`/`SegmentedToggle`) |

All tokens are existing project tokens. No raw hex, no new gradient. **One inconsistency flagged,
not fixed, this pass:** the extraction-failure panel (amber — "warning, you can keep working") and
the PDF-render-failure panel (destructive/red — "error") use two different severity languages for
what is, functionally, the same category of event: _something failed automatically in the
background, nothing the user did is lost, and the rest of the screen stays fully usable._ A PDF
render failure does not block editing and retries on the next save — same shape as an extraction
failure. Recommend the PDF-failure panel move to the amber treatment for consistency, or — if
red is intentional because a render failure is _terminal_ until a layout/content change (unlike
extraction, which the user can retry by re-uploading right there) — say so in a code comment, since
right now the difference reads as accidental. `apps/web/app/components/user-profile/resume/ResumePdfPreview.tsx:33` (the `border-destructive/40 bg-destructive/5` block) vs.
`apps/web/app/components/user-profile/resume/ResumeStatusPanel.tsx:101` (the `border-amber-500/40 bg-amber-500/10` block).

---

## Component structure

```
<div data-testid="resume-tab">                       ← ResumeTab.tsx root
  <ResumeStatusPanel>                                  ← extraction state only (QUEUED/RUNNING/FAILED)
  <toolbar>                                            ← version + updatedBy · Скачать исходник · Удалить
  <ResumeIntake variant="compact">                     ← shown when showIntake=true OR status=FAILED

  <ResumeSectionCard title="О себе"> … six sections, unchanged from the previous pass …
  <ResumeSectionCard title="Ссылки">

  <ResumeLayoutPanel>                                  ← NEW this pass — see below
  <ResumePdfPreview>                                    ← NEW this pass — only if resume has content
</div>
```

### `ResumeLayoutPanel` (`apps/web/app/components/user-profile/resume/ResumeLayoutPanel.tsx`)

A single `<section>` card, always visible once a resume row exists (independent of whether it has
content — it can be adjusted before content is filled in, which is harmless since it's a no-op
until there is something to typeset).

```
┌ Оформление ─────────────────────────────── [Сбросить] [Применить] ┐
│ Порядок и вид разделов. Текст резюме меняется выше.                │
│                                                                       │
│ Разделы                                                              │
│  О себе          👁  ↑  ↓                                            │
│  Навыки          👁  ↑  ↓                                            │
│  Опыт работы     👁  ↑  ↓                                            │
│  Образование     👁  ↑  ↓                                            │
│  Языки           👁  ↑  ↓                                            │
│  Ссылки          👁  ↑  ↓                                            │
│                                                                       │
│ Плотность                        Размер шрифта                      │
│ [Плотно] [Обычно] [Свободно]     [Мелкий] [Обычный] [Крупный]       │
└───────────────────────────────────────────────────────────────────┘
```

- **Local draft, explicit apply.** Every toggle mutates a local `draft` state; `Применить` is
  disabled until `draft` differs from the server's (normalised) layout, and disabled again while
  saving. Verified live: toggling density enables the button (opacity 1, `disabled: false`);
  clicking it disables it again once the save round-trips (`disabled: true`, `opacity: 0.5`) — the
  dirty-tracking is correct, including the "already applied, nothing new to send" case after a
  successful save with no remount.
- **`Сбросить` resets to the shipped default** (`DEFAULT_RESUME_LAYOUT` — canonical order, nothing
  hidden, normal density, normal font), not to the last-saved layout — a distinct action from
  `Отмена`-style cancel elsewhere on this tab. Correctly labelled "Сбросить" (reset), not "Отмена".
- **Reordering** (`moveSection`) is boundary-safe: the topmost row's ↑ and the bottommost row's ↓
  are `disabled`, verified live via `disabled` state on both boundary buttons.
- **Hiding** a section dims it (`opacity-55`) and strikes its label through — a clear, low-noise
  signal that does not need a legend.

### `ResumePdfPreview` (`apps/web/app/components/user-profile/resume/ResumePdfPreview.tsx`)

Three states, driven by `resume.renderStatus` + `resume.pdfUpToDate` (a **separate** state machine
from the extraction one — a render can be QUEUED/RUNNING/READY/FAILED independently of whether
extraction ever ran):

| State                              | Trigger                                     | What renders                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pending** (`resume-pdf-pending`) | `!pdfUpToDate` and not a stale FAILED       | Spinner + "Готовим PDF по шаблону" + "страницу обновлять не нужно" — the query polls every 2.5s while `renderStatus` is QUEUED/RUNNING, same mechanism the extraction progress panel uses. |
| **Failed** (`resume-pdf-failed`)   | `renderStatus === 'FAILED' && !pdfUpToDate` | Server's own Russian message (`renderError`) or a generic fallback line — see the token-map inconsistency flagged above.                                                                   |
| **Ready** (`resume-pdf-preview`)   | `pdfUpToDate === true`                      | "Предпросмотр" header + "Скачать PDF" button + an `<object data={pdfUrl}>` embed, `h-[60vh]` capped `min-h-[320px] max-h-[840px]`.                                                         |

**The "Ready" state is the one this audit actually exercised live**, seeding real content through
the real API, letting a real Typst render complete (`typst 0.15.1`, matching the version pinned in
`apps/api/Dockerfile`), and confirming the PDF itself: a genuinely well-typeset one-page A4 document
— section headers in brand caps, bold company names, right-aligned periods, correct Cyrillic. **The
`<object>` embed never shows any of it** — see §"Findings from this pass, #1", the single most
important finding of this pass.

---

## States (unchanged sections carried forward + the two new ones above)

Extraction states (Loading / Query error / Empty / QUEUED / RUNNING / Failed / Ready), the
failure-code → copy table, and the section-editing state machine are unchanged from the previous
pass and were spot-checked live this round without regressions. Full detail in the previous
revision's history — summarised here since the diff is additive, not a rewrite of that half:

| State                       | Trigger                             | Visual                                                                   |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Loading                     | Initial query fetch                 | Two `Skeleton` blocks                                                    |
| Empty, can edit             | No row yet, viewer has write access | `ResumeIntake` (`variant="empty"`) — verified live at 375px, no overflow |
| Extracting (QUEUED/RUNNING) | Upload/paste accepted               | Amber progress panel, form stays visible below                           |
| Failed (extraction)         | Terminal `FAILED` status            | Amber warning panel, actionable hint, manual editing open                |
| Ready, has content          | `READY` with non-empty content      | Toolbar + six section cards + **layout panel + PDF preview (new)**       |

---

## Responsive behaviour (all 4 device classes — re-verified live this pass, 320/375/768/1024/1280/1440/1920)

| Class         | Verified widths | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Мобильный** | 320, 375        | **320 has a real horizontal-overflow regression — see §"Findings, #2".** Everything else holds: layout-panel rows keep label + 3× 44×44 icon buttons on one line without wrapping (measured, no overlap, 4px gaps); intake/section buttons still stack full-width; PDF-preview header ("Предпросмотр" + "Скачать PDF") never wraps or clips at 320 — only the body beneath it is empty (see finding #1, not a layout defect at this width specifically). |
| **Планшет**   | 768             | Single-column section flow unchanged. Layout panel switches to the `sm:grid-cols-2` two-column density/font-scale row; icon buttons drop to 32px (`sm:size-8`) as coded. Pre-existing, non-resume-specific issue reproduced again: profile header name truncates to "Olek…" and the "Доска собеседований" button visually sits over the email line — same bug on `Обзор`, out of this feature's scope (flagged in the previous revision, still true).    |
| **Ноутбук**   | 1024, 1280      | Full desktop layout, no overflow at either width (`scrollWidth === clientWidth` verified at both).                                                                                                                                                                                                                                                                                                                                                       |
| **Большой**   | 1440, 1920      | No overflow. Layout panel and PDF preview both scale to the full (uncapped) content column width — same pre-existing "no `max-w` cap on this shell" characteristic already flagged for `Обзор` in the previous revision; not resim-specific, not fixed here.                                                                                                                                                                                             |

**Tab reachability** at ≤1024px for an 8-tab viewer (ADMIN/HR) is unchanged from the previous
finding — horizontally scrollable, no edge-fade affordance, `resume` still the tab most exposed
since it is registered last. Still a follow-up for the shared tab bar, not this feature.

---

## A11y (WCAG 2.2 AA)

Carried-forward guarantees (escaped rendering, safe-URL degrade, keyboard-only reordering, live
regions on the extraction panel, `ring-ring` focus) hold — re-spot-checked, no regressions.

**New this pass:**

- **Target size — layout panel:** all nine interactive controls in the panel (eye/up/down ×6 rows,
  plus Сбросить/Применить) measured live at 320px: the three per-row icon buttons are **exactly
  44×44px** with 4px gaps, none overlapping, the row fits inside its card with margin to spare.
  Passes WCAG 2.2 SC 2.5.8 with room to spare (44 > the 24px minimum).
- **`SegmentedToggle` accessibility** (density, font scale) is inherited from the shared primitive —
  correct `radiogroup`/`radio` roles and an `ariaLabel` prop wired for both instances
  ("Плотность вёрстки", "Размер шрифта"). Not re-audited here (owned by the primitive, not this
  feature) beyond confirming the roles show up in the accessibility tree, which they do.
- **Discoverability gap (icon-only, no title) — MED, not fixed.** The six eye/up/down buttons per
  layout-panel row carry a correct, specific `aria-label` (e.g. `Скрыть «О себе»`,
  `Поднять «О себе»`) but **no `title` attribute**, unlike `ResumeSectionCard`'s "Изменить" button
  in this same file family, which sets `title={...}` for its disabled-hint case
  (`apps/web/app/components/user-profile/resume/ResumeSectionCard.tsx:62-64`). A sighted mouse
  user hovering an icon-only button gets no native tooltip to confirm what it does before clicking
  — the eye icon is conventional enough to guess, the up/down arrows less so out of context. Low
  cost, one-line fix per button (`title={ariaLabelValue}`) — flagged for the coder, not applied
  here (this file is under active concurrent edit on this PR).
- **PDF-preview `<object>`, when it degrades correctly, has an `aria-label`** ("Предпросмотр резюме
  в формате PDF") — but see finding #1: the degrade path itself never paints, so this label is
  currently unreachable by anyone, sighted or not.

---

## Dark/light parity

Spot-checked this pass (not done in the previous revision): both new components toggled between
`.dark` and light (`:root`) at 1920px. No hardcoded colors found in either file — `border-border/60`,
`bg-card/50`, the amber/destructive/primary opacity tokens all repaint correctly in light mode with
adequate contrast. No parity issue found.

---

## Findings from this pass (BLOCKING — not fixed here, flagged for the coder)

This pass is a **fidelity audit against a live branch**, not a polish pass — per the task's explicit
instruction, edits were kept out of the three files the coder is concurrently iterating on for
security/correctness findings on this same PR (`ResumeTab.tsx`, `ResumeLayoutPanel.tsx`,
`ResumePdfPreview.tsx`). All three findings below are precise enough to fix directly.

### 1. HIGH — the PDF preview never renders anything, on any browser or device (functional, not cosmetic)

**Root cause:** `apps/api/src/resumes/resumes.controller.ts:192` sets
`Content-Disposition: attachment` unconditionally on `GET /users/:userId/resume/pdf` (via
`resumeContentDisposition`, `apps/api/src/resumes/resumes.controller.ts:198-219`). This is the
**same endpoint** both the "Скачать PDF" `<a href download>` link and the `<object data={pdfUrl}>`
preview point at
(`apps/web/app/components/user-profile/resume/ResumePdfPreview.tsx:73` and `:81`).
`Content-Disposition: attachment` forces a download on direct navigation/embed in every mainstream
browser — this is not sandbox-specific behaviour, it's how the header is specified to work, and it
is the exact reasoning this codebase already documents for **why** its comparable candidate-resume
preview does NOT embed a direct URL
(`apps/api/src/vacancies/applications.service.ts:551-560`).

**Verified live, not just read from the header:** seeded real resume content through the real API,
let a real Typst render complete (confirmed `renderStatus: READY`, `pdfUpToDate: true`), and the
resulting PDF is genuinely well-built (read directly — one-page A4, correct Cyrillic, brand-styled
section headers). The web UI's `<object>` embed, pointed at that exact URL, painted as an **empty
box with no visible content and no visible fallback message** — `resume-pdf-object`'s fallback
`<div>` exists in the DOM (`fallbackExists: true`, text "Предпросмотр недоступен в этом браузере.
Скачайте PDF.") but never paints (`offsetParent: null`) — worse than the intended graceful
degrade, because there is no signal to the user that anything is wrong. Reproduced identically at
every tested width, 320 through 1920, and in both dark and light mode — this is not a mobile-only
or a narrow-viewport problem, it is the entire feature.

**This is exactly the risk the task brief asked this audit to weigh most heavily**
("Предпросмотр PDF на мобильном... главный риск экрана") — and it turns out to fail everywhere,
not only on mobile.

**Fix path (established in this exact codebase already, not a new pattern):** reuse
`apps/web/app/components/documents/pdf-preview.tsx` (`PdfPreview` — iframe + `<object>`
progressive fallback + 3s timeout state, already battle-tested by `DocumentDetailDialog`) fed by a
blob-fetch hook shaped like `apps/web/app/hooks/use-resume-blob.ts`'s
`useApplicationResumeBlob` (`fetch()` the same `/resume/pdf` URL with credentials, build a
`Blob`/`URL.createObjectURL`, hand _that_ to `PdfPreview` — a Blob URL carries no
`Content-Disposition` at all, which is precisely why the existing pattern works around the same
security-motivated `attachment` header on the candidate-resume endpoint). Do **not** change the
header to `inline` on the shared `/resume/pdf` endpoint without re-checking whether the same
un-authenticated-shared-URL concern documented at `applications.service.ts:557-560` applies here —
a senior's own resume PDF is behind session auth (not a bare presigned URL), so it may not, but
that is the coder/security-reviewer's call, not a design one.

### 2. MED — real horizontal overflow at 320px (toolbar version line)

`apps/web/app/components/user-profile/resume/ResumeTab.tsx:367-374`: the toolbar's
`<span className="inline-flex items-center gap-1.5"><History .../><span className="truncate">Версия N · последним менял {name}</span></span>`
overflows the scrollable content container by ~12px at exactly 320px width when the editor's name
is long enough (verified: `Maksym Yaremenko` triggers it, container `scrollWidth: 332` vs
`clientWidth: 320`; the run also confirmed 375px and up have no overflow, since more room lets the
full string fit). The intended behaviour is truncation with an ellipsis (`truncate` class is
present), but it doesn't fire: the inner `truncate` span is a flex item of the `inline-flex`
wrapper without `min-w-0`, so per the CSS flexbox default (`min-width: auto`) it refuses to shrink
below its content's natural width, and the ellipsis never has room to apply. This is the same class
of bug `min-w-0` fixes everywhere else on this same line's parent (`text-xs text-muted-foreground`
div already has it) — just missing one level deeper, on the inner span. One-line fix:
`className="inline-flex min-w-0 items-center gap-1.5"`.

### 3. LOW — brief stale-content flash right after "Применить"

Clicking `Применить` writes the mutation response straight into the query cache
(`useSaveResumeLayout`'s `onSuccess`, `apps/web/app/hooks/use-senior-resume.ts:59-63`) before the
detached render job the server kicks off in the background has had a chance to flip
`renderStatus`/`pdfUpToDate` — so for roughly one polling interval, the PDF preview panel can
briefly still read as "Ready" (showing the stale, pre-change PDF's empty-box state — see finding
#1) before flipping to "Готовим PDF по шаблону". Cosmetic, self-corrects within ~2.5s (the poll
interval), and is invisible in practice right now only because finding #1 already hides the visual
difference either way. Worth a look once #1 is fixed and the "before/after" is actually visible to
a user watching the transition.

---

## Edge cases (carried forward, unchanged, spot-checked)

No resume yet (editable/read-only), extraction in progress, extraction failed with each documented
failure code, unsafe link scheme degrading to plain text — all re-verified live this pass with no
regressions. New edge case introduced by this pass: **an empty resume's layout panel** still renders
(a senior can pre-arrange section order before any content exists) but the PDF preview correctly
stays hidden entirely until `hasContent` — verified, no "PDF of a blank page" download offered.

---

## Fidelity reference

No Claude Design generation exists for this screen — `design-gate: degraded`, honestly flagged on
PR #497 and unchanged since (Tier 2, conformance-only). This document remains the fidelity
reference: conformance is to `docs/design/foundation.md` (§3 spacing, §5 color semantics, §6 "no
card-in-card, use Separator/divider", §9 a11y, §10 responsive) and to the sibling profile-tab
patterns, re-verified against a live, seeded, real-API run of this exact branch rather than against
a static mockup.

`design-gate: tier-2-conformance` (retroactive, second pass) — `fidelity: degraded` (no `design.png`
artefact exists for this screen; audited against this spec + `foundation.md` + a live cross-browser
functional check instead).

---

## Out-of-scope observations (still true, still not fixed here)

Unchanged from the previous revision, re-confirmed live this pass:

1. Profile header collision at 768px (name truncates, "Доска собеседований" overlaps the email
   line) — reproduced identically on `Обзор`, shared `UserProfileShell.tsx` issue.
2. Content column has no `max-w` cap at 1440/1920 — reproduced identically on `Обзор`'s cards.
3. Tab-bar horizontal-scroll affordance — no visual hint more tabs exist off-screen; `resume`
   remains the tab most exposed since it is registered last.
