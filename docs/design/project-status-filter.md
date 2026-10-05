# Project status filter in the projects list — design spec

**Design tier:** 2 (edit of an existing screen)
**Screen:** `/projects` (list), affects `ProjectRow` (row card)
**Business context source:** `docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md`
§3–4, §6 — **read in full**; the owner's decisions below are not revisited, they are translated into
concrete layout.
**References (current screen, before the change):** `docs/design/assets/project-status-filter/current-*.png`
(320¹/375/768/1024/1440 — see §4)
**Theme:** dark only (`apps/web/index.html` is hard-coded `class="dark"`) — I do not design or
check a light theme, see `.claude/rules/common/design-gate.md`.

¹ The screenshot was taken at 375 (the minimum testable mobile viewport in this session); 320 is described
in text in §4 on the same principles — check both during layout.

---

## 0. What is already on the screen (important for the §3 decision)

I read `apps/web/app/routes/_authenticated/projects/index.tsx` and
`apps/web/app/components/projects/ProjectRow.tsx` in full, not from memory. Three facts determine
the entire design that follows:

1. **`/projects` is already RBAC-fenced** (`useRoleGuard(['ADMIN','SENIOR','HR','ACCOUNTANT','JUNIOR'])`
   — in the list and on the detail page). **`DROP` does not reach this screen at all.** So
   project confirmation by the drop (§4 of the business spec: «the project is confirmed by both — the senior and the drop») lives
   **not on this screen** — it is a separate task (probably a «what is expected of me» screen, §8.3 of the
   business spec, Tier 1). This spec covers only the ADMIN and SENIOR side of the list.
2. **The page already has a state switch** — `SegmentedToggle` in `variant="tabs"` mode,
   ADMIN-only, three values `Все | Активные | Архив` (`currentTab: StatusTab`). This is a READY slot
   for the new filter — there is no need to invent a new place on the screen.
3. **The row list is not a card grid, it is a line-by-line list** (`ProjectRow`, column grid
   `3fr 1.4fr 1.4fr 1.2fr 1fr`: project info | senior | junior | rate/date | status badges). The right
   column already carries conditional badge logic (domain OR «В архиве») — this is the place where the
   new status gets embedded.

---

## 1. Brief

A project now starts its life as a **draft** and becomes live only after confirmation by the
senior (and, on a separate screen — by the drop, outside this spec). The project list gets a **filter by
confirmation status** — a new dimension, orthogonal to the existing archived state
(«archived state remains a separate dimension», §4.2 of the business spec — do not mix «not confirmed» and
«finished»).

Three values (verbatim from the assignment):

- **Active** — the default; exactly what all roles see today.
- **Awaiting confirmation** — drafts; seen by ADMIN (all) and the confirming SENIOR (only their own).
- **Rejected** — seen only by ADMIN, with the rejection reason, until manual cleanup.

---

## 2. Decision: the filter replaces the existing three-way tab, rather than being added next to it

**What I do.** The existing `SegmentedToggle` `Все | Активные | Архив` becomes
`Активные | Ожидают подтверждения | Отклонённые | Архив` (for ADMIN) /
`Активные | Ожидают подтверждения` (for SENIOR) / fully hidden (for HR/ACCOUNTANT/JUNIOR —
as today).

**Why not a second, separate switch next to it.** Two tab bars on one screen, one of
which also contains an «Активные» item with a DIFFERENT scope, is confusion out of nowhere: the user
cannot tell which of the two «Активные» tabs is in front of them now. One list — one
switch; this is the literal reading of the owner's «a filter in the existing list, not a
separate section» (§6 of the business spec) — there is one section, and the controlling element must also be one.

**Why the «Все» tab goes away.** «Все» today means «active + archived together» — exactly the
mixing of facts about a project that the business spec explicitly forbids extending to the new axis
(«do not mix `not confirmed` and `finished`», §4.2). We would now have to mix THREE facts
(confirmed / archived / rejected), and the result is unreadable. Explicit tabs beat one murky one.

