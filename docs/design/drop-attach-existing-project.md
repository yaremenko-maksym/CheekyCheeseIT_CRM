# Design Spec: Attaching / detaching a drop on the «Состав» tab of the project page

> **Mode:** E — Reconciliation / conformance (a text spec, without a Claude Design round)
> **Design-gate:** degraded (headless, text-only conformance) — Chrome MCP / Claude Design is unavailable in the isolated agent environment.
> **Tier:** 2 (an edit of an existing screen — the «Состав» tab of the project page)
> **Slug:** `drop-attach-existing-project`
> **Author:** ui-ux-designer · 2026-07-12
> **Depends on:** `docs/design/foundation.md` · `docs/design/drop-role-ux.md`
> **Implements task:** `.claude/tasks/task-drop-attach-design.md`

---

## 1. Brief (context)

In production it is impossible to attach a drop to an **existing** project. Attaching a drop on creation
works (the `projects/index.tsx` form, lines ~688–719), but after creation — it does not.

The backend already supports `PATCH /projects/:id { dropId: string | null }`. The UI gap:
the «Состав» tab (`ProjectEffectiveTeamCard`) shows the drop read-only, without actions.
The «Добавить участника» button on the «Обзор» tab uses `POST /projects/:id/members`
and does not fit a drop (400 «Only JUNIORs, HRs, and ACCOUNTANTs can be added as project
members»).

**Decision:** extend the «Состав» tab with two capabilities:

1. **Attach a drop** when `project.dropId === null` — a button + a picker dialog.
2. **Detach a drop** when `project.dropId !== null` — an icon button on the drop's row + a confirm dialog.

These actions live on the «Состав» tab, are driven by a separate mutation
(`PATCH /projects/:id`), and do not intersect with the mechanics of adding regular members.

---

## 2. What does NOT change (conformance check)

- `ProjectEffectiveTeamCard` — the flat list structure, role badges, navigation to profiles.
- The `availableToAdd` filter on the «Обзор» tab — candidates for regular members.
- `MemberRow` — the regular member row component.
- The «Добавить участника» dialog on the «Обзор» tab — do not touch.
- RBAC for the existing actions (`canManage`, `canRemoveMembers`).
- The style of the blue «Дроп» / «Drop-проект» badge in the project header.

---

## 3. Token map

All tokens from `apps/web/app/styles/globals.css` (`@theme inline {}`). **No new tokens are introduced.**

| Purpose                                  | Tailwind class                                                                                  | Reason                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Card background                          | `bg-card`                                                                                       | `ProjectEffectiveTeamCard` — already `bg-card`          |
| Card border                              | `border-border/40`                                                                              | matches the existing `border-border/40`                 |
| Primary text                             | `text-foreground`                                                                               | the drop's name in the row                              |
| Secondary text / icons                   | `text-muted-foreground`                                                                         | the «detach» button icon in the neutral state           |
| Hover of a destructive icon              | `hover:text-destructive`                                                                        | the `MemberRow` pattern, line ~1599                     |
| Ghost icon button                        | `variant="ghost" size="icon"`                                                                   | the `MemberRow` delete button pattern                   |
| Icon button size (row)                   | `h-5 w-5`                                                                                       | matches `MemberRow` line ~1599                          |
| Icon inside the icon button              | `h-3 w-3`                                                                                       | matches `MemberRow` line ~1600                          |
| «Привязать дропа» button (header card)   | `h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground` + `variant="ghost" size="sm"` | the «Добавить» pattern of the Команда card, line ~1020  |
| Candidate row in the picker              | `flex items-center gap-2.5 rounded-md px-3 py-2`                                                | the Add Member Dialog pattern, line ~1263               |
| Candidate avatar in the picker           | `h-7 w-7 shrink-0`                                                                              | the Add Member Dialog pattern, line ~1264               |
| «Назначить» button in the picker         | `size="sm" h-7 text-xs px-2.5 shrink-0 variant="default"`                                       | the «Добавить» button pattern in the picker, line ~1280 |
| «Назначен» state in the picker           | `variant="outline" text-emerald-500 border-emerald-500/40`                                      | the isAdded pattern, lines ~1284–1285                   |
| Confirm dialog                           | `CrmDialogContent maxWidth="sm:max-w-sm"`                                                       | the Remove Member Dialog pattern, line ~1208            |
| The drop badge in the effective team row | `variant="outline" border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px]`         | existing lines 1764–1768                                |
| Radius of buttons inside the card        | `rounded-md`                                                                                    | concentric radius (Foundation §3)                       |

---

## 4. Components (existing shadcn/ui)

All components are from those already used in the file. **No new components are created.**

