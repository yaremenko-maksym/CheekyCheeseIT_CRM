# Interviews — Kanban board (Phase 1, hero surface)

> Per-screen artifact (CRM redesign). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Direction: `docs/design/foundation.md` · Responsive: `.claude/rules/common/responsive-design.md` (hard gate).
> Program: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.

| Field              | Value                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------- |
| Screen             | Interviews — interview kanban board (content inside the new app-shell)                 |
| Route / trigger    | `apps/web/app/routes/_authenticated/interviews/index.tsx` (`InterviewsPage`)           |
| Roles              | ADMIN / HR / SENIOR (see it); JUNIOR — no access; DROP — no (the sidebar hides it)     |
| Claude Design URL  | `https://claude.ai/design/p/e89ba11f-2bd2-46e6-b732-d14b3d69e90e` (content-only)       |
| Status             | `direction-approved` (visuals approved by the owner 2026-06-23 with edits — see below) |
| Last synced commit | `04ffd90b` (base = main with the Phase 0 app-shell)                                    |

## Owner review 2026-06-23 (verdict — takes priority over the CD generation)

The owner looked at the content-only generation (from a phone) — **direction approved** ("looks solid"),
with edits. The verdict takes priority over any CD output:

1. **Column colors — KEEP** (they help orientation; the team gets used to them over time). We do NOT neutralize
   to monochrome. See §"Stage color".
2. **Remove tags and ratings entirely** — they are not in the model (a CD invention), do not draw them.
3. **HR avatar → link to the profile** (`/profile/$hrId`); currently `hrName` is just text.
4. **The call link (`callUrl`) — explicitly clickable** in the reminder zone (not only a small icon).
5. **New interview logic** (a separate feature — see "Related refactor"): reset `callUrl` when
   the stage is moved; a "meeting not scheduled" warning → fill in the date/time + call link
   (Meet/Teams) OR a messenger contact (Telegram/phone); a reminder "took place N days ago".
6. **Future (disabled stubs):** list view; calendar view + Google Calendar integration.

### Related refactor (business logic — IN THE BACKLOG, not now)

**Owner decision (2026-06-23): for now — only the redesign (this file); the logic of items 5–6 → backlog,
to be done much later.** Captured in: `docs/business/backlog.md` §"Собеседования" (reset of `callUrl` when
moved, the "meeting not scheduled" warning, `scheduledAt` + contact method `video|messenger` +
`messengerContact`, relative time, list/calendar view + Google Calendar). When picked up —
the full pipeline (BA→PM→coder/tests/review), not light-track. **This is NOT part of the kanban redesign** — the card
is built on the current model, without new fields.

## Fidelity reference

- The captured REAL screen (functional reference): `assets/kanban/{default,board-mid-pipeline,board-right-columns}.png`
  (taken BEFORE Phase 0 — they show the old app-shell; the **board content** is current, the shell has already been redesigned in Phase 0).
- `design.png` (after generation) — the Mode B fidelity reference.

## Real blocks (1:1 — add/remove NOTHING; restyle the visuals)

Source: `index.tsx` + `components/KanbanColumn.tsx` + `constants.ts`.

### A. Control row (above the board) — `px-6 pt-4`, flex, responsive (`sm:flex-row`)

- **Senior selector** (`<select>`, ONLY ADMIN when seniors>0 / HR): list of seniors by `displayName`. _(The existing native select — could it be switched to our `Select`/`SegmentedToggle`? NO: 1:1 — keep the selection function; bring it to the tokens visually.)_
- **"Профиль" link** (with a senior selected → `/profile/$userId`), muted-underline.
- **"Новая карточка" button** (`Button` size sm, `Plus` icon) — ADMIN/HR/SENIOR (`canCreate`).

### B. Board — horizontal scroll (`overflow-x-auto`), columns `items-stretch h-full`, `gap-3 px-6`

- **6 active columns** (fixed order): HR Screen · English · Tech · Final · Client · Offer.
- **Vertical divider** (`w-px bg-border/60`).
- **3 terminal columns:** Нанят (HIRED) · Отказ (REJECTED) · Архив (ARCHIVED).
- Stage labels — `constants.ts` `STAGE_LABELS` (do NOT change the text).