**Why «Архив» stays as the 4th tab rather than a separate control.** Only a
previously ACTIVE project can become archived (a draft cannot be archived, a rejected one is not archived either, it just
sits there with the reason). So «Архив» does not overlap in meaning with the two new states and calmly
stays as is — it just shifts to the 4th position.

**Status — A1 (decision recorded, not escalated).** Reversible within one PR (it is a
client-side UI choice, not a migration and not money), does not touch RBAC by itself (it only reflects the already
existing owner RBAC model from the business spec), not published externally. If the owner's review
decides otherwise — the fix is trivial (bring back «Все» as a fifth tab).

### Visibility by role (from §0.1 + business spec §3, §7.2)

| Role                     | Tabs                                                   | Scope of «Ожидают подтверждения»                         |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------- |
| ADMIN                    | Активные · Ожидают подтверждения · Отклонённые · Архив | All drafts, regardless of who is confirming              |
| SENIOR                   | Активные · Ожидают подтверждения                       | Only those where the confirmer is this SENIOR themselves |
| HR / ACCOUNTANT / JUNIOR | no tabs (as today)                                     | —                                                        |
| DROP                     | screen unavailable (see §0.1)                          | —                                                        |

The `SegmentedToggle` component is rendered conditionally on `isAdmin || isSenior` (an extension of today's
`isAdmin &&`); the option list is built by role, not hard-coded.

### Type and parameter (for Coder — a guideline, not an implementation mandate)

```ts
type ProjectStatusFilter = 'ACTIVE' | 'PENDING' | 'REJECTED' | 'ARCHIVED'
```

Recommendation: replace today's `projectsSearchSchema = z.object({ archived: z.coerce.boolean().optional() })`
with `z.object({ status: z.enum(['ACTIVE','PENDING','REJECTED','ARCHIVED']).optional() })`, on the same
principle by which `archived=true` lives in the URL today (the deep link to «Архив» already works that way) —
an ADMIN must be able to send a colleague a direct link to the «Ожидают подтверждения» queue. `ACTIVE` is the
default, not shown in the URL (as today). Migrating the old `?archived=true` to `?status=ARCHIVED`
is a technical decision for the Coder, not a design question; the risk is low (an internal tool, there are no external
bookmarks on `?archived=`).

