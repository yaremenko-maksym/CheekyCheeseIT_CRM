# «Ожидают ответа» screen (`/pending`) — design spec

**Design tier:** 1 (new screen) — position 7c of the «notifications and confirmations» epic plan.
**Design-gate:** **degraded** (Mode E from a static mockup — Claude Design is unavailable to the agent in this
session). The reference is `docs/design/assets/pending-screen/design.html` + the PNGs below, not a browser round
in claude.ai/design.
**Screen:** `apps/web/app/routes/_authenticated/pending/index.tsx` (new file).
**Business context source:** `docs/superpowers/specs/2026-09-01-notifications-and-confirmations-
design.md` §3, §4.1, §7.4, §8.3, §8.4 — read in full, the owner's decisions below are not revisited,
they are translated into concrete layout. The assignment: `.claude/tasks/task-pending-screen.md` — read in full.
**Theme:** dark only (`apps/web/index.html` is hard-coded `class="dark"`) — I do not design or
check a light theme, see `.claude/rules/common/design-gate.md`.
**References:**

- `docs/design/assets/pending-screen/design.html` — a static mockup on our tokens (three
  states: SENIOR, ADMIN, empty + reference fragments of the nav badge and the popup footer).
- `docs/design/assets/pending-screen/design-320.png`, `design-768.png`, `design-1440.png` — captured
  by the same Playwright script (headless chromium, `fullPage`).
- `docs/design/assets/pending-screen/design.png` = a copy of `design-1440.png` (the main fidelity
  reference for Mode B, see `design-fidelity-review.md`).

---

## 0. What is already in place (read from code, not from memory)

Five facts that determine the entire design that follows.

1. **`approvals` is already a ready «to me» source.** `ApprovalsService.listPendingForApprover(userId)`
   exists and returns the same thing that `usePendingProjectApprovals` assembles ad hoc today
   (`GET /projects`, filtered on the client by `status === 'DRAFT'`). There is **no** symmetric
   `listPendingProposedBy(userId)` — it is part of the API side of this same task (item 1
   «What to do» in the task file), not a design decision; here I assume it will appear with the
   same data shape.