### C. Column (`KanbanColumn`) — fixed width (~176px `w-44`), `h-full`

- **Header:** stage label + card **counter** (badge). Currently: colored background/text per stage.
- **Card list** (drop zone, dnd-kit sortable). An empty column — an empty body.

### D. Card (`InterviewCard` / `InterviewCardStatic`)

The real model (`InterviewDto`): `companyName · vacancyUrl · callUrl · hrId/hrName · createdAt · stage`.
**There is NO "candidate" field** (outstaff: the senior is the candidate) — do not invent one. Card elements:

- **Company** (`companyName`, bold, truncate).
- **Vacancy link** (`vacancyUrl` → `ExternalLink` icon, clickable, `stopPropagation`).
- **Call link** (`callUrl` → clickable, `stopPropagation`) — verdict: **explicitly clickable** in the reminder zone (not only a small icon).
- **HR** (`hrName`/`hrId`) → verdict: **HR avatar with a link to the profile** `/profile/$hrId` (currently just text — replace with an avatar link).
- **Date** (`createdAt`, `formatDate`).
- Draggable; clicking the card → detail sheet.
- **Do NOT add:** tags, ratings, candidate name (not in the model — a CD invention).

### E. States

- **default** (with cards), **loading** (skeleton columns — `index.tsx` isLoading), **empty column**,
  **teamless SENIOR** (`interviews-teamless-empty-state`: icon + "У вас нет активной команды" + the button "Создать или выбрать команду"),
  **JUNIOR** ("Нет доступа к разделу").

### F. Interactions (behavior 1:1 — do NOT change the logic)

- Dragging a card between columns (dnd-kit, PointerSensor + KeyboardSensor a11y); terminal columns are moved only by ADMIN/HR.
- Clicking a card → `InterviewDetailSheet`. Dragging into "Нанят" (ADMIN/HR) → `CreateProjectFromHiredDialog`. The "Новая карточка" button → `CreateInterviewDialog`. _(The modals are separate Phase 1 artifacts, after the board is approved.)_

## Design direction (restyle per `foundation.md` — for owner approval)

- **Stage color — DECIDED (owner 2026-06-23): KEEP the semantic column colors.** Rationale: colors help orientation, the team gets used to them over time. → We do NOT neutralize to monochrome. The redesign task: bring the palette of the 9 columns to our tokens / `foundation.md` (more harmonious, no "acidity"), keeping the stages distinguishable; active vs terminal distinguishable (terminal ones more muted); the brand yellow remains the CTA/active accent and does not merge with the stage colors.
- Density/typography/spacing — per foundation; counters `tabular-nums`.

## States to generate (artifact)

default (board with cards, ADMIN) · loading (skeleton) · empty column · teamless SENIOR · **mobile** (the board on a narrow screen — column h-scroll/swipe) · tablet.

## A11y / responsive

- **A11y (WCAG 2.2):** keyboard drag (KeyboardSensor exists) — keep; focus visibility on cards/columns; counter/badge contrast; `aria` on drag handles/buttons.
- **Responsive (4 classes, `responsive-design.md`):** mobile (<640) — the board scrolls horizontally, columns of readable width, swipe; the control row wraps; touch targets ≥44px (cards/buttons). Tablet/laptop/large — the board as is, no page overflow (scroll inside the board, not the page).

## Generation brief (Claude Design, system `CheekyCheeseIT CRM`)

Professionally redraw the **interview kanban board** (content inside the ALREADY redesigned app-shell —
a dark operations console, brand yellow used with discipline). Keep blocks A–F 1:1. **Do NOT add**
new columns/buttons/filters. Change ONLY visuals/hierarchy/spacing/density + the **discipline of stage colors**
(see above). States: default/loading/empty/teamless/mobile. Tone: dense·quiet·scannable. Adaptive on
4 device classes. Anti-slop: no 9 screaming colors, no cards-in-cards.