Switching a tab keeps hitting the backend again (like today's `archivedQuery`), with the same
`keepPreviousData` + `useTransition`, so that the gold pill animation of `SegmentedToggle` is not torn
mid-render (this is already documented behavior in the code, ut-32/ut-44 — it is just extended
to the new axis, not reinvented).

**No counters on the tabs.** In `vacancies/index.tsx` the tab filter shows a counter (`Черновики 3`)
— but there the whole list arrives in ONE request and is counted on the client. Here the backend already serves EACH
tab by a separate request (the RBAC scope differs for ADMIN/SENIOR) — a counter on an unselected
tab would require a separate aggregating endpoint. Not in this Tier-2 edit; today's
`Активные | Архив` have no counters either — consistency matters more.

---

## 3. Token map (only existing tokens/patterns, nothing new is added)

Nothing in `apps/web/app/styles/globals.css` is extended — all coloring is taken from the convention already
established in the codebase, «semantic status = Tailwind palette on top of our
CSS variables», not from brand tokens (`--primary` stays the yellow CTA/accent, not a status).

| Purpose                                | Classes                                                                   | Precedent in code                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| «Ждёт подтверждения» badge (amber)     | `border-amber-500/30 bg-amber-500/20 text-amber-300`                      | `document-status-badge.tsx` (`tone: 'amber'`, receipt/pending)                                       |
| Draft indicator dot (amber)            | `bg-amber-500`                                                            | Analogue of `bg-emerald-500` (active dot) in `ProjectRow.tsx:91`                                     |
| «Отклонено» badge (destructive, muted) | `border-destructive/30 bg-destructive/10 text-destructive`                | `TransactionRow.tsx` `DeletedBadge` (`border-destructive/40 bg-destructive/10`)                      |
| Rejection reason text                  | `text-destructive` (not `text-red-*` — a token, not the palette directly) | `TransactionDetailDialog.tsx:219`, `TransactionRow.tsx:667` (`tx.rejectionReason`)                   |
| Rejected indicator dot (muted)         | `bg-destructive/60`                                                       | New, but the same logic as `bg-muted-foreground/40` for archive in `ProjectRow.tsx:91`               |
| Dimming of a rejected/archived row     | `opacity-60 hover:opacity-80` on the row                                  | `ProjectRow.tsx:69` (`isArchived && 'opacity-60 ...'`) — extended to REJECTED                        |
| Draft row accent (NOT dimming)         | `ring-1 ring-amber-500/20` on the row card                                | `invoice-card.tsx:110` (`awaitingViewerSignature && 'border-amber-500/50 ring-1 ring-amber-500/20'`) |
| Active «Отклонённые» tab in the tabs   | `activeVariant: 'destructive'` (`SegmentedToggle` prop)                   | `CandidateCard.tsx:49` (the `REJECTED` item of the same toggle)                                      |
| «Waiting» icon                         | `Clock` (lucide-react)                                                    | `invoice-card.tsx` (PENDING invoice status)                                                          |
| «Rejected» icon                        | `XCircle` (lucide-react)                                                  | New choice (no direct precedent) — standard semantics, present in `lucide-react@1.14`                |
| Radii, typography, spacing             | unchanged (`rounded-md`, micro-scale `text-[10px]/[11px]/text-xs`)        | `ProjectRow.tsx` as a whole — new elements must land in the same scale                               |

**Nothing new is needed in `@theme inline`.** Amber/emerald/destructive is the status palette already used on
this same page (and in the document/invoice/finance domains); introducing a new CSS custom
property for «confirmation status» would duplicate the existing vocabulary.

---

## 4. Components

### Existing (reused as is)

- `SegmentedToggle` (`@/components/ui/segmented-toggle`) — the component itself **does not change**, only
  the option list and the render condition change. It already supports everything needed: `role="tablist"`/`role="tab"`,
  `aria-selected`, `activeVariant: 'destructive'`, `testId` suffixes, per-option `disabled`.
- `Badge` (`@/components/ui/badge`) — `variant="outline"` + custom `className` (the same pattern
  that already yields the «В архиве» badge in `ProjectRow.tsx`).
- `Card` / `CardContent` (empty state, error) — reused 1:1 with the existing `admin-kpi-error`
  pattern (`routes/_authenticated/index.tsx:158-165`).
- `Skeleton` — the loading state, already used on this same page, does not change.

### New (minimal, justified)

1. **`ProjectRow` — extension of status branching** (not a new component, an edit of an existing one).
   Today the «Status / badges column» block (`ProjectRow.tsx:232-254`) is a binary
   `isArchived ? <Badge В архиве> : <Badge domain>`. It becomes a 4-way branch on `project.status` +
   `project.archivedAt` (see §7). Rationale for «why not a new component»: the logic is the same conditional badge pattern
   that is already there; growing it into a separate file would create indirection without
   benefit (deletion test: delete `ProjectStatusBadge.tsx` and inline it back — nothing breaks,
   so extracting is premature).
2. **`STATUS_FILTER_LABELS` / `STATUS_FILTER_LABELS_MOBILE`** (constants in `constants.ts`, next to
   `PAYMENT_TYPE_LABELS`) — the same structure, the same file, the same principle of «one source of the RU string».
3. **An `sr-only` region announcing the filter** — not a separate component, three lines of JSX (see §8).

**Explicitly NOT introduced:** a separate `ProjectStatusFilterSelect` (a mobile `<Select>`). Rationale — §5.

---

## 5. Responsive (320/375 · 768 · 1024/1280 · 1440/1920)

### Key decision: a switch (tabs), not a dropdown — on ALL device classes

**Rationale.** The same page family (`vacancies/index.tsx`) already has an IDENTICAL solved
problem: a 4-option tab status filter that does not fit in width at <640px with full
Russian labels (documented right in the code: «4 full-length labels... collide at <640px,
confirmed live»). The solution is already verified live and merged: **two `SegmentedToggle` instances with
different option sets, switched by CSS classes (on `/vacancies` — `sm:hidden` / `hidden ... sm:grid`;
here after implementation — `lg:hidden` / `hidden lg:grid`, see the revision below)** — not a change of
component (tab → select), but a change of **label length**. I reuse the same solution instead of inventing
a third option:

- It saves a decision (no need to design the behavior of a new control type — focus/keyboard/scroll
  inside `<Select>` already work somehow, but that is a different set of a11y patterns).
- The user has already seen this mechanism on `/vacancies` — a switch that on a phone is merely
  labeled slightly shorter is more predictable than «on one screen the filter is a tab, on another a dropdown».
- 24×24 CSS px (WCAG SC 2.5.8) — a tab with `text-xs` text inside a `rounded-md` button of size `sm`
  (`px-2 py-1`) technically passes even today; but below (§8) — why that is insufficient for mobile
  and what is added.

### Labels (full / abbreviated — modeled on `vacancies/index.tsx`)

| Value    | Laptop and larger (`lg:`, ≥1024px) | Mobile and tablet (`<lg`, <1024px) |
| -------- | ---------------------------------- | ---------------------------------- |
| ACTIVE   | Активные                           | Идут                               |
| PENDING  | На подтверждении                   | Ждут                               |
| REJECTED | Отклонённые                        | Отказ                              |
| ARCHIVED | Архив                              | Архив                              |

**Revision 2026-09-07 (UX-L-5(r7), after implementation).** The table is brought in line with what shipped, not with the
original intent: (1) the boundary of full labels moved from `sm:` (640) to `lg:` (1024) — three CI rounds
showed that under Linux font metrics the full labels wrap at 768–1023 (COPY-M-13), and
`responsive-design.md` treats 640–1023 as one «tablet» class, so the boundary coincides with the device
class; (2) the short set is the one-word family `Идут`/`Ждут`/`Отказ`/`Архив` instead of the abbreviations
`Ожид.`/`Откл.` (they differed by one letter, «Откл.» reads as «disabled» — see the comment in
`constants.ts`); (3) the full PENDING label is `На подтверждении` (a divergence from the «Ждёт решения» badge —
backlog 168).

### Per-class behavior

- **320/375 (mobile).** The sidebar already collapses into a hamburger (existing behavior, not touched).
  The tab switch is a `SegmentedToggle` with abbreviated labels, `w-full` (stretches to the full
  content width, like today's three-way tab in the screenshot). Touch target — see §8 (44px minimum,
  today's `size="sm"` tool does NOT provide this «out of the box», it is added explicitly).
  **Known existing limitation (not in scope of this change, recorded so it does not look like
  a regression from it):** `current-375.png` shows that the `ProjectRow` itself (a 5-column
  grid) at 320-375 already collapses today with overlapping text («СИНЬОРДЖУН» on top of each other). The new
  status badge is embedded in THE SAME right column following the same pattern as today's «В архиве»
  — it cannot be worse than the already existing squeeze, but it does not fix it either. That is a separate, larger
  task (re-lay out `ProjectRow` as a mobile card stack) — outside the Tier-2 filter.
- **768 (tablet).** Short labels, as on mobile (`<lg`): the full ones at 768–1023 wrapped under
  Linux font metrics in CI (COPY-M-13; not reproducible on macOS — the source of truth for font
  metrics is CI). Forced 44px height does not apply here (see «Touch targets»).
- **1024/1280 (laptop) and 1440/1920 (large).** No change in layout — the tab bar is already where it is
  today, just with 4 (ADMIN) or 2 (SENIOR) items instead of 3.

### Touch targets

`SegmentedToggle` `size="sm"` gives `px-2 py-1 text-xs` — the actual button height, judging by the
screenshots, is noticeably below 44px (the mobile minimum per `responsive-design.md`, stricter than the WCAG minimum
of 24px). For the `<lg` instance (`lg:hidden`) we add `className="[&>button]:max-[639px]:min-h-11"` (44px only
below 640px; on tablet 640–1023 the same instance without forced height)
to the container (a Tailwind arbitrary-child-selector, without editing `SegmentedToggle` itself) — it raises
each button to 44px in height without touching the desktop instance. This is the same class of problem that
`vacancies-status-filter-mobile` had — if it is not added there either, the same fix should be applied there in one
line (outside the scope of this task, but worth noting in the backlog in one line for the Coder review).

---

## 6. States

### Empty

| Tab                   | Who sees | Text                                                | Icon (muted, `text-muted-foreground/30`) |
| --------------------- | -------- | --------------------------------------------------- | ---------------------------------------- |
| Активные (unchanged)  | everyone | «Проектов пока нет» (current text, does not change) | `Briefcase`                              |
| Ожидают подтверждения | ADMIN    | «Черновиков нет»                                    | `Clock`                                  |
| Ожидают подтверждения | SENIOR   | «Нет проектов, ожидающих вашего решения»            | `Clock`                                  |
| Отклонённые           | ADMIN    | «Отклонённых проектов нет»                          | `XCircle`                                |
| Архив (unchanged)     | ADMIN    | «Архив пуст» (current text)                         | `Briefcase`                              |

Structure — 1:1 with the existing empty state (`ProjectsPage`, lines 497-514): `flex flex-col
items-center justify-center rounded-xl border border-dashed border-border py-24 text-center`, with no
new component, just text/icon parameterized by `currentTab`.

### Loading

Unchanged — the existing block `Skeleton` (5 rows `h-19`) is equally correct for any
tab; switching a tab already passes through `isLoading` thanks to `keepPreviousData` (smoothly,
without flashing into the skeleton when the list is already rendered — existing behavior).

### Error

Today the page does not handle it explicitly (`useQuery` only reads `isLoading`). A branch is added
modeled on `routes/_authenticated/index.tsx:158-165` (the admin KPI block, the same `useQuery` pattern):

```
<Card>
  <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
    <p className="text-sm text-destructive">Не удалось загрузить проекты</p>
    <p className="text-xs text-muted-foreground">Обновите страницу или попробуйте позже</p>
  </CardContent>
</Card>
```

Placement — in the same place where the list/empty state is rendered today (after the `isError` check, before the
`filtered.length === 0` check).

### Long project name / long confirmer name

- **Project/company name** — already `truncate` on the parent `min-w-0` container (`ProjectRow.tsx:85-108`,
  verified in code) — overflow is already handled, nothing new needs to be done, just do not break it
  when adding the badge on the right (the right column is not flexible, `1fr`, no conflict).
- **The confirmer name in the «ждёт подтверждения: имя» pill** — NEW text, overflow handling
  is required separately (see §7): `truncate` + `title={fullText}` — the same pattern that is already
  used for `tx.rejectionReason` in `TransactionRow.tsx:664-670` (CSS truncation + the full
  text on hover/focus via the native `title`). The maximum column width is `1fr` in the grid
  (the same constraint as the domain badge today), the content inside — `max-w-full truncate`.

---

## 7. The «ждёт подтверждения: имя» pill on the card — look and place

**Place.** The same right column of `ProjectRow` that today carries the domain/archive badge
(`ProjectRow.tsx:232-254`, `flex flex-col items-end gap-1`) — no new column, no grid shift.
A draft **opens with the same card as an active one** (literally a requirement of §6 of the business
spec) — which means the entire rest of the row (logo, name, senior, junior, rate/date) renders
UNCHANGED, only the right column changes.

**Look (top to bottom inside the same column):**

```
┌───────────────────────────┐
│  ⏱ Ждёт подтверждения      │   ← Badge, variant="outline", amber (§3)
│  от Олексій Коваленко      │   ← caption, text-[11px] text-amber-300/80,
│                             │      truncate + title = full name(s)
└───────────────────────────┘
```

- The badge is `<Badge variant="outline" className="border-amber-500/30 bg-amber-500/20 text-amber-300 text-[10px]">`
  with a `Clock` icon (`h-3 w-3 mr-1`, the same icon-in-badge pattern as `invoice-card.tsx`), text
  «Ждёт подтверждения» — it replaces today's domain badge on this tab (the project domain carries no
  value until the project is confirmed, and the space in the column is limited).
- The caption under the badge — `от {name}` with a single pending confirmation. **Several pending
  confirmations at once (per business spec §4.1, «one proposal — several rows, one row
  per confirmer») physically do not occur on THIS screen** — SENIOR here sees only rows where the
  confirmer = themselves (§0.1: DROP does not enter this screen), which means from SENIOR's point of view there is always
  exactly one «waiter» — themselves, and the text can be omitted entirely (a badge without a caption in the SENIOR scope
  is redundant). For **ADMIN**, who sees OTHERS' drafts, the caption shows whose decision we are waiting for:
  «от {senior's name}» — if only the senior is awaited; if by the data both the
  senior and the drop are missing at once — «от {senior's name} и дропа» (the drop is nameless on this screen by design, since
  the DROP entity itself does not meaningfully scale here — the card is not about DROP details). The exact form
  depends on what the API actually returns (see the assumption in §9) — the Coder clarifies based on the actual response shape.
- The indicator dot next to the project name (today `bg-emerald-500`/`bg-muted-foreground/40`) —
  a third value `bg-amber-500` is added for `status === 'DRAFT'`.
- The row is **NOT dimmed** (`opacity-60`, like archived/rejected) — a draft needs attention
  right now, muting it would be wrong in meaning. Instead — a thin accent around the whole card:
  `ring-1 ring-amber-500/20` on the row's outer `div` (the same device as `invoice-card.tsx:110` for
  «your signature is awaited» — already proven, not new).

---

## 8. Rejection reason on a rejected project

The same principle that already works for `tx.rejectionReason` in finance (`TransactionRow.tsx:661-670`)
— the reason is visible **right in the list row**, without opening the card, because the goal is to «remove
disagreements», and a reason hidden behind a click works worse than an open one.

```
┌───────────────────────────┐
│  ✕ Отклонено                │   ← Badge, variant="outline", destructive (§3)
│  «нет бюджета на Q3»       │   ← reason, text-[11px] text-destructive/90,
│                             │      truncate + title = full text
└───────────────────────────┘
```

- The badge is `<Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive text-[10px]">`,
  icon `XCircle`, text «Отклонено» — it replaces the domain badge, similarly to §7.
- The reason is plain text under the badge, `truncate` to the column width + `title={reason}` (the full text
  on hover — the `TransactionRow.tsx:666-669` pattern).
- The indicator dot is `bg-destructive/60` (muted, distinguishable from the archived `bg-muted-foreground/40`
  and from the active `bg-emerald-500` by hue and by the neighboring text, not only by color — see §9 on
  1.4.1).
- The row is **dimmed** (`opacity-60 hover:opacity-80`) — the same class as the archived row today
  (`ProjectRow.tsx:69`): a rejected project is a historical state awaiting manual cleanup
  by the admin, not an element active for action (unlike a draft).
- **The «propose again» action is outside this spec.** The business spec (§3.3) explicitly gives the admin
  the ability to propose again after a rejection — but by the convention of this screen ALL actions live
  on the project detail page, not on the list row («ut-27 + ut-38: archive/unarchive... live on the
  project detail page header», right in the code of `ProjectsPage`, the comment at the end of the file). The row is
  indication only; a click on it (as today) leads to `$projectId`, where this action should
  appear — a separate Tier 1/2 task for the detail page, not part of this one.

---

## 9. Assumptions (A1, recorded, not escalated)

**The foundation of confirmations is already merged** (`feat(approvals): confirmations foundation — one record per
approver`, PR #624, position 3 of the business spec plan) — verified by reading
`packages/shared/src/schemas/approvals.ts` and `apps/api/src/approvals/approvals.service.ts` directly,
not from memory of the spec. Below are assumptions grounded in this real code, not invented:

- **The `Approval` row carries no name and role** — only `approverUserId: string (uuid)`,
  `status: 'PENDING'|'APPROVED'|'REJECTED'`, `rejectionReason: string|null`, `subjectType`,
  `subjectId`. So the «от {name}» caption (§7) at the stage of plan positions 4/5 will require a JOIN
  `approverUserId → users.displayName` — this spec does not decide that (not its layer), it only
  records that the `ProjectRow` column is designed for a ready name in the DTO, not for a raw uuid.
  The confirmer's role (SENIOR vs DROP) is also not stored on the `Approval` row itself
  (`subjectType`/`subjectId` are only about WHAT is being confirmed, not about the confirmer's role) —
  deriving the role (for the «от синьора» vs «и дропа» wording, §7) will fall to matching
  `approverUserId` against `project.seniorId`/`project.dropId` when assembling the DTO.
- **The aggregate status is already precomputed** — `ApprovalsService.getStatus()` returns
  `'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'` (partial agreement = `PENDING`, «one rejection
  voids everything» = `REJECTED`). This is a ready basis for `project.status`, which this spec
  assumes as `'DRAFT' | 'ACTIVE' | 'REJECTED'` — the likely mapping:
  `NONE|PENDING → DRAFT`, `APPROVED → ACTIVE`, `REJECTED → REJECTED`. The exact name/shape of the field on
  `ProjectDto` is the Coder's decision when implementing plan position 4 («Project draft: status,
  representation, guard»), not this spec's.
- **`listPendingForApprover(approverUserId)`** already exists and returns ALL pending rows
  of the confirmer for ANY `subjectType` (not only projects) — exactly the method by which for the
  SENIOR scope of the «Ожидают подтверждения» tab it is natural to filter `subjectType='PROJECT'`
  (the `subjectType` value, judging by the code, is not yet reserved by any module — it is introduced by
  whoever implements position 4, also outside this spec).
- **`project.rejectionReason`** — from §4.2 of the business spec («an explicit field… the rejection reason»); at the
  `Approval` row level the reason already exists (`rejectionReason` on the SPECIFIC rejecting row) — which
  of the two fields is projected into `ProjectDto.rejectionReason` (raw from `Approval` or
  a denormalized copy on the project) is again an implementation decision, not a design question: the layout of
  §8 expects a single line of text, wherever it comes from.
- **Replacing `?archived=` with `?status=` in the URL schema** — a technical decision, not a design requirement;
  the alternative (keeping `archived` as a boolean parameter next to the new `status`) is also acceptable if
  the Coder deems the schema migration risky for existing links.

---

## 10. A11y (WCAG 2.2 AA)

Checked via the `accessibility` skill (roles/live-region pattern) — below is its application to this filter.

- **Roles.** `SegmentedToggle` already renders `role="tablist"` + `role="tab"` + `aria-selected` in
  `variant="tabs"` mode (used here) — nothing extra needs to be attached, this is
  exactly the right semantics for «one choice from a static set of tabs that change the content
  below».
- **Focus.** `SegmentedToggle` already gives `focus-visible:ring-2 focus-visible:ring-ring
focus-visible:ring-offset-2` on each button (SC 2.4.11) — not touched.
- **Touch target.** 44×44 CSS px on the mobile instance — see §5 (an explicit fix, do not rely on the
  default `size="sm"`).
- **Color is not the only carrier of meaning (SC 1.4.1).** Each status carries THREE independent
  signals, not just color: (1) the badge text — «Ждёт подтверждения» / «Отклонено», not just a colored
  dot; (2) the icon — `Clock` vs `XCircle`, a different shape, distinguishable for colorblind
  users as well; (3) for a rejected one — also the explicit reason text below. The indicator dot by the name is
  a decorative reinforcement ON TOP of the already verbally announced status, not the sole carrier.
- **Announcing the filter change to a screen reader (SC 4.1.3, status messages).** The change of the tab itself
  is voiced natively via `aria-selected` on the button that received focus/click (already works,
  a property of `role="tab"`). What is NOT voiced today is the result: the list below is redrawn outside
  the user's focus. One `sr-only` paragraph with `aria-live="polite"` is added next to the list
  (`aria-atomic="true"`, so the whole text is re-read in full, not by diff):

  ```tsx
  <p className="sr-only" aria-live="polite" aria-atomic="true">
    {STATUS_FILTER_LABELS[currentTab]}. Показано проектов: {filtered.length}.
  </p>
  ```

  The wording «Показано проектов: N» deliberately sidesteps Russian numeral agreement
  (1 проект / 2 проекта / 5 проектов) — the construction «shown X: N» is grammatically correct for any N
  without a declension dictionary.

- **Badges in the right column** — not interactive (a status, not a button), therefore they do not require
  their own touch target separate from the whole row, which is already clickable (a stretched link over the whole card
  already covers navigation to the detail page, see `ProjectRow.tsx:96-106`).
- **Theme.** Dark only — the contrast of `amber-300 on bg-amber-500/20` and `destructive on bg-destructive/10`
  are pairs already proven in production (used on this same dark theme in `document-status-badge.tsx` /
  `TransactionRow.tsx` without separate contrast findings) — no new measurements are required, the tonality
  is identical to the existing places of use.

---

## 11. Checklist for Coder (a summary, does not duplicate the sections above)

- [ ] `constants.ts`: `STATUS_FILTER_LABELS` (desktop) + `STATUS_FILTER_LABELS_MOBILE` (§5).
- [ ] `index.tsx`: `SegmentedToggle` — option list by role (§2), two instances `lg:hidden`/`hidden
lg:grid` (§5), mobile `[&>button]:max-[639px]:min-h-11` (§5), `sr-only` live region (§10), `isError`
      branch (§6).
- [ ] `ProjectRow.tsx`: right column — a 4-way branch on `status`/`archivedAt` instead of a 2-way (§7, §8),
      indicator dot — 4 values instead of 2, `ring-1 ring-amber-500/20` for DRAFT (§7),
      `opacity-60` extended to REJECTED (§8).
- [ ] Empty states — parameterize text/icon by tab and role (§6).
- [ ] Do not touch: the `ProjectRow` column grid architecture, the mobile collapse of the row (a known
      existing limitation, §5), the «propose again» action (detail page, outside this
      task), the DROP side of confirmation (another screen, outside this task).

---

## Screenshots

- `docs/design/assets/project-status-filter/current-375.png` — current screen, mobile
- `docs/design/assets/project-status-filter/current-768.png` — current screen, tablet
- `docs/design/assets/project-status-filter/current-1024.png` — current screen, laptop
- `docs/design/assets/project-status-filter/current-1440.png` — current screen, large

Captured by a live Playwright pass (ADMIN, dev-login, `crm_qa`) immediately before writing this
spec — not from memory of how the screen «should» look.