2. **The project action is ALREADY packaged in a ready component.** `ProjectApprovalActions`
   (`apps/web/app/components/projects/ProjectApprovalActions.tsx`) — confirm/reject with a
   reason dialog, `h-11 sm:h-7` buttons, `aria-label`+`title`, `data-testid`. Six review rounds
   (#646) already closed the a11y/touch-target/overflow findings on this very component. **Reused
   as is**, without moving properties around.
3. **The share action is NOT packaged.** `useApproveSeniorShareChange`/`useRejectSeniorShareChange`
   (`apps/web/app/hooks/use-user-profile.ts`, scope `user`) and their project twin (inline in
   `apps/web/app/routes/_authenticated/projects/$projectId.tsx:PendingShareApprovalBanner`, scope
   `project`) exist, but each is built into ITS OWN banner (`OverviewTab.tsx` / `$projectId.tsx`), not
   extracted into a reusable component at the level of `ProjectApprovalActions`. The only thing already ready
   as a separately importable component is `CancelPendingShareButton`
   (`apps/web/app/components/pending-share/cancel-pending-share.tsx`), needed only by the ADMIN side
   («Отозвать»). See §5 — what of this is reused, and what needs to be built anew on the model.
4. **There are no `<h1>` headings on CRM pages anymore.** Verified on `documents.tsx` (in full, not a single
   `<h1>`/`<h2>`) — the E2E anchor everywhere is the `data-testid` of the container root, not `getByRole('heading')`
   (fixed by PR #243/#244). So `/pending` **does not get** a big page heading either —
   the first thing the viewer sees is the heading of the first section («Ждёт вашего ответа»), like on any
   other CRM page.
5. **`max-w-6xl` (1152px), without `mx-auto`, is an already established convention «a column page, not
   a dashboard».** `UserProfileShell.tsx` (comment `task-border-reset-and-profile-shell`,
   2026-08-16) sets exactly this cap on the content area, justifying it literally with the text of
   `foundation.md` §10 («content columns get a max-w cap on ≥1440»), and it is measured on all 4
   device classes. `/pending` is the same page archetype (a list of row cards, not a KPI table across the
   whole screen), so it takes the same cap rather than inventing its own (see §9).

---

## 1. Brief (5 questions, skill `frontend-design-direction`)

| Question             | Answer                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**          | A single point of «what is expected of me»: projects awaiting confirmation, share changes, a contract to sign — today scattered across three surfaces (a dashboard widget, a profile tab, the bell popup) and lost among dozens of notifications. The screen adds NOTHING new in function — it aggregates already existing actions under one roof.                     |
| **Audience**         | Any role that can possibly have an unclosed obligation: SENIOR/DROP (project, share), JUNIOR/HR/ACCOUNTANT (contract), ADMIN (their own + «who hasn't answered me yet»). They come NOT every day — via the bell/nav-item badge, so the screen must be readable from scratch, without habit.                                                                            |
| **Tone**             | `dense · quiet · scannable` — the same language as the whole CRM (foundation.md §1). NOT a tracker/inbox aesthetic (no read/unread dots, no «archive by swipe») — this is a list of actions, not a feed.                                                                                                                                                               |
| **Memorable detail** | The ADMIN asymmetry — the nav-item badge shows **only** `mine.length` (what the ADMIN personally has to decide), not the total number of pending items in the system. ADMIN almost always sees the item WITHOUT a number, but walks in and sees a whole «Ждут ответа других» section — a detail that is explained once in the spec (§7) and no longer requires memory. |
| **Constraints**      | Tailwind v4 + shadcn/ui, only existing tokens, Russian UI, WCAG 2.2 AA, responsive 320–1920 (7 test widths), dark theme only, reuse of `ProjectApprovalActions`/`CancelPendingShareButton` as is.                                                                                                                                                                      |

**Domain-fit.** Not an «inbox», but a «to-do with two buttons per item» — an operational checklist, not a
content stream. Hence: no infinite scroll/pagination (the number of items per person is a handful,
occasionally dozens), no sorting/filters (there is nothing to filter in a list of three buttons).

---

## 2. Data the screen receives (recap — I do not redefine it, only ground it for the layout)

The shape of the `GET /pending` response is a decision of the API side of this same task (task file §«What to do» item 1); it is not
revisited here, it is only recorded what is fed into the layout:

```
{ mine: PendingItem[], proposedByMe: PendingItem[] }

PendingItem:
  kind: 'PROJECT_APPROVAL' | 'SHARE_APPROVAL' | 'CONTRACT_TO_SIGN'
  approvalId?: string
  subjectId: string
  title: string                         // название проекта / «Контракт сотрудника»
  proposedBy?: string                   // имя — для mine
  waitingFor?: string[]                 // имена — для proposedByMe
  currentPercent?: number               // SHARE_APPROVAL, только если доля зрителя
  pendingPercent?: number               // SHARE_APPROVAL — см. врезку ниже про null-override
  createdAt: string                     // ISO
  actions: Array<'approve' | 'reject' | 'cancel' | 'open'>
  link: string
```

**An important finding when analyzing `pendingSeniorShareSchema` (`packages/shared/src/schemas/pending-share.ts`),
worth passing on to the API side if not yet accounted for.** A share proposal can be «remove the
override, return to the default» — then the «raw» `percent` on the backend is `null`, and what must be shown is
`effectivePercentAfterApproval` (it is ALWAYS a concrete number — the same file explicitly warns «client
must never compute this locally… always a concrete number»). So `pendingPercent` in `PendingItem`
must be filled from `effectivePercentAfterApproval`, not from the raw `percent` — otherwise an **empty percent cell**
would slip onto the screen in exactly the rare case this schema specifically
provides for. The layout below (§6.2) assumes that `pendingPercent` is always present if
`kind === 'SHARE_APPROVAL'` got into the list at all.

**`proposedBy` may be absent for `CONTRACT_TO_SIGN`.** Nobody «proposes» a contract in the same
sense as a project/share — it is an administrative action (`employeeContracts.createdByUserId`
technically exists, but resolving it into a name for a single line on a screen that cannot
show approve/reject for a contract anyway is overhead without benefit). The contract row in the mockup
(§6.3) does not show «from whom» at all — only age.

---

## 3. Overall page structure

**No `<h1>`** — see §0.5. Root: `<div data-testid="pending-page" className="flex flex-col h-full">`,
content — `flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:max-w-6xl` (without `mx-auto` —
the same pattern as `UserProfileShell`, see §0.5 and §9).

Two **zones**, each rendered only if non-empty (the same principle already carried by
`PendingProjectApprovalsPanel` — «nothing if there is nothing to show», not an empty card):

1. **«Ждёт вашего ответа»** (`mine`) — visible to all roles that have at least one item in it.
2. **«Ждут ответа других»** (`proposedByMe`) — ADMIN only, and only when there is something in it.

Inside each zone — **sub-sections by `kind`**, in a fixed order Projects → Shares → Contracts
(the same order as in the `kind` enum of the assignment, and the same in which the nav/icons of this feature are already
listed in the task file). A sub-section is also rendered only if it has items — the
«Контракты» section will never appear in «Ждут ответа других» (see the note in §2 — `proposedByMe` physically
cannot contain `CONTRACT_TO_SIGN`, it is not an `approvals` row).

**Why sections, not tabs.** Business spec §8.3 describes the screen literally as «a list of everything
awaiting an answer» — not as several lists to switch between. Most viewers will have
0–3 items in `mine` in total across all kinds — hiding three items behind tabs means an extra click where
there is little content anyway. Tabs would make sense with dozens of items per kind; this is not that scale
(a precedent of the same choice — `project-status-filter.md` §2 rejects a second tab control for a
similar reason: «one list — one navigation mechanism»).

**Why for ADMIN the «Ждёт вас» zone can be absent altogether, rather than just an empty card.**
`mine` for ADMIN is computed by THE SAME `listPendingForApprover` as for everyone — and ADMIN is not an invited
confirmer on any project/share (that role is always played by SENIOR/DROP), and
almost never has their own `employeeContracts` contract. `mine.length === 0` for ADMIN is a
**normal, expected** state, not a bug and not an empty screen: ADMIN simply has no personal
obligations, only the «Ждут ответа других» zone. This is shown directly in `design.html` (View 2) and
commented in the markup.

**The global empty state** («Ничего не ждёт вашего ответа», §10.1) is shown ONLY when
BOTH zones are empty (`mine.length === 0 && proposedByMe.length === 0`). If ADMIN's `mine` is empty but
`proposedByMe` is not, the page shows the second zone without the first, rather than a general empty-state.

---

## 4. Token map

Nothing new is added to `apps/web/app/styles/globals.css`. All coloring is the already used
convention «amber/emerald = waiting/confirmation» from THIS SAME feature (not borrowing by analogy —
these are literally the same files whose actions this screen reuses).

| Purpose                                   | Classes                                                                                             | Precedent                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Zone heading                              | `text-base font-semibold tracking-tight`                                                            | foundation.md §4 «Section title»                                                                            |
| Sub-section heading (kind)                | `text-[11px] font-semibold uppercase tracking-wider text-muted-foreground` + icon `text-amber-400`  | `PendingProjectApprovalsPanel.tsx` — «Ждёт вашего решения» header 1:1                                       |
| Row (regular, `mine`)                     | `border-border/40 bg-muted/20 rounded-md`                                                           | `PendingProjectApprovalsPanel.tsx` per-item div                                                             |
| Row (observer, `proposedByMe` ADMIN)      | `border-amber-500/30 bg-amber-500/[0.06]`                                                           | Weaker than the banner (`bg-amber-500/10`) — this is a per-row list, not a single accent block              |
| «Подтвердить» button                      | `border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10`                                    | `ProjectApprovalActions.tsx` approve-button 1:1                                                             |
| «Отклонить» button                        | `border-destructive/30 text-destructive hover:bg-destructive/10`                                    | `ProjectApprovalActions.tsx` reject-button 1:1                                                              |
| «Отозвать» button (ADMIN)                 | `variant="outline"` shadcn default                                                                  | `CancelPendingShareButton` — reused without style edits                                                     |
| «Открыть» button                          | contract → `variant="default"` (primary), project/share → `variant="ghost"`                         | Contract — the only action in the row → CTA weight; project/share — a secondary link next to approve/reject |
| «готов к подписанию» badge                | `variant="default"` (`Badge`, the same yellow as `ContractTab.tsx` `STATUS_VARIANTS.READY_TO_SIGN`) | `ContractTab.tsx` — the same status, the same variant, no new one is invented                               |
| Percentages («Сейчас X% → предлагают Y%») | `tabular-nums font-medium`                                                                          | `PendingBaseShareBanner`/`PendingShareApprovalBanner` 1:1                                                   |
| Age                                       | `text-[11.5px] text-muted-foreground`, `formatDistanceToNow(date, {addSuffix:true, locale: ru})`    | `notifications-bell.tsx` `fmtRelative` — the same helper, not reinvented                                    |
| Empty/error — icon                        | `text-muted-foreground/40`                                                                          | `notifications-bell.tsx` `Inbox` empty-state                                                                |
| Content column cap                        | `lg:max-w-6xl` (without `mx-auto`)                                                                  | `UserProfileShell.tsx` — see §0.5                                                                           |

---

## 5. Components

### 5.1 Existing — reused as is (no visual edits)

- **`ProjectApprovalActions`** (`@/components/projects/ProjectApprovalActions`) — for each item
  of `kind: 'PROJECT_APPROVAL'` in `mine`. It takes `projectId`, `companyName`, `onActed` — exactly what
  is in `PendingItem` (`subjectId` → `projectId`, `title` → `companyName`).
- **`CancelPendingShareButton`** (`@/components/pending-share/cancel-pending-share`) — for each
  item of `kind: 'SHARE_APPROVAL'` in `proposedByMe` (ADMIN). It takes `scope: 'user' | 'project'`,
  `id`, `pendingPercent` — the mapping is direct: `scope = subjectType === 'USER_SENIOR_SHARE' ? 'user' :
'project'`, `id = subjectId`, `pendingPercent` = the `effectivePercentAfterApproval` described above.
- **`Card` / `CardContent` / `Skeleton` / `Badge` / `Button`** — standard primitives, with no customization
  beyond what is already in the token map.

### 5.2 New — justified, minimal

1. **The «Подтвердить/Отклонить» action for a share (`mine`, `kind: 'SHARE_APPROVAL'`) — a new small
   component, MODELED ON `ProjectApprovalActions`, not a copy of someone else's banner.**
   Rationale: the only thing that exists today for this action is `useApproveSeniorShareChange`/
   `useRejectSeniorShareChange` (user-scope, exported from `use-user-profile.ts`) and their project
   twin, which lives **inline inside** `$projectId.tsx` (`PendingShareApprovalBanner`, NOT
   exported either as a hook or as a component). This screen needs ONE component working on
   both scopes — recommendation: `SeniorShareApprovalActions({ scope, id, currentPercent, pendingPercent,
onActed })`, visually identical to `ProjectApprovalActions` (the same button classes from §4, the same reason
   dialog via `CrmDialogContent`/`CrmDialogHeader`/`CrmDialogBody`/`CrmDialogFooter`, the same pattern
   of the `reason.length}/500` counter). **A technical question for the Coder** (not a design decision, see §12):
   `useApproveSeniorShareChange`/`useRejectSeniorShareChange` are already parameterized by userId — for
   project-scope one must either export an analogous pair from `$projectId.tsx` (symmetrically to what
   is already done for user-scope), or generalize both under one `scope` parameter in
   `use-user-profile.ts`, next to `useCancelPendingShare`, which already solves this fork 1:1 (see
   `cancel-pending-share.tsx:effectivePercentOf`). The second path is preferable — do not breed a third file
   with the same `scope` branch that `useCancelPendingShare` already has.
2. **`PendingKindSection`** — a small presentational component: icon + uppercase heading (§4) +
   a list of rows. Rationale by the deletion test (`codebase-design` skill): delete it and inline it back —
   nothing breaks, so this is not an architectural boundary but pure reusability (three
   places of use on one page — already worth not copy-pasting JSX three times).
3. **`PendingItemRow`** — a switch on `item.kind`, renders the needed combination of heading/meta/actions
   (details — §6). One component with a switch inside, not three separate top-level components — the body of
   each branch is short (a heading + one meta line + one set of buttons), extracting into separate files
   is premature by the same deletion test.
4. **An insertion into `nav-sidebar.tsx`** — one new `NavItem` («Ожидают ответа», `Clock`, `to: '/pending'`,
   `roles: ALL_ROLES` from `route-access.ts`) + a counter badge (§7). NOT a new component — an extension of
   the existing `NAV_ITEMS` list by the same pattern as all the other items.
5. **An insertion into `notifications-bell.tsx`** — one `<footer>` block after `<ul data-testid="notifications-
list">` (and with the same visibility condition as the list itself — the footer is needed regardless of whether there
   are unread notifications, it is not part of their state). The only edit to this file — see §8.

**Explicitly NOT introduced:** a general-purpose standalone `EmptyState` component (there is none in the codebase
anywhere — each page writes its own in two or three lines of JSX, `notifications-bell.tsx` and
`DropBalanceCard.tsx` are precedents; introducing an abstraction here for one screen is premature).

---

## 6. Row anatomy by `kind`

> **The texts in this section are outdated after the copy review of PR #667 (rounds 1–4).** The canon is the code and the PR body; the section describes the
> **anatomy** of a row, not its words. Replaced: «Предложил {имя}» → «Предлагает {имя}» · «Ничего не ждёт вашего ответа» →
> «…вашего решения» (caption — «Новые проекты, доли и контракты появятся здесь.») · «Не удалось загрузить список.» →
> «Не удалось загрузить, что ждёт решения.» · «Отозвать» → «Отменить предложение» · «Доля по проекту «{name}»» →
> «{companyName}» · in the `proposedByMe` zone «предлагают» → «предложено» · «ждём:» → «Ждём:». The rasters (`design.html`,
> `design-*.png`) were made before these edits and are not a source of text.

The common row skeleton (all kinds) — `.item-row` from `design.html`: `flex flex-wrap items-center
justify-between gap-2.5`, the left part (`min-w-0 flex-1`) — heading + meta, the right (`flex-none`) —
actions. `flex-wrap` on the row itself is mandatory (not optional): its absence is what produced QA-H-2 on
#646 (actions ran onto the neighboring column at 1024px, see `ProjectApprovalActions.tsx`'s own
comment about the `max-w-full` fix) — here is the same risk at the same button width, so the same fix
is built in from the start rather than found anew.

### 6.1 `PROJECT_APPROVAL`

```
[TechFlow Solutions                              ]  [✓ Подтвердить] [✕ Отклонить]
[Предложил Олексій Коваленко · 2 дня назад       ]
[Ваша доля: 26%                                  ]
```

- The heading — `item.title` (`truncate`, a single line ≥640px; `line-clamp-2 wrap-anywhere` <640px — see
  §10.4 about the 80-character name).
- Meta — `Предложил {proposedBy} · {age}`. If `proposedBy` is absent (should not happen for
  this kind, but fail-safe) — just `{age}` without «Предложил».
- Actions — `<ProjectApprovalActions projectId={subjectId} companyName={title} onActed={...} />` **as
  is**, without the `compact` prop (it turns on an icon-without-text at `lg:` — here the row is alone on the
  screen anyway, there is enough room, text buttons are more readable).
- If `actions` does not contain `'approve'`/`'reject'` (should not happen for `mine`, but the
  `PendingItem.actions` contract in principle allows it) — only what is there is rendered; `'open'` without
  approve/reject yields a single «Открыть» link instead of a pair of buttons.
- **The third line — the viewer's share (decided in Mode B, round 1, UX-H-1; closed by fix-round 3).** When
  `zone === 'mine'` and `item.viewerSharePercent != null` — another `<p>` is rendered under the meta line:
  `Ваша доля: {viewerSharePercent}%`, plus ` · синьор: {seniorName}` if `seniorName` is present
  (`text-[11px] text-amber-300/70` — a tone paler and smaller than the main meta: here the percentage is context
  for the decision, not the subject of the decision itself, unlike `SHARE_APPROVAL` in §6.2, where `tabular-nums
font-medium` is appropriate). Who sees this line and with what content is determined by the **viewer**, not
  a backend flag:
  - **SENIOR**, confirming their own project — `Ваша доля: {seniorSharePercent}%`, WITHOUT «синьор: …»
    (they are the senior, adding their name would be redundant).
  - **DROP**, confirming a project where `project.dropId === viewer.id` — `Ваша доля: {dropSharePercent}%
· синьор: {senior.displayName}`. For DROP this is the only signal of the deal terms on this screen: DROP
    has no access to `/projects` at all (RBAC), and unlike SENIOR has no «Открыть» on this
    row — without the share, «Подтвердить» would be a decision made blind.
  - **ADMIN** (and any other viewer of the `proposedByMe` zone) — this line never appears: ADMIN
    sees a `mine` row only when they are themselves the project's SENIOR/DROP (a crossover case, the same computation as
    above), and in `proposedByMe` they are an observer, not a party to the deal — there is nothing for them to confirm by share.
  - Verified by a live pass on a scratch stand (Mode B, round 2, PR #667): a SENIOR viewer sees
    `«Ваша доля: 26%»` without a suffix, a DROP viewer — `«Ваша доля: 5% · синьор: Dmytro Marchenko»`, ADMIN
    on `proposedByMe` — `0` rows with this class on the page (`p.text-amber-300/70` is not rendered).
  - This is NOT drift from the `design.html`/`design.png` mockup (created before this line) — a deliberate
    extension of the `PROJECT_APPROVAL` anatomy, found by Mode B itself in round 1 as a coverage gap
    (DROP did not see the deal terms), not an unplanned deviation by the coder. The next fidelity audit
    checks this line against THIS section, not against the raster reference, which does not contain it.

### 6.2 `SHARE_APPROVAL`

```
[Доля по умолчанию                                ]  [✓ Подтвердить] [✕ Отклонить]
[Сейчас 26% → предлагают 30% · 1 день назад       ]
```

- The heading is not literally `item.title`, but depends on what `title` carries from the backend: if it is already
  «Доля по умолчанию» / «Доля по проекту «X»» (the difference between user-scope / project-scope, see §2) — it is rendered
  as is. A recommendation to the API side (not a mandate, but it must be decided consistently): `title` = `'Доля по
умолчанию'` for `USER_SENIOR_SHARE`, `` `Доля по проекту «${projectName}»` `` for
  `PROJECT_SENIOR_SHARE` — exactly the text the existing banners already write (`PendingBaseShareBanner`
  says «долю по умолчанию», `PendingShareApprovalBanner` — «доля по проекту»), simply moved
  to the data level instead of being hard-coded in two places.
- Meta — `Сейчас {currentPercent}% → предлагают {pendingPercent}% · {age}`, both numbers
  `tabular-nums font-medium`. If `currentPercent` is absent (by contract should not be for `mine`, but
  defensive) — `Предлагают {pendingPercent}% · {age}` without «Сейчас… →».
- Actions — the new `SeniorShareApprovalActions` (§5.2 item 1), visually identical to `ProjectApprovalActions`.

### 6.3 `CONTRACT_TO_SIGN`

```
[Контракт сотрудника  [готов к подписанию]        ]  [Открыть →]
[6 часов назад                                     ]
```

- The heading and the badge are **separate flex elements** inside `.item-title-row` (not one text node with
  the badge inside), each with its own wrapping. **A real finding, caught on my own mockup**: in the
  first layout I put the badge inside the same `<p>` as the heading, with `white-space: nowrap` — at 320px the badge
  «готов к подписанию» was cut off together with the text (see screenshot `design-320.png` BEFORE the fix
  vs the current one). Fixed by splitting into `item-title-row` (`flex flex-wrap`) with `item-title` (`flex: 1 1
auto; min-width: 40px`) and the badge as a separate `flex` neighbor that wraps to a new line
  if it does not fit, rather than being cut off. This is exactly the AC7 defect class («buttons/badges do not overlap and are not
  cut off») — direct proof that a heading with a badge needs the same discipline as a
  heading with buttons.
- Meta — age only (`{age}`), without «from whom» — see the note in §2.
- Action — one `variant="default"` button «Открыть» → `link` (`/profile?tab=contract` for one's own
  profile — `EmployeeContractsService.getMyStatus` resolves the caller's contract, a second address
  is not needed). **There is NO approve/reject on this screen** — the assignment explicitly forbids moving signing here
  («the row leads there»); this is the only kind with no approve/reject pair at all, not a special case of
  missing `actions`.

### 6.4 `proposedByMe` (ADMIN) — the «observer» variant

The same row skeleton, a different background (`.item-row.observer` — see §4), meta is replaced with «Ждём: {names}»:

```
[Нордвік Діджитал                                 ]  [Открыть →]
[Ждём: Ірина Савенко · 3 дня назад                ]
```

```
[Доля по проекту «TechFlow Solutions»             ]  [Отозвать]
[Сейчас 26% → предлагают 30% · ждём: Олексій       ]
[Коваленко · 1 день назад                          ]
```

- `waitingFor` — an array of names, joined by a comma (`waitingFor.join(', ')`). The question «comma-separated or
  with „и“ before the last» — I leave to `copy-reviewer` (see §12); the default in the mockup is a plain `join(',
')`, the safest option with no risk of numeral/gender agreement across different names.
- `PROJECT_APPROVAL`, `proposedByMe`: the action is only `'open'` (`variant="ghost"`), see the note in §2
  of the assignment — there is no «withdraw a project draft» endpoint in `main` (`@Delete(':id')` = `archive`, this is a DIFFERENT,
  broader action, not equivalent to withdrawing a specific proposal). Recorded in the «Assumptions»
  of the assignment, not decided here anew.
- `SHARE_APPROVAL`, `proposedByMe`: the action is `<CancelPendingShareButton>` (§5.1), which already carries
  its own `AlertDialog` confirmation («Отменить предложение X%?» / «Оставить» / «Отменить
  предложение»), embedded here without changes.

### 6.5 Unknown `kind` (AC6 — does not crash the screen)

`PendingItemRow`'s switch gets a `default` branch: heading = `item.title` (if present, otherwise
`'Запрос на действие'`), meta = age, action = `'open'` if it is in `actions`, otherwise nothing.
The icon is `HelpCircle` (neutral, does not pretend to know what it is). It does not fall into any
kind section — it is rendered in a separate sub-section «Другое» **at the end of the zone**, shown only if
such an item actually arrived (today — never; this is a purely defensive branch for a future enum extension
without deploying the front end simultaneously with the back end).

---

## 7. Nav item + counter badge

`nav-sidebar.tsx`, `NAV_ITEMS`: a new entry `{ label: 'Ожидают ответа', icon: Clock, to: '/pending',
roles: navRolesFor('/pending') }`, in `route-access.ts` — `{ prefix: '/pending', roles: ALL_ROLES }`
(the same pattern as `/profile` and `/onboarding` — the only two existing `ALL_ROLES` items in the
file). Position in the list — after «Дашборд», before «Пользователи» (by
analogy with the fact that this is also «personal», not an operational section like «Проекты»/«Финансы»); the final
position is at the Coder's discretion, it is not a design decision.

The badge is `mine.length`, the same query as the page itself (`PENDING_QUERY_KEY`, separate from the widget's
`PENDING_APPROVALS_QUERY_KEY` — do not mix, it has a different response shape). **Three states**
(see `design.html`, «Справочно»):

| `mine.length` | Look                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`           | No badge at all (the item is just a menu item, without a number)                                                                                          |
| `1–9`         | The exact number, the same visual as `notifications-bell-badge`                                                                                           |
| `10+`         | Capped at `99+` — the convention ALREADY exists in `notifications-bell.tsx` (`unreadCount > 99 ? '99+' : unreadCount`), taken verbatim, not invented anew |

The badge layout — `absolute -top-0.5 -right-0.5` (or an equivalent under `DesktopNavLink`'s `relative`
wrapper) `flex h-4 min-w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold
text-primary-foreground` — a 1:1 copy of the `notifications-bell-badge` classes (there is no reason to introduce a second
visual language for a «number of unread/unclosed» in one application).

**The ADMIN asymmetry — already described in §3 «Why for ADMIN the zone…» and in §1 «Memorable detail». The only thing that matters here:
the badge does NOT count this.** `proposedByMe.length` never gets into the nav-item counter —
the badge answers the question «what do I personally need to do», not «how much in total in the system is waiting for someone».

**The mobile `Sheet` variant of the menu** (`nav-sidebar.tsx`, the `<Sheet>` branch) — the same item, the same badge,
but there `<item.icon>` and `<span>{item.label}</span>` already go in a row without the `collapsed` state — the badge
is placed by the same `ml-auto` pattern next to the label, not `absolute` over the icon (the
expanded menu has horizontal room, there is no need to clip the icon with absolute positioning).

---

## 8. Bell popup footer

`notifications-bell.tsx` — the only edit: one `<footer>` block right after the closing tag
`</ul>` (after the `items.length === 0 ? ... : (...)` branch, i.e. the footer is visible **both** with an empty list of
notifications **and** a non-empty one — it is not part of the list state):

```tsx
<footer className="border-t border-border/50 px-4 py-2.5 text-center">
  <Link
    to="/pending"
    onClick={() => setOpen(false)}
    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    data-testid="notifications-bell-footer-pending-link"
  >
    Всё, что ждёт ответа
    <ArrowRight className="h-3 w-3" aria-hidden />
  </Link>
</footer>
```

- `onClick={() => setOpen(false)}` — the same pattern that `handleItemClick` already uses for regular
  items (close the dropdown before navigating).
- Not tied to `unreadCount`/`hasUnread` — it is not «one more notification», but a permanent exit point to the
  aggregating screen, always visible.
- The copy of the text «Всё, что ждёт ответа» is deliberately **not** «Ждёт решения» (see the note in §13 about the
  divergence from backlog item 168) and not «Все уведомления» (that is NOT the same as the list of
  notifications above in this same popup — a typical confusion that the explicit text «ждёт ответа» removes,
  distinct from the «Уведомления» heading three lines above).

---

## 9. Responsive (320/375 · 768 · 1024/1280 · 1440/1920)

### Key decision: a line-by-line list (flex-row), not a table↔card switch

The assignment allows both options («768 — two columns or a table»). I choose **the same `.item-row`
on all device classes**, without a structural switch to `<table>` on desktop — for three reasons:

1. **It is already an established pattern SPECIFICALLY for approval rows in this very application.**
   `PendingProjectApprovalsPanel`, `ProjectApprovalActions`, `PendingBaseShareBanner` — all three
   components that this screen reuses literally already use flex-row with
   `flex-wrap`, not a table. Introducing a `<table>` here would mean three actions identical in meaning
   on one page look like two different grammars.
2. **There is little data in a row** (a heading + one meta line + 1-2 buttons) — a table is justified when
   values need to be compared BY COLUMNS across many rows (numbers/statuses); here each row is a
   self-sufficient decision card, not a registry entry.
3. **`justify-content: space-between` inside a row of equal width ALREADY gives table alignment
   visually** (the actions of all rows are pressed to one right edge) — without the platform mechanics of
   `<table>` (`role="row"`/`role="cell"`, which does not fit here semantically: this is not data but a
   list of actions).

The «table with a width cap» from the assignment reads as «an aligned, non-cached list with a limited
column width», not as a requirement for the `<table>` tag — the cap is satisfied through §0.5/§9 `max-w-6xl`.

### Per-class behavior

| Class      | Widths      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mobile** | 320 / 375   | `.item-row` — heading+meta across the full width, buttons on the next line (`flex-wrap`), each button `h-11` (44px, `responsive-design.md` mobile minimum — `ProjectApprovalActions` already does this via `sm:h-7`, inherited for free). The reject-reason dialog — `CrmDialogContent` (already `w-full`, no radius below `sm:`, `max-h-[90dvh]` — see §9.1 why a separate bottom-sheet component is NOT needed). |
| **Tablet** | 768         | The same `.item-row`, buttons more often fit in one row with the text (there is enough width) — purely a consequence of `flex-wrap`, not a separate code branch.                                                                                                                                                                                                                                                   |
| **Laptop** | 1024 / 1280 | The same, `lg:max-w-6xl` does not constrain yet (the natural content width is narrower than the cap on these screens — see the §0.5 measurements of `UserProfileShell`, the same case).                                                                                                                                                                                                                            |
| **Large**  | 1440 / 1920 | `lg:max-w-6xl` actually constrains — rows do not stretch across the whole screen width, the text+buttons row does not «sprawl» for the eye.                                                                                                                                                                                                                                                                        |

### 9.1 The reject-reason dialog — the reusable `CrmDialogContent`, NOT a new bottom-sheet

The assignment (referencing `responsive-design.md`) assumes a bottom-sheet/full-screen on mobile for
the reject dialog. Verified in code: `CrmDialogContent` (`apps/web/app/components/ui/crm-dialog.tsx`) at
`<sm` is already `w-full`, without `sm:rounded-xl` (i.e. without rounding — almost edge-to-edge), with `max-h-[90dvh]`
and a scrolling `CrmDialogBody`. This is exactly the effect a bottom-sheet aims for (almost the whole
screen, vertical scroll of content, a fixed footer with buttons) — just via a centered rather than
bottom-attached animation. **It is already the dialog used for THIS SAME action** —
`ProjectApprovalActions`, `PendingBaseShareBanner`, `PendingShareApprovalBanner` all use
`CrmDialogContent maxWidth="sm:max-w-md"` for the rejection reason. Introducing a real bottom-sheet
(a different animation, a different primitive) only for `/pending` would mean the same «reject» dialog
looks different depending on which screen it was opened from — which is worse than
falling short of the letter of `responsive-design.md`. **Decision (A1, reversible):** reuse
`CrmDialogContent` as is.

### 9.2 Touch targets

All interactive elements are ≥44×44 CSS px at `<sm:` (the `responsive-design.md` mobile threshold, stricter than
the basic a11y minimum of 24px): approve/reject/cancel buttons inherit this from the reused
components (`ProjectApprovalActions`/`CancelPendingShareButton` already carry `h-11 sm:h-7`/`h-11 sm:h-8`),
the new `SeniorShareApprovalActions` must repeat the same pattern (`h-11` base, `sm:h-7` from 640px).
The «Открыть» button (contract/project-observer) — the same `h-11 sm:h-7|h-8`. The link in the popup footer
(§8) — short text, but falls into the clickable area `py-2.5` (≥44px in height including the padding
of the `<footer>`, to be measured in Mode B).

---

## 10. States

> **The texts in this section are outdated after the copy review of PR #667 (rounds 1–4).** The canon is the code and the PR body; the section describes the
> **anatomy** of a row, not its words. Replaced: «Предложил {имя}» → «Предлагает {имя}» · «Ничего не ждёт вашего ответа» →
> «…вашего решения» (caption — «Новые проекты, доли и контракты появятся здесь.») · «Не удалось загрузить список.» →
> «Не удалось загрузить, что ждёт решения.» · «Отозвать» → «Отменить предложение» · «Доля по проекту «{name}»» →
> «{companyName}» · in the `proposedByMe` zone «предлагают» → «предложено» · «ждём:» → «Ждём:». The rasters (`design.html`,
> `design-*.png`) were made before these edits and are not a source of text.

### 10.1 Empty (both zones are empty)

```
        [Inbox icon, 34px, text-muted-foreground/40]

           Ничего не ждёт вашего ответа

   Новые проекты, доли и документы на подпись появятся
   здесь, как только кто-то будет ждать вашего решения.
```

`data-testid="pending-empty"`. Centered across the full height of the content area (`flex-1 flex flex-col
items-center justify-center`, not just `padding` on top — on a large screen «Ничего не ждёт» must
not cling to the very top of the page). The copy is a direct echo of the zone heading («Ждёт вашего ответа» →
«Ничего не ждёт вашего ответа»), the same precedent that `notifications-bell.tsx` makes for
«Уведомлений» → «Уведомлений нет».

### 10.2 Loading

`Skeleton` — 2-3 placeholder rows of a height close to a real row (`h-16 rounded-md`, not an `h-24`
card as a whole — several narrow rows more honestly reflect the future content than one large
plate). `data-testid="pending-loading"`.

### 10.3 Error

The same minimalist pattern as `DropBalanceCard.tsx`: centered text +
a `variant="ghost"` button «Повторить» — I do not invent a new wording, «Повторить» is already project vocabulary
(`DropBalanceCard.tsx`, `TosPdfPreview.tsx`, `ContractPdfPreview.tsx`, `CascadeImpactPanel.tsx`
— 4 independent precedents, one word). `data-testid="pending-error"`.

```
        Не удалось загрузить список. [Повторить]
```

### 10.4 Overflow — an 80-character project name

Demonstrated in `design.html` View 1 (the second row of the «Проекты» section): `<640px` the heading is
`line-clamp-2` + `overflow-wrap: anywhere` (the `wrap-anywhere` class, the same device that
`notifications-bell.tsx` already uses for long strings — rationale there too: `break-word` is
excluded from the intrinsic-size calculation by the CSS Text spec, `wrap-anywhere` is not). `≥640px` — a single line with
`truncate` (ellipsis), since the width is already enough not to spend vertical space on a second row.
The buttons at the same time are NOT squeezed and not cut off — they are in a separate flex-item with `flex: none`, the long
heading «squeezes» only itself, not its neighbors (the same `min-w-0`+`flex-1` on `.item-main` already
covered in the §6 skeleton).

---

## 11. Motion

Per `foundation.md` §7 (only `transform`/`opacity`, 150–300ms, ease-out):

- **Zone/section entrance on mount** — the same pattern as `PendingProjectApprovalsPanel.card`
  (`{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.3, ease:
[0.25, 0.1, 0.25, 1] } } }`) — reused literally (import `card` from that file or
  copy the constant — the Coder's decision, the behavior is the same).
- **A row disappearing after an action** (AC4 — «the row disappeared») — `AnimatePresence` around
  `.kind-list`, each row is a `motion.div` with `layout` (neighboring rows smoothly take the freed
  space) and `exit={{ opacity: 0, height: 0 }}`. Duration 200ms, the same range as the other
  panel transitions (§7 of foundation.md).
- **`prefers-reduced-motion`** — framer-motion respects the system setting out of the box with
  `useReducedMotion()`/a global `MotionConfig`, if it is already configured at the app level; if not
  — the Coder adds `transition: { duration: shouldReduceMotion ? 0 : 0.2 }` on exit/enter right here (do not
  invent a new mechanism, foundation.md §7 already requires respecting this flag).
- **No animation on the counter badge** of the nav item — the number just changes (does not «jump»/is not
  animated by digits) — excessive animation on a permanently visible element is not needed.

---

## 12. A11y (WCAG 2.2 AA) — skill `accessibility`

- **Semantics.** `<main>`/sections — regular `<section>`+`<h2>` (zone)/`<h3>` (kind) instead of bare `div`s;
  headings — real level headings, not decorative text with a similar class (even though the
  page has no `<h1>` — this does NOT mean the absence of a heading hierarchy altogether, it is just that the top
  level of the page does not duplicate what is already said in the nav; `<h2>` is a valid start of the hierarchy inside
  `<main>`).
- **Focus.** Every interactive unit (`Button`, `Link`) already carries
  `focus-visible:ring-2 focus-visible:ring-ring` through the shadcn base classes — not touched. The focus
  order — top to bottom, left to right, natural DOM order (the section heading is not focusable,
  the first focusable unit in a row is the button).
- **Target size (SC 2.5.8).** 24×24 CSS px is the general a11y minimum; at `<sm:` (mobile) — 44×44,
  stricter (see §9.2). The link in the popup footer (§8) and the «Открыть» buttons also fall under it, not only
  approve/reject.
- **Live region for a disappearing row (SC 4.1.3, status messages).** The toast (`sonner`) for the user's own action
  is already announced — but visually the row itself disappears from the DOM synchronously with this same event (AC4), and
  a screen-reader user who is INSIDE the row (e.g. on the «Подтвердить» button at the moment of the
  click) may lose focus into nowhere if the DOM node holding focus disappears. Recommendation:
  after a successful mutation, focus is moved to the nearest remaining element (the next row of the same
  section, or the section heading itself if the row was the last) — the same pattern that modals are
  already required to follow on close (focus returns to the trigger), only here the trigger disappeared along with the
  row, so the target is the next logical element, not `document.body`.
- **A counter under aria-live is not needed separately** — the very fact that the row disappeared (plus the toast «Проект
  подтверждён» / its analogue for a share) already reports the result; a duplicate `aria-live` paragraph with the text
  «Осталось: N» would add noise without new information (unlike `project-status-filter.md` §10, where the
  list stays in place and is merely re-filtered — here the unit leaves for good, the difference is
  substantial).
- **Icon-only.** There are none in the rows of this screen themselves (`ProjectApprovalActions`,
  `CancelPendingShareButton` already carry `aria-label`/`title` for the cases when the text is hidden by `compact`
  — compact mode is not connected here, see §6.1). In the nav item — the icon ALWAYS with visible text
  (desktop expanded + mobile Sheet), except the sidebar's `collapsed` state, where there is already a ready
  `Tooltip` pattern (`DesktopNavLink`, §0) — the new item inherits it for free, nothing needs to be added.
- **Contrast.** `amber-400`/`amber-300` on `bg-amber-500/[0.06]`/`bg-muted/20`, `emerald-400`/
  `destructive` on transparent/`bg-transparent` — the same pairs that are already used and received no
  contrast findings on the dark theme in the three source components (§0.2-0.3). No new measurements are required
  — the tonality is identical.
- **Table semantics are NOT introduced** (see §9) — so `role="table"`/`aria-rowindex` etc. are not
  needed either; the list is a regular `<ul>`/`<li>` inside `PendingKindSection`, each row is an `<li>` (not a bare
  `div` — a list remains a list for screen-reader navigation by elements, «3 items in the list» is
  announced natively).

---

## 13. Designer assumptions (A1 — reversible, not escalated)

These decisions are mine, not an override of something already decided by the orchestrator/owner (those are in the task file,
the «Assumptions» section, not repeated here).

1. **Sections, not tabs** (§3) — reversible, a purely client-side layout choice.
2. **A line-by-line list, not `<table>`** (§9) — reversible, follows the existing convention of the three
   reused components of this same screen.
3. **`CrmDialogContent` instead of a dedicated bottom-sheet** (§9.1) — reversible, follows the existing
   use of the same dialog in the same three components.
4. **The «ответ» copy family, not «решение»** — the assignment already fixes «Ожидают ответа» (heading/route) and
   «Ждут ответа других» (the ADMIN section text) verbatim — I carry this same family through to the heading «Ждёт
   вашего ответа» (the mine zone) and the popup footer text («Всё, что ждёт ответа»), and do NOT mix it with the word
   «решение», which the existing `PendingProjectApprovalsPanel` widget uses today («Ждёт вашего
   решения»). This deliberately leaves a visible divergence between the new screen and the old widget on ONE
   and the same navigation panel (the widget already links to this same screen per the assignment's «Assumption») — see §14,
   open question 1.
5. **Names in `waitingFor` comma-separated, without «и» before the last** — the most neutral option,
   grammatically safe for any number/gender of names; the final word is `copy-reviewer`'s.
6. **No avatars in the rows** — `PendingItem` does not carry `avatarDocumentId`/`avatarUrl` (only a name
   as a string), and I do not ask to add them: this list is scanned first by the project name/action type,
   the name is secondary context, not worth weighing down the API response with extra
   fields/joins. `PendingProjectApprovalsPanel` (a direct precedent for the same task) does not
   show avatars either.

---

## 14. Open questions (for PM/owner — with a recommendation for each)

**Question 1 — the terminological divergence «ответ» (new screen) vs «решение» (the existing
`PendingProjectApprovalsPanel` widget).** Backlog item 168 already records a similar finding on the NEIGHBORING
surface (`/projects` tab label «На подтверждении» vs the badge «Ждёт решения») and recommends
converging on «Ждут решения». My spec for the NEW screen converges on a different word («ответ»), because
it is already fixed twice in the assignment itself (the route heading + the ADMIN section text) — I do not
relitigate the orchestrator's already accepted A1 decision. But after this PR, on one navigation panel there will
live simultaneously «Ждёт вашего решения» (the dashboard widget, untouched by this task except for the data
source) and «Ждёт вашего ответа» (this screen, which the widget now explicitly links to with «все →») —
a visible divergence exactly where these two texts can fall into the same field of view.
**I recommend:** as a separate line in the same task (or immediately a follow-up) rename the heading of
`PendingProjectApprovalsPanel` from «Ждёт вашего решения» to «Ждёт вашего ответа» — this is one line in
a file that this same task touches anyway (SR-L-6, changing the widget's data source). The decision does not
block Mode B of this PR (the divergence is not in new code but in the neighboring old one), but it is worth closing in the same
cycle rather than postponing to a separate backlog item.

**Question 2 — `SeniorShareApprovalActions` (§5.2 item 1): where to put the shared approve/reject hook for
project-scope.** A technical choice between «export the inline mutations from `$projectId.tsx`» and
«generalize the `use-user-profile.ts` pair under a `scope` parameter, symmetrically to `useCancelPendingShare`».
**I recommend** the second — consistency with the same fork already solved in `cancel-pending-share.tsx`, one
source file for all three actions on senior-share (`approve`/`reject`/`cancel`) instead of being spread across
three places. Not a design decision in essence (changes nothing on the screen), but it affects the file
structure the Coder will write — I leave it as a recommendation, not a mandate.

**Question 3 — the position of the nav item in the `NAV_ITEMS` list.** I specified «after Dashboard» as a reasonable default
(§7), did not check with the owner. Cheap to change, does not block implementation.

---

## 15. Checklist for Coder (a summary, does not duplicate the sections above)

- [ ] `apps/web/app/routes/_authenticated/pending/index.tsx` — a new route, `data-testid="pending-page"`,
      without `<h1>` (§0.5, §3).
- [ ] `route-access.ts`: `{ prefix: '/pending', roles: ALL_ROLES }`.
- [ ] `nav-sidebar.tsx`: a new `NavItem` + a 0/1–9/99+ badge (§7), the same visual as
      `notifications-bell-badge`.
- [ ] `notifications-bell.tsx`: ONE insertion — a `<footer>` with a link to `/pending` after `</ul>` (§8).
- [ ] A new `SeniorShareApprovalActions` modeled on `ProjectApprovalActions` (§5.2 item 1, §14 question 2).
- [ ] `PendingKindSection`/`PendingItemRow` — presentational, a switch on `kind`, a `default` branch for an
      unknown kind (§6.5).
- [ ] Reuse literally: `ProjectApprovalActions`, `CancelPendingShareButton`,
      `formatDistanceToNow(…, { locale: ru })`, the `PendingProjectApprovalsPanel.card` motion constant.
- [ ] `lg:max-w-6xl` without `mx-auto` on the content area (§0.5, §9).
- [ ] `flex-wrap` on `.item-row` and `flex: none` on the actions block — mandatory, not optional (the
      QA-H-2 defect class on #646, §6).
- [ ] `pendingPercent` = `effectivePercentAfterApproval`, not the raw `percent` (§2 — otherwise an empty cell
      on clear-override proposals).
- [ ] AnimatePresence + exit on a row disappearing after an action (§11) + focus return (§12).
- [ ] Empty/loading/error/overflow — per §10, `data-testid` as specified.
- [ ] DO NOT touch: contract signing (stays in `ContractTab`/`ContractActionBar`), rendering notifications
      by type (position 6), channel settings (7b), emails (7a).

---

## Screenshots / references

- `docs/design/assets/pending-screen/design.html` — the static mockup (source, three states + reference).
- `docs/design/assets/pending-screen/design-320.png` — mobile.
- `docs/design/assets/pending-screen/design-768.png` — tablet.
- `docs/design/assets/pending-screen/design-1440.png` / `design.png` — large screen (the main fidelity
  reference).

Captured with headless Chromium (Playwright, `fullPage`) directly from `design.html` — without a dev stack, without
Claude Design (design-gate: degraded, see the file header).