| Component                                               | Usage                                                                   | Source in code                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Button` `variant="ghost" size="icon"`                  | The «detach drop» icon button in a `ProjectEffectiveTeamCard` row       | `MemberRow` ~1596–1604                                          |
| `Button` `variant="ghost" size="sm"`                    | The «Привязать дропа» button in the `ProjectEffectiveTeamCard` header   | The «Добавить» button in the Team card ~1017–1029               |
| `Tooltip` + `TooltipTrigger` + `TooltipContent`         | A hint when `project.archivedAt` or there are no candidates             | Team card ~1014–1035                                            |
| `Dialog`                                                | The drop picker dialog + the detach confirm (two separate `<Dialog>`s)  | `addMemberOpen` Dialog ~1241, `removeMemberTarget` Dialog ~1207 |
| `CrmDialogContent`                                      | The dialog wrapper (fixed header/body/footer, scrollable body)          | lines ~1168, ~1208, ~1247                                       |
| `CrmDialogHeader` / `CrmDialogBody` / `CrmDialogFooter` | Dialog structure                                                        | existing dialogs                                                |
| `DialogTitle` / `DialogDescription`                     | The dialog title and a11y description                                   | existing dialogs                                                |
| `Avatar` + `AvatarFallback` + `AvatarImage`             | The drop's avatar in the picker                                         | Add Member Dialog ~1264–1268                                    |
| `Badge`                                                 | The «Дроп» role badge in the picker (blue info style) + in the team row | lines 1763–1769 (team), 1274–1279 (picker)                      |
| `UserPlus` (lucide)                                     | The icon in the «Привязать дропа» button                                | Team card ~1027                                                 |
| `UserMinus` (lucide)                                    | The icon in the drop detach button in the row                           | `MemberRow` ~1600                                               |
| `useMutation` (TanStack Query)                          | The `PATCH /projects/:id { dropId }` mutation for attach/detach         | `editMutation` ~579–586 (the same mutation)                     |

---

## 5. Architectural decision

### 5.1 Mutation

The Coder MUST use the **existing `editMutation`** (lines ~579–586) or create
a separate `dropMutation` — both options are correct. A separate mutation is recommended for
clarity and an independent `isPending` state of the detach button:

```ts
const dropMutation = useMutation({
  mutationFn: (dropId: string | null) =>
    api.patch<ProjectDto>(`/projects/${projectId}`, { dropId }).then((r) => r.data),
  onSuccess: () => {
    void qc.invalidateQueries({ queryKey: ['projects', projectId] })
    void qc.invalidateQueries({ queryKey: ['projects'] })
    setDropPickerOpen(false)
    setDetachDropConfirmOpen(false)
  },
})
```

### 5.2 Candidate data (DROP users)

Reuse the already loaded `allUsers` (line ~613–617, `queryKey: ['users']`,
enabled `canManage`). DROP candidates = `(allUsers ?? []).filter(u => u.role === 'DROP')`.

**Important:** `allUsers` is already fetched when `canManage` (ADMIN/HR). Attaching a drop is only
for `canManage`, so the data will be available.

### 5.3 The «drop already assigned» state — a UX decision

**Decision: HIDE DROP candidates from the picker when `project.dropId !== null`.**

Reasoning:

- The «Привязать дропа» picker opens only when `project.dropId === null` (the button is
  hidden/disabled otherwise). The scenario «there is a drop, but the picker is open» is impossible with a correct
  UI gate.
- The «Привязать дропа» button in the card header is NOT shown if `project.dropId !== null`
  (conditional render).
- This is cleaner UX than disabled rows with a hint — it does not overload the list.

Separately: the `availableToAdd` filter on the «Обзор» tab (lines ~694–702) already excludes
ADMIN/SENIOR, but does NOT exclude DROP. The Coder MUST add to `availableToAdd`:

```ts
if (u.role === 'DROP') return false // DROP is not added via /members
```

This prevents a 400 from the API when trying to add a drop via the regular member picker.

---

## 6. Detailed UI spec by state

### 6.1 State A: the project has no drop (`project.dropId === null`)

**In `ProjectEffectiveTeamCard` (CardHeader, lines ~1717–1723):**

```
┌─ CardHeader pb-3 ─────────────────────────────────────────────┐
│  Эффективный состав  (HR/accountant — from the senior's current team)
│                                              [+ Привязать дропа]│  ← new button
└───────────────────────────────────────────────────────────────┘
```

The «Привязать дропа» button:

- Render condition: `canManage && !project.archivedAt && project.dropId === null`
- `variant="ghost" size="sm"`, classes: `h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground`
- Icon: `<UserPlus className="h-3 w-3" />` + the text «Привязать дропа»
- On click: `setDropPickerOpen(true)`
- If there are no DROP users in the system: wrap in `Tooltip` + `TooltipContent` «Нет активных дропов»
  and disable (`disabled={dropCandidates.length === 0}`)
- `data-testid="attach-drop-btn"`

**In the card body (the line after `senior && juniors.length === 0`):**

No drop → do not show a «placeholder» (do not add an empty row «Дроп не назначен»).
The list is already clear — senior, HR, accountants, juniors. An empty state for the drop is superfluous.

### 6.2 State B: the project has a drop (`project.dropId !== null`)

The drop's row in `flatMembers` is already rendered via the regular mapping (lines ~1670–1680,
~1763–1769). **Change:** add a detach button to the drop's row — by analogy with
`MemberRow` (lines ~1595–1604).

The drop's row in `ProjectEffectiveTeamCard` should become:

```tsx
{m.role === 'DROP' ? (
  <Link/div ...>   {/* avatar + name + badge — as now */}
    {rowContent}
  </Link/div>
  {canManage && !project.archivedAt && (
    <Button
      variant="ghost"
      size="icon"
      className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
      aria-label="Снять дропа с проекта"
      data-testid="detach-drop-btn"
      onClick={() => setDetachDropConfirmOpen(true)}
    >
      <UserMinus className="h-3 w-3" />
    </Button>
  )}
) : (
  /* the regular badge for non-DROP roles */
)}
```

**Technical detail:** the current `rowContent` is `<>...</>` without an outer container.
The detach button must be OUTSIDE `rowContent`, at the level of the row's `Link`/`div` wrapper.
The Coder must restructure the drop row's rendering so that the detach button is a
sibling of `rowContent` inside the flex container:

```tsx
return isNavigable ? (
  <Link
    key={m.key}
    ...
    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors"
  >
    {rowContent}
    {m.role === 'DROP' && canManage && !project.archivedAt && (
      <Button ... onClick={...} >
        <UserMinus className="h-3 w-3" />
      </Button>
    )}
  </Link>
) : (...)
```

**The «Привязать дропа» button in CardHeader:**
NOT shown when `project.dropId !== null` — conditional render.

### 6.3 State C: the project is archived (`project.archivedAt !== null`)

Both buttons (attach / detach) are NOT rendered. Condition: `!project.archivedAt` in both places.
The drop row stays read-only, visible as usual.

---

## 7. The «Привязать дропа» dialog (DropPickerDialog)

```
┌─ CrmDialogContent maxWidth="max-w-sm" ───────────────────────┐
│  CrmDialogHeader                                              │
│    DialogTitle: «Привязать дропа»                             │
│    DialogDescription sr-only: «Выбор дропа для проекта»      │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogBody                                                │
│  ┌ max-h-72 overflow-y-auto space-y-1.5 ───────────────────┐ │
│  │  [if there are no candidates]                                   │ │
│  │  <p className="text-sm text-muted-foreground py-2">      │ │
│  │    Нет доступных дропов                                  │ │
│  │  </p>                                                    │ │
│  │                                                          │ │
│  │  [for each DROP candidate]                            │ │
│  │  div flex items-center gap-2.5 rounded-md px-3 py-2     │ │
│  │    Avatar h-7 w-7                                        │ │
│  │      AvatarFallback text-[10px]                          │ │
│  │      AvatarImage src={u.avatarUrl}                       │ │
│  │    div min-w-0 flex-1                                    │ │
│  │      p text-sm font-medium truncate — displayName        │ │
│  │      p text-xs text-muted-foreground truncate — email    │ │
│  │    Badge variant="outline"                               │ │
│  │      className="border-blue-500/30 bg-blue-500/10        │ │
│  │               text-blue-400 shrink-0 text-[9px]"         │ │
│  │      «Дроп»                                              │ │
│  │    Button size="sm"                                      │ │
│  │      variant={isAssigned ? 'outline' : 'default'}        │ │
│  │      className={cn('shrink-0 h-7 text-xs px-2.5',        │ │
│  │        isAssigned && 'text-emerald-500 border-emerald-500/40')} │ │
│  │      disabled={isAssigned || dropMutation.isPending}     │ │
│  │      onClick={() => dropMutation.mutate(u.id)}           │ │
│  │      aria-label={`Назначить ${u.displayName} дропом`}   │ │
│  │      data-testid={`assign-drop-btn-${u.id}`}             │ │
│  │      {isAssigned ? 'Назначено' : dropMutation.isPending ? '...' : 'Назначить'} │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

**Behavior after assignment:**

- The mutation succeeded → the dialog closes (`setDropPickerOpen(false)`) via `onSuccess`.
- `invalidateQueries` for `['projects', projectId]` → the card redraws with the new drop.
- A toast is not mandatory (existing code does not always use a toast for PATCH).
- While `isPending` = the only request in flight → the button is disabled.

**No candidates (empty state):**
`dropCandidates.length === 0` → show «Нет доступных дропов» in the dialog body.
The «Привязать дропа» button in CardHeader is disabled with a Tooltip in this case.

---

## 8. The «Снять дропа» dialog (DetachDropConfirmDialog)

Exactly modeled on the Remove Member Dialog (lines ~1207–1238):

```
┌─ CrmDialogContent maxWidth="sm:max-w-sm" ────────────────────┐
│  CrmDialogHeader                                              │
│    DialogTitle: «Снять дропа?»                                │
│    DialogDescription sr-only: «Подтверждение снятия дропа»   │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogBody pb-2                                           │
│  <p className="text-sm text-muted-foreground">                │
│    <span className="font-medium text-foreground">             │
│      {drop?.displayName}                                      │
│    </span>{' '}                                               │
│    будет снят с проекта. Приходы больше не будут              │
│    проходить через него.                                      │
│  </p>                                                         │
├───────────────────────────────────────────────────────────────┤
│  CrmDialogFooter                                              │
│    Button variant="outline" onClick={() => setDetachDropConfirmOpen(false)} │
│      «Отмена»                                                 │
│    Button variant="destructive"                               │
│      onClick={() => dropMutation.mutate(null)}                │
│      disabled={dropMutation.isPending}                        │
│      data-testid="detach-drop-confirm-btn"                    │
│      «Снять»                                                  │
└───────────────────────────────────────────────────────────────┘
```

**Behavior:**

- `dropMutation.mutate(null)` → `PATCH /projects/:id { dropId: null }` → the drop's row disappears from the card.
- The dialog closes via `onSuccess`.

---

## 9. Responsive behavior (4 device classes)

The «Состав» tab — `ProjectEffectiveTeamCard` — is already a `Card` without a grid. The new elements
are embedded in the existing structure. **Mobile-first.**

### 9.1 Mobile (320 / 375px)

- **CardHeader** with the «Привязать дропа» button: `flex items-center justify-between` is already there
  at the CardHeader level (as in the Team card). The button fits on the right even at 320px (`shrink-0`).
- **The drop row with a detach button**: `flex items-center gap-2.5`. The drop's name is `truncate flex-1` —
  truncated when space is short. The icon button `h-5 w-5 shrink-0` — a fixed size,
  not pushed out. At 320px `min-w-0` may be needed on the name span (already present in `rowContent`
  via `truncate flex-1`).
- **The drop picker dialog at 320px**: `CrmDialogContent` with `max-w-sm` — at 320px it takes
  almost the whole width (300px content + padding). `max-h-72 overflow-y-auto` — the list
  scrolls. The «Назначить» button `h-7` = 28px height; add `min-w-[72px]` so that it does not
  «collapse» with a long name (the text is truncated by `truncate`).
- **Touch targets:**
  - The «Привязать дропа» button: `h-7` = 28px — below the ≥44px mobile minimum. **Increase
    the hit area** via `p-2` or use `h-9` on mobile: `className="h-7 sm:h-7"` plus
    a `<span className="flex items-center">` wrapper with `p-2 -m-2` (expanding the touch area without
    changing the visible size). A simpler alternative: `size="sm"` is already `h-9` in shadcn/ui — check the
    real size in the `button.tsx` variants. If `h-7` is the default — add the class
    `min-h-[44px] sm:min-h-0 px-2 sm:px-1.5` for mobile.
  - The detach button `h-5 w-5` — clearly below 44px on mobile. The `MemberRow` pattern is the same.
    Wrap in `<span className="flex items-center justify-center p-2 -m-2">` to expand the
    touch area to ≈36px without changing the visuals. The class `touch-target-expand` can be used
    if defined in globals.css, otherwise the inline-padding trick.
  - The «Назначить» buttons in the picker `h-7` = 28px — likewise touch expansion or `min-h-[44px]` with
    `sm:min-h-0`.

### 9.2 Tablet (768px)

- Layout unchanged (a Card in one column in the content area).
- CardHeader with the button — there is enough room.
- The `max-w-sm` dialog = 384px — comfortable.

### 9.3 Laptop (1024 / 1280px)

- The «Состав» tab at 1024px: `ProjectEffectiveTeamCard` at the full width of the content area
  (or in an `lg:grid-cols-2` grid if such a layout exists — check in the code).
- Per the code: with `activeTab === 'members'` only `<ProjectEffectiveTeamCard>` is rendered without an
  additional grid (line ~917–922). So the card stretches to the full width.
- The buttons are comfortable, no overflow risk.

### 9.4 Large (1440 / 1920px)

- Same as 1024px — unchanged. `ProjectEffectiveTeamCard` is bounded by the content area.

### 9.5 The dialog at all widths

`CrmDialogContent` uses `max-h-[90dvh]` and a scroll body — reliable on all devices.
At 320px the dialog width ≈ `min(calc(100vw - 32px), 384px)` = ~288px. The candidate list
scrolls correctly via `overflow-y-auto`.

---

## 10. Edge cases

| Case                                                         | Behavior                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| No DROP users in the system                                  | The «Привязать дропа» button is disabled + Tooltip «Нет доступных дропов». The dialog does NOT open.                                           |
| One DROP user in the system                                  | The picker shows one row. After assignment — state B.                                                                                          |
| A drop is already assigned                                   | The «Привязать дропа» button is NOT shown. The drop row with the «detach» button.                                                              |
| The project is archived (`archivedAt !== null`)              | Both buttons are hidden. The drop row is read-only. The pattern matches `canManage && !project.archivedAt` in the Team card.                   |
| `allUsers` not loaded (loading)                              | The «Привязать дропа» button is disabled while `canManage && !allUsers`. Or `dropCandidates.length === 0` → Tooltip.                           |
| PATCH mutation in flight                                     | The «Снять» button is disabled (`dropMutation.isPending`). The «Назначить» button in the picker is disabled.                                   |
| PATCH API error                                              | The dialog stays open. Show an error toast via `onError`. The button goes from `'...'` back to its original state.                             |
| `project.dropId !== null`, but `effectiveTeam.drop === null` | API inconsistency: show the fallback «Дроп назначен, данные недоступны» at the drop's position. The «detach» button is active (dropId is set). |
| Viewer = DROP (the drop themselves views the project)        | `canManage` = false → both buttons are not rendered. The drop row is read-only (as now).                                                       |
| Viewer = SENIOR / ACCOUNTANT / JUNIOR                        | `canManage` = false → the buttons are not rendered.                                                                                            |

---

## 11. A11y (WCAG 2.2 AA)

### 11.1 Target size (SC 2.5.8 — minimum 24×24px; on mobile we aim for ≥44px)

| Element                                       | Visual size      | Touch area                                                                           | Status                       |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ | ---------------------------- |
| The «Привязать дропа» button (ghost sm)       | `h-7` = 28px     | Add `min-h-[44px] sm:min-h-0` OR the padding trick `p-2 -m-2`                        | Needs adjustment on mobile   |
| The «detach drop» button (ghost icon h-5 w-5) | 20×20px visually | Add a wrapper `flex items-center justify-center p-2.5 -m-2.5` → ≈ 44×44px touch area | Needs adjustment on mobile   |
| The «Назначить» button in the picker (sm h-7) | 28px             | Add `min-h-[44px] sm:min-h-0`                                                        | Needs adjustment on mobile   |
| «Снять» in the confirm dialog (destructive)   | `h-9` = 36px     | ≥ 24px — WCAG-OK; on mobile 36px is sufficient                                       | OK (close to 44, acceptable) |
| «Отмена» in the confirm dialog (outline)      | `h-9` = 36px     | OK                                                                                   | OK                           |

### 11.2 Contrast (SC 1.4.3)

| Element                                                          | Foreground                            | Background       | Status      |
| ---------------------------------------------------------------- | ------------------------------------- | ---------------- | ----------- |
| The drop's name `text-foreground` on `bg-card`                   | `--foreground` L~0.97                 | `--card` L~0.12  | >10:1 PASS  |
| The «Дроп» badge `text-blue-400` on `bg-blue-500/10` + `bg-card` | blue ~L0.65                           | dark card ~L0.12 | ~4.5:1 PASS |
| Button `text-muted-foreground` ghost                             | `--muted-foreground` L~0.58           | `bg-card`        | ~4.8:1 PASS |
| Button `hover:text-destructive`                                  | `--destructive` L~0.58                | `bg-card`        | ~4.8:1 PASS |
| «Снять» variant="destructive"                                    | `--destructive-foreground` near-white | `--destructive`  | >4.5:1 PASS |

### 11.3 Focus (SC 2.4.11)

- All buttons — shadcn/ui `Button` with `focus-visible:ring-2 focus-visible:ring-ring` — PASS out of the box.
- Dialog: `CrmDialog` (shadcn/ui `Dialog`) already implements a focus trap via Radix UI — PASS.
- Escape closes the dialog (Radix `Dialog`) — PASS.
- After the dialog closes focus returns to the trigger button (Radix default) — PASS.

### 11.4 Focus order (SC 1.3.2, 2.4.3)

On the «Состав» tab all the logic is in `ProjectEffectiveTeamCard`:

1. The «Привязать дропа» button in CardHeader (if visible).
2. The member rows (Link / div navigation to profiles).
3. The «detach drop» button in the drop row (if visible).

The DOM order matches the visual order — the order is correct.

### 11.5 Icon-only (SC 1.1.1)

| Element                                 | aria-label                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| The drop detach button (UserMinus icon) | `aria-label="Снять дропа с проекта"`                                                                                                           |
| The drop attach button (if icon only)   | Contains the visible text «Привязать дропа» — aria-label is not needed                                                                         |
| The «Назначить» button in the picker    | Contains visible text — aria-label is not needed. Additionally: `aria-label={Назначить ${u.displayName} дропом}` — recommended for unambiguity |

### 11.6 Semantics

- Dialogs: `DialogTitle` (mandatory, visible) + `DialogDescription` (sr-only) — a pattern from the codebase.
- The detach button — `<Button>`, not `<div onClick>` — a semantic interactive element.
- The candidate picker list: `div` rows without `<ul>/<li>` semantics — this is the pattern of the existing
  Add Member Dialog (~1263). The Coder may keep `div` for consistency, or wrap in `<ul>/<li>`.
  Recommendation: `<ul className="space-y-1.5">` + `<li>` for list semantics.

---

## 12. Exact code line references for reuse

| Pattern                                                              | File                 | Lines     |
| -------------------------------------------------------------------- | -------------------- | --------- |
| RBAC variables `canManage`, `canRemoveMembers`                       | `$projectId.tsx`     | 476–480   |
| The `allUsers` query (DROP candidates — already loaded)              | `$projectId.tsx`     | 613–617   |
| `addMemberMutation` (a mutation model) → replace with `dropMutation` | `$projectId.tsx`     | 619–639   |
| `editMutation` (a model of `PATCH /projects/:id`)                    | `$projectId.tsx`     | 579–586   |
| The «Добавить» button in the Team card (a CardHeader button model)   | `$projectId.tsx`     | 1013–1036 |
| The «Добавить участника» dialog (a picker model)                     | `$projectId.tsx`     | 1240–1301 |
| The «Убрать участника?» dialog (a confirm model)                     | `$projectId.tsx`     | 1206–1238 |
| The `MemberRow` delete button (an icon button model)                 | `$projectId.tsx`     | 1595–1604 |
| `ProjectEffectiveTeamCard` — the drop mapping                        | `$projectId.tsx`     | 1618–1817 |
| The DROP row in `flatMembers` (push)                                 | `$projectId.tsx`     | 1668–1680 |
| The DROP blue info badge                                             | `$projectId.tsx`     | 1763–1769 |
| Render of the `isNavigable` Link/div row                             | `$projectId.tsx`     | 1794–1813 |
| The Drop Select in the CREATE form (a badge + hints model)           | `projects/index.tsx` | 688–719   |
| The `availableToAdd` filter (add the `role === 'DROP'` exclusion)    | `$projectId.tsx`     | 694–702   |
| The `[addMemberOpen]` state (a state model for the new dialog)       | `$projectId.tsx`     | 490       |
| The `[removeMemberTarget]` state (a confirm dialog state model)      | `$projectId.tsx`     | 493       |

---

## 13. New state variables (add to `ProjectDetailPage`)

```ts
const [dropPickerOpen, setDropPickerOpen] = useState(false)
const [detachDropConfirmOpen, setDetachDropConfirmOpen] = useState(false)
```

Add next to `addMemberOpen` (line ~490).

---

## 14. New computed variables

```ts
// After line ~694 (next to availableToAdd)
const dropCandidates = (allUsers ?? []).filter((u) => u.role === 'DROP')
```

And the mandatory edit of `availableToAdd` (line ~694–702):

```ts
const availableToAdd = (allUsers ?? []).filter((u) => {
  if (u.role === 'ADMIN' || u.role === 'SENIOR') return false
  if (u.role === 'DROP') return false // ← ADD: a drop is not added via /members
  if (activeMembers.some((m) => m.userId === u.id)) return false
  if (u.role === 'JUNIOR') {
    if (hasActiveJunior) return false
    if (u.hasActiveProject) return false
  }
  return true
})
```

---

## 15. data-testid registry (for AutoTest)

| testid                     | What                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `attach-drop-btn`          | The «Привязать дропа» button in the effective team CardHeader |
| `attach-drop-dialog`       | The root element of the drop picker dialog                    |
| `assign-drop-btn-{userId}` | The «Назначить» button for a specific drop in the picker      |
| `detach-drop-btn`          | The «detach drop» button (UserMinus) on the drop row          |
| `detach-drop-dialog`       | The root element of the detach confirm dialog                 |
| `detach-drop-confirm-btn`  | The «Снять» button in the confirm dialog                      |

---

## 16. Russian texts (user-facing)

| Element                                                                   | Text                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Attach button (CardHeader)                                                | «Привязать дропа»                                                                   |
| Tooltip when there are no candidates                                      | «Нет доступных дропов»                                                              |
| Tooltip when the project is archived (not rendered, the button is hidden) | —                                                                                   |
| Picker DialogTitle                                                        | «Привязать дропа»                                                                   |
| Empty list in the picker                                                  | «Нет доступных дропов»                                                              |
| The «Назначить» button in the picker                                      | «Назначить» / «Назначено» / «…» (pending)                                           |
| Detach button aria-label                                                  | «Снять дропа с проекта»                                                             |
| DialogTitle of the detach confirm                                         | «Снять дропа?»                                                                      |
| Text in the confirm                                                       | «{displayName} будет снят с проекта. Приходы больше не будут проходить через него.» |
| The «Отмена» button in the confirm                                        | «Отмена»                                                                            |
| The «Снять» button in the confirm                                         | «Снять»                                                                             |

---

## 17. Handoff checklist for Coder

### Pre-implementation

- [ ] Read this spec and `docs/design/foundation.md` (tone: dense/quiet/operational).
- [ ] Find `$projectId.tsx` — the only file of changes.
- [ ] Check that `editMutation` (line ~579) accepts `dropId` via `UpdateProjectDto` from `@crm/shared` — if not, add the field to the Zod schema.
- [ ] Check that the `PATCH /projects/:id` endpoint accepts `{ dropId: string | null }` without additional required fields — the backend must support a partial update.
- [ ] The `allUsers` query `enabled: canManage` — candidates are already available when the picker opens.

### Implementation steps

1. Add to `ProjectDetailPage`:
   - 2 state variables (`dropPickerOpen`, `detachDropConfirmOpen`).
   - `dropMutation` (`PATCH /projects/:id { dropId }`) — next to `addMemberMutation`.
   - The `dropCandidates` computed variable.
   - Fix `availableToAdd` — exclude `role === 'DROP'`.
2. Change `ProjectEffectiveTeamCard`:
   - Accept extra props: `canManage: boolean`, `isArchived: boolean`, `onDetachDrop: () => void`.
   - Add the «Привязать дропа» button to CardHeader (conditional).
   - Add the detach button to the drop's row (conditional, only `m.role === 'DROP'`).
3. Add two dialogs (after the existing dialogs, line ~1301+):
   - `DropPickerDialog` (open=`dropPickerOpen`).
   - `DetachDropConfirmDialog` (open=`detachDropConfirmOpen`).
4. Pass the new props into `<ProjectEffectiveTeamCard>` when rendering on the «Состав» tab (lines ~917–922).

### Post-implementation WCAG verify

- [ ] The detach button has `aria-label="Снять дропа с проекта"`.
- [ ] The attach button is disabled with a Tooltip when there are no candidates.
- [ ] Both buttons are hidden on an archived project.
- [ ] At 320px check: the drop's name does not push out the detach button (truncate + shrink-0).
- [ ] The picker at 320px: `max-h-72 overflow-y-auto` — the list scrolls.
- [ ] Playwright screenshot: the «Состав» tab with a drop + without a drop at 375px and 1280px.

### Anti-slop check

- [ ] No new colors beyond the existing tokens (the blue badge is already used).
- [ ] No new radii — only `rounded-lg` / `rounded-md`.
- [ ] No `transition: all`.
- [ ] The «Дроп» badge — we use the existing `border-blue-500/30 bg-blue-500/10 text-blue-400`.
- [ ] No card in a card — picker rows in a `div`, not nested `Card`s.

---

## 18. Anti-patterns (do not allow)

- Do not add «Привязать дропа» to the «Добавить участника» dialog («Обзор» tab) — it is a separate endpoint and a separate UX path.
- Do not render «Дроп не назначен» as an empty row in the card — the absence of a drop reads from the absence of a row.
- Do not use `confirm()` instead of `Dialog` for the detach confirmation — it violates WCAG and a11y.
- Do not store the candidate list in a separate state — reuse `allUsers` (already loaded).
- Do not make the «Снять» button primary-yellow — it is a destructive action (`variant="destructive"`).
- Do not add a gradient or highlight to the drop row with an active button — tone: quiet/operational.

---

## 19. Build with OUR components

The Coder builds from this spec using **existing shadcn/ui components and Tailwind tokens**.
Do not copy HTML from external sources. Do not introduce new dependencies.
The only front-end file to change: `apps/web/app/routes/_authenticated/projects/$projectId.tsx`.

---

## 20. Addendum: 2026-07-13 — page padding + drop row in the Обзор team card

> **design-gate:** degraded (headless, text-only conformance — Chrome MCP / Claude Design unavailable)
> **Tier:** 3 (spot cosmetics — the wrapper padding + one row in the card)
> **Defects:** an owner report from a production screenshot (GamingTec, ADMIN, desktop)

---

### 20.1 Defect 1 — project page padding

#### Diagnosis

The page wrapper (line ~705 of `$projectId.tsx`):

```tsx
<div className="flex flex-col h-full min-h-0 overflow-y-auto px-0 pb-6">
  <div className="space-y-5">
    {/* ── Hero banner ── */}
    <motion.div className="relative overflow-hidden rounded-2xl border border-border/40 bg-card" ...>
      {/* hero content: logo + name + buttons + stat-chips */}
    </motion.div>

    {/* SegmentedToggle (tabs) */}
    {/* Active tab content */}
  </div>
</div>
```

`px-0` appeared in PR #231 for an edge-to-edge hero banner. A side effect: the tabs and all
content cards stuck to the viewport edges without padding.

For comparison — the sister `projects/index.tsx` line ~466–468 uses `px-6 pt-4 pb-6`
on a scrollable wrapper, and `foundation.md` §3 prescribes `p-4 md:p-6 lg:p-8` for
page padding.

#### Decision: **Option B** — the hero stays full-bleed, the sections below get the padding

**Rationale for choosing B:**

- A hero banner with `rounded-2xl` and an ambient glow blob is deliberately visually distinguished; clipping
  `rounded-2xl` by the viewport edges or narrowing to `px-4/px-6` would turn it into an ordinary card
  and lose the visual density intent (the page background would be visible only at the sides of the hero).
- Option A (a single padding on the whole wrapper) = the hero loses full-bleed. A loss of the memorable detail.
- Option B = the hero stays edge-to-edge, everything below (tabs + content cards) gets
  its own horizontal padding. Consistent with the pattern of other CRM pages (dashboard,
  finance), where a sticky header / hero takes the full width and the content has an indent.

#### Exact classes (mobile-first, Tailwind v4)

**The page wrapper** (line ~705) — remove `px-0`, the padding stays `0` at the wrapper level:

```tsx
// BEFORE:
<div className="flex flex-col h-full min-h-0 overflow-y-auto px-0 pb-6">

// AFTER (just remove px-0 — the default padding is already 0, an explicit px-0 is redundant and marks the intent):
<div className="flex flex-col h-full min-h-0 overflow-y-auto pb-6">
```

The hero `<motion.div>` (line ~708) — stays unchanged: `rounded-2xl border border-border/40 bg-card`.
It keeps full-bleed due to the absence of padding on the wrapper.

**`<div className="space-y-5">` inside the wrapper** — add horizontal padding,
but **exclude** the hero block. Achieved via `px-` on the individual child elements
below the hero. Scheme:

```
wrapper: pb-6 (no px)
  └── space-y-5
        ├── [hero motion.div]          ← NO px (full-bleed)
        ├── [SegmentedToggle]          ← px-4 sm:px-6
        ├── [ProjectEffectiveTeamCard] ← px-4 sm:px-6
        ├── [motion.div overview grid] ← px-4 sm:px-6
        ├── [ProjectLegendSection]     ← px-4 sm:px-6
        ├── [ProjectCredentialsSection]← px-4 sm:px-6
        └── [finance motion.div]       ← px-4 sm:px-6
```

Implementation: add `className="px-4 sm:px-6"` (or a wrapper `<div>`) to each
child block inside `space-y-5`, except the hero. A simpler alternative in code — wrap
everything below the hero in one container:

```tsx
<div className="flex flex-col h-full min-h-0 overflow-y-auto pb-6">
  <div className="space-y-5">
    {/* ── Hero banner — full-bleed, NO padding ── */}
    <motion.div className="relative overflow-hidden rounded-2xl border border-border/40 bg-card" ...>
      ...
    </motion.div>

    {/* ── Post-hero content — gets horizontal padding ── */}
    <div className="space-y-5 px-4 sm:px-6">
      {/* SegmentedToggle */}
      {/* Tab content: overview / members / finance */}
      {/* ProjectLegendSection */}
      {/* ProjectCredentialsSection */}
    </div>
  </div>
</div>
```

This is the most DRY option: one `px-4 sm:px-6` on one container, rather than on each child
element separately.

#### Per-breakpoint specification

| Width            | `px-` class        | Visual indent | Rationale                                                                  |
| ---------------- | ------------------ | ------------- | -------------------------------------------------------------------------- |
| 320–639 (mobile) | `px-4` (base)      | 16px          | Foundation §3: `p-4` for mobile; touch content does not stick to the edges |
| 640–1023 (sm)    | `sm:px-6`          | 24px          | Foundation §3: `md:p-6`; an analogue of `projects/index.tsx px-6`          |
| 1024+ (lg/xl)    | inherits `sm:px-6` | 24px          | Sufficient; the cards themselves have an inner `p-4/p-5/p-6`               |

`px-4 sm:px-6` is the minimal responsive padding, consistent with `foundation.md` §3 and
the existing `projects/index.tsx` (which uses a fixed `px-6`). For this
page with a hero we choose a slightly smaller mobile step (`px-4`) so that cards at 320px
do not end up too squeezed.

#### A11y / overflow

- No horizontal overflow when adding `px-4 sm:px-6` — flex/grid cards already
  use `min-w-0` and `truncate` on long strings.
- The hero at 320px stays full-bleed (0 px at the sides from the wrapper), `rounded-2xl` may
  «collapse» visually on a narrow screen — acceptable, the pattern is intentional (card-edge).

---

### 20.2 Defect 2 — the drop row in the «Команда» card («Обзор» tab)

#### Diagnosis

The «Команда» card (lines ~1006–1142 of `$projectId.tsx`) renders:
senior → HR → accountants → juniors → «Покинули проект».

Data about the drop: `project.dropId` (UUID | null) on the project object itself; `project.effectiveTeam.drop`
(an object with `id`, `displayName`, `avatarUrl`, `avatarDocumentId`, `role: 'DROP'`, `dropSharePercent`)
is available from the same `GET /projects/:id` request. The drop row is **not rendered** in «Команда» —
only on the «Состав» tab via `ProjectEffectiveTeamCard`.

#### Decision: a display-only drop row in the Team card

**Placement:** right after the senior block (lines ~1043–1072), before the HR block (~1074–1090).
Rationale: the drop is a financial intermediary between the client and the senior; it is logical to place it
next to the senior in the chain «client → drop → senior → junior».

**Render condition:**

```tsx
{project.effectiveTeam?.drop != null &&
  (user?.role === 'ADMIN' || user?.role === 'HR' || user?.role === 'ACCOUNTANT') && (
    /* the drop row */
)}
```

- `project.effectiveTeam?.drop != null` — we render only when a drop is actually attached
  (the API returned an object). For regular projects without a drop the row is absent — no empty
  slot «Дроп не назначен».
- RBAC: `ADMIN | HR | ACCOUNTANT` see it. `SENIOR | JUNIOR` — the API already returns
  `effectiveTeam.drop = null` (the mask, PR #363), the UI simply does not render (the condition fails).
- Variable: `const dropMember = project.effectiveTeam?.drop ?? null` — declare next
  to `const senior = ...` (~line 643) for clarity.

**Row structure** (copies the senior row pattern ~1043–1072 and the DROP-row pattern from
`ProjectEffectiveTeamCard` ~1763–1769):

```tsx
{
  dropMember != null &&
    (user?.role === 'ADMIN' || user?.role === 'HR' || user?.role === 'ACCOUNTANT') && (
      <div className="pb-3">
        <ProfileNameLink
          userId={dropMember.id}
          viewerRole={user?.role ?? 'JUNIOR'}
          className="flex items-center gap-2.5 hover:opacity-80 transition-opacity min-w-0"
        >
          <Avatar className="h-8 w-8 shrink-0">
            {dropMember.avatarUrl && (
              <AvatarImage src={dropMember.avatarUrl} alt={dropMember.displayName} />
            )}
            <AvatarFallback className="text-[11px] font-semibold">
              {getInitials(dropMember.displayName)}
            </AvatarFallback>
          </Avatar>
          <span className="text-sm font-medium truncate text-primary">
            {dropMember.displayName}
          </span>
          <Badge
            variant="outline"
            className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px] ml-auto"
          >
            Дроп
          </Badge>
        </ProfileNameLink>
      </div>
    )
}
```

**Key decisions:**

- `ProfileNameLink` with `userId={dropMember.id}` — navigable for ADMIN/HR/ACCOUNTANT (the same
  roles that see the row). The pattern from the senior row.
- No `ring-2 ring-[#6366f1]/30` on the avatar — this is a senior-specific style (a visual accent
  for the main subject), the drop gets a standard avatar without a ring.
- `ml-auto` on the Badge — pushes the badge to the right as with the senior (`ml-auto` on the Badge ~1067).
- The badge `border-blue-500/30 bg-blue-500/10 text-blue-400` — an identical pattern from
  `ProjectEffectiveTeamCard` line ~1764–1768 and from the project header line ~770–775.
  A single visual language «drop = a blue info badge» across the whole application.
- Display-only: no detach button (managing the drop is the «Состав» tab, spec §6–8).

**Insertion into the DOM between senior and HR** (lines ~1072–1075):

```tsx
{/* Senior row — lines ~1043–1072 (unchanged) */}
{senior != null && ( ... )}

{/* Drop row — NEW, after the senior, before HR */}
{dropMember != null &&
  (user?.role === 'ADMIN' || user?.role === 'HR' || user?.role === 'ACCOUNTANT') && (
  <div className="pb-3">
    {/* the drop row as above */}
  </div>
)}

{/* HR */}
<div className="pt-3 pb-3">
  ...
</div>
```

The `divide-y divide-border/30` divider on `CardContent` (~line 1039) will automatically
draw a line between the senior and the drop and between the drop and HR — no additional dividers
are needed.

#### Token map of the drop row

| Element         | Tailwind class                                            | Token                                                                               |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Drop name       | `text-sm font-medium truncate text-primary`               | `--color-primary`                                                                   |
| «Дроп» badge    | `border-blue-500/30 bg-blue-500/10 text-blue-400`         | raw Tailwind (no token for blue — we use the existing pattern from the header/team) |
| Avatar fallback | AvatarFallback default (`bg-muted text-muted-foreground`) | `--color-muted`                                                                     |
| Row hover       | `hover:opacity-80 transition-opacity`                     | compositor-friendly motion                                                          |
| Divider         | `divide-y divide-border/30` (inherited from CardContent)  | `--color-border`                                                                    |

**A note on blue:** `text-blue-400`, `bg-blue-500/10`, `border-blue-500/30` are not
tokenized colors, but this is a deliberate exception: the blue info color of the drop is already used
as a stable pattern in three places of the file (header ~770, effective team ~1764, create form)
and must be consistent. No new colors are introduced — we reuse the existing pattern.

#### A11y of the drop row

- `ProfileNameLink` with `userId` → renders an `<a>` or `<Link>` with a native focus ring — SC 2.4.11 PASS.
- An avatar with `alt={dropMember.displayName}` — SC 1.1.1 PASS.
- The row's target size: height ~40px (avatar h-8=32px + pb-3 padding) — SC 2.5.8 PASS (>24px).
- The badge contains the text «Дроп» — not icon-only, aria-label is not needed.

#### Edge cases of the drop row

| Case                                                                | Behavior                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `project.effectiveTeam?.drop == null` (no drop / a regular project) | The row is not rendered — no empty slot                                                                     |
| Viewer = SENIOR / JUNIOR                                            | The API returns `effectiveTeam.drop = null` (the PR #363 mask) → the condition is false → the row is hidden |
| Viewer = DROP (the drop themselves)                                 | `user?.role === 'DROP'` — not in the RBAC condition → the row is hidden                                     |
| `project.archivedAt !== null`                                       | The row is displayed read-only (an archived project: «who was on the team» is useful)                       |
| `dropMember.avatarUrl == null`                                      | `AvatarImage` is not rendered; `AvatarFallback` shows initials                                              |
| A long drop name                                                    | `truncate flex-1` — the name is truncated, the badge `shrink-0 ml-auto` is not pushed out                   |
| `effectiveTeam` absent in the API response (degradation)            | `project.effectiveTeam?.drop` = undefined → the row is not rendered                                         |

---

### 20.3 Affected code lines (for the Coder)

| Change                                                      | File             | Lines (guideline)          |
| ----------------------------------------------------------- | ---------------- | -------------------------- |
| Remove `px-0` from the wrapper, add the post-hero container | `$projectId.tsx` | ~705–706                   |
| Add `const dropMember = ...`                                | `$projectId.tsx` | ~643 (next to senior/drop) |
| Insert the drop row between the senior and HR               | `$projectId.tsx` | ~1072–1074                 |

---

### 20.4 Handoff checklist for the Coder

- [ ] Remove `px-0` from the page wrapper (~705); wrap the post-hero blocks in `<div className="space-y-5 px-4 sm:px-6">`.
- [ ] Declare `const dropMember = project.effectiveTeam?.drop ?? null` next to `senior`.
- [ ] Insert the drop row into the Team card after the senior row (~1072), before HR (~1074).
- [ ] RBAC gate: `dropMember != null && (ADMIN || HR || ACCOUNTANT)`.
- [ ] Use `ProfileNameLink` with `userId={dropMember.id}` and `viewerRole={user?.role}`.
- [ ] Badge: `variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-400 shrink-0 text-[9px] ml-auto"`.
- [ ] No detach button in this card — display-only.
- [ ] Playwright screenshot: the «Обзор» tab with a drop project at 375px and 1280px — the drop row is visible.
