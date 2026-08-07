# Design spec: Senior resume (Tier 2, retroactive)

**Slug:** `senior-resume`
**Date:** 2026-08-07 (written post-implementation, closing `design-gate: degraded` on PR #497)
**Design tier:** 2 (conformance — built entirely from existing shadcn/ui primitives and the visual
language of the neighbouring profile tabs; no new tokens, no new visual direction)
**Routes affected:** `/profile/:userId?tab=resume`, `/profile?tab=resume` (own profile)
**Design-gate status:** PR #497 shipped with `design-gate: degraded` — no artefact existed before
implementation, honestly flagged by the coder. This document closes that gap: it records the
conformance rules the feature should follow (and does, with two polish fixes applied — see
§"Fidelity findings & fixes applied") so `docs/design/<slug>.md` exists for the Mode B fidelity
gate and for whoever extends this screen next (`task-resume-tailoring`).

---

## Brief

A **canonical, editable CV** for a SENIOR, living as the last tab on the profile card
(`apps/web/app/components/user-profile/UserProfileShell.tsx`). HR (team-scoped) and ADMIN manage
any senior's resume; a SENIOR manages only their own. The flow: upload a PDF/DOCX (or paste text) →
a background extraction turns it into structured content (summary / skills / experience /
education / languages / links) → the person edits that structure in place, section by section →
exports a rendered PDF at any time.

- **Purpose:** turn a messy uploaded document into ONE structured, reusable, editable resume that
  downstream features (`task-resume-tailoring`) can slice per vacancy.
- **Audience:** HR doing this occasionally per senior (batch onboarding, filling gaps before a
  client submission) and a SENIOR doing it rarely for themselves — not a daily-use screen.
- **Tone:** same as the rest of the CRM — dense, quiet, scannable operations tool. This is a form,
  not a resume-builder marketing product; no decorative flourish.
- **Memorable detail:** none by design — Tier 2 conformance explicitly avoids introducing a new
  visual idea. The one deliberate interaction choice (explicit Save per section, not autosave) is
  a **behavioural** decision, not a visual one — see `ResumeTab.tsx` file-header comment for the
  full rationale (autosave would bump `version` on every keystroke, which
  `task-resume-tailoring` uses to detect a stale tailored variant).
- **Constraints:** Tailwind v4 tokens only, shadcn/ui primitives only, Russian UI, WCAG 2.2 AA,
  responsive 320–1920, dark-default with light parity (tokens are theme-agnostic, no manual checks
  needed beyond what shadcn/ui already guarantees).

---

## Reference: existing patterns reused

No new component family. The feature is built entirely from:

- `Card` / `CardHeader` / `CardContent` (`ResumeSectionCard` — one card per resume section, with
  its own Изменить/Сохранить/Отмена, mirroring the section-level edit pattern already used
  elsewhere on the profile card, e.g. `RequisitesTab`).
- `Button`, `Input`, `Textarea`, `Skeleton` — shadcn/ui defaults, no overrides.
- The profile shell's existing tab bar (`AnimatedTabs`-style sliding-pill row) — `resume` is simply
  appended as the last entry; no changes to the tab-bar component itself.
- The profile shell's existing dirty-guard `AlertDialog` (`UserProfileShell.tsx`) — generalised
  from a single `contract`-only boolean to a per-tab map so `resume` gets the same "unsaved
  changes" protection without a second, parallel mechanism.

---

## Token map (from `globals.css`)

| Purpose                                  | Token                                                            |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Section card surface                     | `bg-card` + `border-border` (via `Card`)                         |
| Section card text                        | `text-card-foreground`                                           |
| Secondary text (period, hints, version)  | `text-muted-foreground`                                          |
| Skill / language chips                   | `bg-muted` (skills), `border` (languages)                        |
| Primary action (Скачать PDF)             | `bg-primary` / `text-primary-foreground` (`Button` default)      |
| Progress panel (QUEUED/RUNNING)          | `border-primary/30` + `bg-primary/5`                             |
| Failure panel (FAILED)                   | `border-amber-500/40` + `bg-amber-500/10`, icon `text-amber-500` |
| Links (safe URL)                         | `text-primary` + `underline`                                     |
| Row divider (experience list, view mode) | `divide-border` (fixed in this pass — see below)                 |
| Destructive (remove row/link)            | `text-destructive` (icon-only remove buttons)                    |
| Focus ring                               | `ring-ring` (inherited from shadcn `Button`/`Input`)             |

All tokens are existing project tokens from `apps/web/app/styles/globals.css`. No raw hex, no new
gradient, nothing added to the token system. The amber failure-panel tone (`amber-500/*`) is a
Tailwind utility, not a project semantic token — it matches how the rest of the app signals a
"warning, not blocking" state (distinct from `destructive`, which the codebase reserves for
delete/error-that-blocks). No change proposed here; flagging only so a future token-system pass
knows it exists.

---

## Component structure

```
<div data-testid="resume-tab">                       ← ResumeTab.tsx root
  <ResumeStatusPanel>                                  ← only rendered for QUEUED/RUNNING/FAILED
    <!-- progress: spinner + title + hint, role="status" aria-live="polite" -->
    <!-- failure: AlertTriangle + title + server message + actionable hint + Retry -->
  </ResumeStatusPanel>

  <toolbar>                                            ← version + updatedBy · Скачать PDF · Исходный файл
  <ResumeIntake variant="compact">                     ← shown when showIntake=true OR status=FAILED

  <ResumeSectionCard title="О себе">                   ← Textarea in edit mode, escaped text in view
  <ResumeSectionCard title="Навыки">                   ← Textarea (one per line) ↔ chip list
  <ResumeSectionCard title="Опыт работы">
    <!-- view mode: <ol class="divide-y divide-border"> of ExperienceRow -->
    <!-- edit mode: ResumeExperienceEditor — bordered box per item, ↑↓ reorder + Trash2 remove -->
  <ResumeSectionCard title="Образование">              ← PairListEditor ↔ list
  <ResumeSectionCard title="Языки">                    ← PairListEditor ↔ chip list
  <ResumeSectionCard title="Ссылки">                   ← ResumeLinksEditor ↔ list of safe/degraded links
</div>
```

`ResumeIntake` (`variant="empty"`) replaces the whole tree when there is no content yet and
extraction has not started — see States below.

---

## States

| State                                                     | Trigger                                                                                                       | Visual                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**                                               | Initial query fetch                                                                                           | Two `Skeleton` blocks (`h-24`, `h-40`)                                                                                                                                                 |
| **Query error**                                           | Network/5xx                                                                                                   | Centered muted card, "Не удалось загрузить резюме."                                                                                                                                    |
| **Empty, can edit**                                       | No row yet, viewer has write access                                                                           | `ResumeIntake` (`variant="empty"`): icon + heading + description + "Загрузить файл" / "Вставить текстом", size cap hint                                                                |
| **Empty, read-only**                                      | No row yet, viewer is read-only (e.g. HR out-of-team who somehow reached the tab — in practice gated earlier) | Muted centered text, "Резюме ещё не заполнено." — no upload affordance                                                                                                                 |
| **Extracting (QUEUED)**                                   | Upload/paste accepted, worker not yet picked up row                                                           | Amber-tinted panel, spinner, "Резюме в очереди на распознавание" + "Можно закрыть вкладку…" — form stays visible below, not blocked                                                    |
| **Extracting (RUNNING)**                                  | Worker actively calling the model                                                                             | Same panel, "Распознаём резюме" + "Обычно занимает несколько секунд."                                                                                                                  |
| **Failed**                                                | Terminal `FAILED` status                                                                                      | Amber warning panel with server message + actionable hint (see failure-code table below) + "Загрузить заново"; `ResumeIntake compact` auto-shown below; manual editing fully available |
| **Ready, has content**                                    | `READY` with non-empty content                                                                                | Toolbar (version, Скачать PDF, Исходный файл if present) + six section cards, each view/edit toggled independently                                                                     |
| **Ready, empty content** (manual clear)                   | `READY` but every field empty                                                                                 | Falls back to the empty-state invitation (same as "no row yet") — `hasContent` check in `ResumeTab.tsx` treats this identically                                                        |
| **Section editing**                                       | "Изменить" clicked on one card                                                                                | That card swaps to its editor; Сохранить disabled until dirty; Cancel reverts to last-saved; `beforeunload` + tab-switch guard while dirty                                             |
| **Long content** (many experience items, long skill list) | Realistic senior resume (up to 30 jobs × 20 bullets per `RESUME_LIMITS`)                                      | View-mode experience list uses a **row divider** (`divide-y divide-border`) so entries stay scannable on a narrow column — see fidelity fix below                                      |

### Failure-code → copy (already implemented, documented here for completeness)

| Code                 | Hint shown                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `NO_TEXT`            | Scanned/image PDF — suggests pasting text instead                                           |
| `UNREADABLE_FILE`    | File could not be parsed — suggests another file or paste                                   |
| `MODEL_INVALID_JSON` | Model failed twice — suggests manual fill, form works                                       |
| `QUOTA_EXCEEDED`     | Names the exact reset time (`formatResetTime`, `ru-RU` locale) — manual fill still works    |
| `AI_NOT_CONFIGURED`  | Adds that manual fill is IDENTICAL in outcome (same sections, same PDF) — not a lesser path |
| `STALLED`            | Swept by cron after a container restart — suggests re-upload or manual fill                 |
| default              | Generic "fill manually or re-upload"                                                        |

None of these read as "Что-то пошло не так" — each names what happened and what to do next, per
the task's hard requirement.

---

## Responsive behaviour (all 4 device classes — verified live, not just in code)

| Class         | Verified widths | Behaviour                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Мобильный** | 320, 375        | Single column; toolbar (version/PDF/source) wraps to column (`flex-col sm:flex-row`); intake buttons stack full-width (`min-h-11`); section Изменить/Сохранить/Отмена stack full-width; experience editor rows are bordered boxes with 44×44 reorder/remove buttons; no horizontal page overflow (`scrollWidth === clientWidth` verified at both widths) |
| **Планшет**   | 768             | Same single-column section flow (the profile content column does not go multi-column at this width for ANY tab, resume included — consistent with e.g. `Обзор`); toolbar buttons sit side by side                                                                                                                                                        |
| **Ноутбук**   | 1024, 1280      | Full desktop layout; section header actions ("Изменить") show icon + label (mobile hides the label, icon-only, via `hidden sm:inline`)                                                                                                                                                                                                                   |
| **Большой**   | 1440, 1920      | Content column does not gain a `max-w` cap in THIS pass — confirmed the same is true of every other profile tab (`Обзор` checked side-by-side); not a resume-specific regression, out of this PR's narrow scope, flagged below for a future shared-layout pass                                                                                           |

**Reachability of the "Резюме" tab itself:** for a viewer with many tabs (ADMIN/HR — 8 tabs
total), the tab bar overflows its container at ≤1024px and is NOT visible without scrolling — but
it IS horizontally scrollable (`overflow-x-auto` wrapper one level up from the sliding-pill
`overflow-hidden` clip box) and reachable by swipe/scroll; verified by scripted `scrollLeft` and by
screenshot. There is no visible affordance (edge fade / partial-tab peek) hinting that more tabs
exist off-screen. **This is pre-existing shared tab-bar behaviour** (reproduced identically on the
`Обзор` tab, unrelated to the resume feature) — not caused by this PR, out of its narrow scope to
fix, but worth a follow-up task on the shared tab bar since `resume`, being registered last, is
now the tab most likely to be affected. A SENIOR's own profile (3 tabs: Обзор/Реквизиты/Резюме)
never hits this — verified, no scroll needed.

---

## A11y (WCAG 2.2 AA)

- **Target size:** every actionable control in the feature is ≥44×44px on mobile — verified
  empirically (reorder ↑/↓, remove, upload/paste toggle, save/cancel, edit). One control
  (`resume-retry-upload`, the "Загрузить заново" button on the failure panel) shipped at 32px
  (`size="sm"` with no `min-h-11` override) — **fixed in this pass**, see below.
- **Live regions:** both the progress and failure panels use `role="status" aria-live="polite"` —
  a screen-reader user is told when extraction starts/finishes/fails without focus being stolen.
- **Icon-only buttons:** every icon-only control (reorder, remove, "Изменить" on mobile) carries an
  explicit `aria-label` naming the exact row/section ("Переместить место работы 2 вниз", "Удалить
  ссылку 3") — not a generic "Delete"/"Move".
- **Untrusted content is never interpreted:** resume text is rendered as plain escaped text
  (`whitespace-pre-wrap`, never `dangerouslySetInnerHTML`); an unsafe link scheme degrades to plain
  text client-side (`isSafeResumeUrl`) in addition to the server-side rejection — belt and braces
  for XSS via resume content, which is explicitly untrusted (uploaded file → external model output).
- **Keyboard operability:** experience reordering uses buttons, not drag-and-drop — reachable and
  operable by keyboard/screen-reader with no parallel implementation needed (deliberate choice,
  see `ResumeExperienceEditor.tsx` file header — also sidesteps the exact class of flake that hit
  the interviews kanban, #290).
- **Focus:** all inputs/buttons use shadcn defaults (`ring-ring` on focus) — no custom overrides
  that could suppress the indicator.

---

## Fidelity findings & fixes applied (this pass)

Two concrete gaps found against the conformance rules above, both narrow, both fixed directly
(cosmetic-only, `apps/web/**`, no business logic touched):

1. **Experience list (view mode) had no landmark between jobs on mobile.** A senior's real resume
   easily reaches 6–8 jobs with 3–5 bullets each (limits allow up to 30×20). The view-mode `<ol>`
   used flat `space-y-3` with no divider — on a narrow column this reads as one undifferentiated
   ribbon of bullet points; you cannot tell where "EduBridge" ends and "DevCraft Studio" begins
   without reading closely. The **edit-mode** editor already solved this (bordered box per item);
   the read-mode did not. Fixed by adding `divide-y divide-border` to the list and `py-3
first:pt-0 last:pb-0` to each row — a `Separator`-style rule between entries, which is the
   pattern `foundation.md` §6 itself prescribes ("вложенность — секциями/разделителями, не
   двойными бордерами") rather than introducing a bordered card-per-item (which would have been a
   card-in-card against the same rule).
   — `apps/web/app/components/user-profile/resume/ResumeTab.tsx` (the `<ol>` at the "Опыт работы"
   section + the `ExperienceRow` helper).

2. **"Загрузить заново" retry button was 32px tall on mobile**, the one interactive control in the
   whole feature that missed the `min-h-11` convention every sibling button follows. Fixed by
   adding `min-h-11` to its className.
   — `apps/web/app/components/user-profile/resume/ResumeStatusPanel.tsx`.

Both verified live (before/after screenshots, dimensions read via `getBoundingClientRect`) at
375px. Neither touches business logic, RBAC, or test ids — `mcp__eslint__lint-files` clean on both
files.

---

## Edge cases (verified live, not just read from code)

| Case                                                       | Handling                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No resume yet, viewer can edit                             | Empty-state invitation with both intake paths                                                                                                                   |
| No resume yet, viewer read-only                            | Muted "Резюме ещё не заполнено." — no upload affordance shown                                                                                                   |
| Extraction in progress                                     | Screen never blocks; all six sections stay visible and editable while `QUEUED`/`RUNNING` (verified: form is fully present under the progress panel, not hidden) |
| Extraction failed — quota exhausted                        | Reset time named in local time (`ru-RU` locale, day+month+HH:MM); manual editing fully open below                                                               |
| Very long resume (8 jobs, 30 skills, 3 languages, 3 links) | No horizontal overflow at any tested width (320–1920); vertical scroll only; experience entries now divided (fixed)                                             |
| Reordering experience items                                | ↑/↓ buttons; boundary buttons correctly `disabled` at position 1/last; verified an actual swap (position 2 ↔ 3) via DOM state, not just visual                  |
| Unsafe link scheme in a saved link                         | Degrades to plain (non-clickable) text, both in the UI and never interpreted in the PDF                                                                         |
| PDF export with Cyrillic + long content                    | Two-page PDF, embedded font renders Cyrillic correctly, paginates cleanly, section headers in brand-yellow uppercase, footer "CheekyCheeseIT CRM"               |
| Own-profile SELF view (SENIOR)                             | Only 3 tabs total (Обзор/Реквизиты/Резюме) — "Резюме" is always directly visible, no scroll/reachability concern at any width                                   |

---

## Fidelity reference

No Claude Design generation exists for this screen (`design-gate: degraded`, honestly flagged by
the coder — see PR #497 body). This document is the fidelity reference going forward: conformance
is to `docs/design/foundation.md` (§3 spacing rhythm, §5 color semantics, §6 elevation/depth "no
card-in-card, use Separator/divider", §9 a11y, §10 responsive) and to the sibling profile-tab
patterns (`RequisitesTab`, `ContractTab`) rather than to a pixel reference image.

`design-gate: tier-2-conformance` (retroactive) — no `design.png` artefact; Mode B fidelity checked
against this spec + `foundation.md` + live cross-tab comparison (`Обзор`) for shared-chrome parity.

---

## Out-of-scope observations (not fixed here — narrow PR, shared blast radius)

Recorded for a follow-up task, not blocking this PR:

1. **Profile header collision at 768px** (name truncates to "Olek…", "Доска собеседований" button
   overlaps the email line). Reproduced identically on the `Обзор` tab — pre-existing shared
   `UserProfileShell.tsx` header layout bug, unrelated to the resume feature.
2. **Content column has no `max-w` cap at 1440/1920** (long prose lines run the full available
   width). Reproduced identically on `Обзор`'s cards — a shared profile-shell layout characteristic,
   not something to fix inside `ResumeTab.tsx` alone without creating inconsistency across tabs.
3. **Tab-bar scroll affordance** — horizontally scrollable but with no visual hint that more tabs
   exist off-screen when the active tab is off-screen-right. Shared tab-bar behaviour; `resume`
   being last makes it the tab most exposed to this, but the fix belongs in the shared component.
