# «Уведомления» tab in the profile — design spec

**Design tier:** 2 (a new tab on an existing profile screen; the design system is synced)
**Design-gate:** **degraded** — Claude Design is unavailable to the orchestrator without the owner (see the
orchestrator's clarification of 2026-09-12 in the task file). The spec is textual + reference screenshots of the live profile instead of
`design.html`/`design.png`. **`fidelity: degraded` for Mode B** — check not against a mockup, but against this
spec + `docs/design/foundation.md`.
**Screen:** `/profile?tab=notifications`, `mode === 'self'` only (position 7b of the plan).
**Business context source:** `docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md`
§3 (decision 6 — "channels are configured by the employee themselves"; assumption — "emails about confirmations and
signatures cannot be turned off"), §7.2 (the composition of the ten types), §8.1 (toast — for one's own actions), §8.4
(responsive — a hard gate on four classes) — read in full.
**Dependency:** position 7a (`GET/PUT /notifications/preferences`, the `locked` field) — **at the time of
writing this spec it is not in `main`** (being prepared in parallel, see the task file). The API contract below is
a design proposal, verify against the actual 7a implementation during layout (§7).
**Theme:** dark only (`apps/web/index.html` is hardcoded `class="dark"`) — I do not design or check the light one,
see `.claude/rules/common/design-gate.md`.
**References (existing profile tabs — style/pattern, NOT content):**
`docs/design/assets/notification-settings/reference-*.png` (320/1440, SENIOR, live stand) — see §16.

---

## 0. What is already in place (important for the construction below)

Read directly, not from memory:

1. **`UserProfileShell.tsx`** — tabs are declared in three places, all three must be touched during
   implementation (not a design decision, but I record it here so that the Coder does not have to piece it together):
   - `TAB_LABELS` (`Record<string, string>`) — the tab label.
   - `SELF_ALLOWED_TABS` — the constant with which `mode === 'self'` filters the backend's `permissions.tabs`.
     For `mode === 'view'` there is no filter at all — `visibleTabs = permissions.tabs`
     directly (the backend decides entirely).
   - The block `{activeTab === '<tab>' && visibleTabs.includes('<tab>') && <XTab .../>}` at the end of the file.
   - `packages/shared/src/schemas/view-permissions.ts` → `tabKeySchema` (a Zod enum) — `'notifications'` must be
     added, otherwise `permissions.tabs` will not pass parsing.
   - `apps/web/app/routes/_authenticated/profile/index.tsx` → `searchSchema.tab` (a Zod enum) —
     the same for the URL search parameter.
2. **AC1 ("no tab in `view`, `?tab=notifications` → «Обзор»") comes for free** if the
   backend for a `mode === 'view'` profile **never** puts `'notifications'` into
   `permissions.tabs` (personal channel settings are not something the viewer sees). Then
   `visibleTabs.includes('notifications')` = false → `activeTab` falls back to
   `visibleTabs[0] ?? 'overview'` with the same code that already handles any unavailable tab.
   This is a backend contract (7a or a separate DTO patch), not markup — I record it as an expectation, not
   implementing it.
3. **There is NO `Switch` (`role="switch"`) in `apps/web/app/components/ui/`.** Verified by listing the
   directory (36 files) — there is `segmented-toggle.tsx` (a radio group, not a binary switch) and
   `radio-group.tsx`, but not a single ARIA `switch`. `@radix-ui/react-switch` is also absent from
   `apps/web/package.json` (11 `@radix-ui/*` packages, `react-switch` is not among them). **This is the only
   new primitive this task requires** — see §5.
4. **`Card` + `CardContent className="p-0"` + `<table>` inside is an already established pattern**
   (`FinanceTab.tsx:169-260`): a container card, `overflow-x-auto` only inside the card, a manual
   `<table>`/`<thead>`/`<tbody>` (not the `Table` wrapper from `ui/table.tsx`, which itself adds
   `overflow-auto` — for nesting with a header this is not critical, but `FinanceTab` uses manual markup,
   and I follow the same precedent for consistency with the neighboring tab of the same profile).
5. **Error + retry is an established pattern** (`ContractPdfPreview.tsx:196-206`): an
   `AlertTriangle` icon of muted `text-destructive/60`, `text-sm text-muted-foreground` text,
   `Button size="sm" variant="outline"` with the text «Повторить».
6. **The mutation-error toast is an established pattern** (`useEmployeeContract.ts`, 5 mutations):

   ```
   toast.error(`Не удалось <действие>: ${msg}`)
   msg = err instanceof Error ? err.message : String(err)
   ```

   The value of `err.message` arrives already prepared: the axios interceptor (`apps/web/app/lib/axios.ts:62`)
   runs it through `getUserFacingErrorMessage` before it reaches the mutation hook — the hook
   itself does not call this function a second time.

7. **`TypeIcon`** (`apps/web/app/components/layout/notifications-bell.tsx:57-84`) — a per-type
   icon for all ten types, current (not the one in the popup's reference screenshot, where the
   titles are outdated text from before the COPY rounds). The function is **not exported** today —
   I recommend extracting it to `apps/web/app/lib/notification-type-icon.tsx` and importing it in both places
   (popup + the new table), so that the icon does not diverge into two copies. Not mandatory (deletion test:
   it can be left as is and the 10-way switch duplicated — not critical for a single task), but
   cheaper to do right away.
8. **`NOTIFICATION_TITLES`** (`packages/shared/src/schemas/notification-registry.ts:92`) — the SINGLE
   source of titles for all ten types, which has already gone through several `copy-reviewer` rounds
   (see the `COPY-H-1`…`COPY-M-5` comments in the file). **The settings must import exactly this
   map**, not create a second one — the AC2 test compares the strings directly.

---

## 1. Brief (5 questions, inherited from `foundation.md` §1 — not redefined for a single tab)

| Question    | Answer for this screen                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose     | The employee decides for themselves what to receive emails about. A one-time setup, not a daily screen.                                                                           |
| Audience    | Any self-profile role (except DROP — clarify the actual list of roles with the backend, see §12); opens it rarely, once after hiring and occasionally afterwards.                 |
| Tone        | `dense · quiet · scannable` — like the rest of the profile. NOT a separate "settings" style with full-width toggle cards — this is a table, not a step wizard.                    |
| Memorable   | Nothing extra: the "В приложении" channel is shown as a fact (not a switch), rather than hidden — this is the design detail (see the orchestrator's assumption in the task file). |
| Constraints | The same as everywhere: Tailwind v4 + shadcn/ui + Russian UI + WCAG 2.2 AA + responsive 320–1440 + dark-only.                                                                     |

---

## 2. Data composition: groups, order, membership

The source — `packages/shared/src/schemas/notification-registry.ts`. The group is not stored in the API response
(in the proposed contract, §7) — **the UI lays them out by type itself**, on the same principle by which the
registry constants are already laid out:

| Group (heading in the UI) | Membership (predicate on `type`)                                                  | Types (order — as in the registry)                                             | `locked`  |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------- |
| **Требуют ответа**        | `ACTION_REQUIRED_NOTIFICATION_TYPES`                                              | `PROJECT_CONFIRM_REQUIRED`, `SHARE_CONFIRM_REQUIRED`, `DOCUMENT_SIGN_REQUIRED` | all three |
| **Деньги**                | `INFORMING_NOTIFICATION_TYPES` where `type.startsWith('TRANSACTION_')`            | `TRANSACTION_ADDED`, `TRANSACTION_STATUS_CHANGED`                              | no        |
| **Команда и проекты**     | the remainder of `INFORMING_NOTIFICATION_TYPES`                                   | `TEAM_MEMBER_ADDED`, `PROJECT_MEMBER_ADDED`, `TEAM_NEW_MEMBER`                 | no        |
| **Ваши предложения**      | `ADMIN_NOTIFICATION_TYPES`, rendered when `viewer.role ∈ {ADMIN, HR, ACCOUNTANT}` | `APPROVAL_CONFIRMED`, `APPROVAL_REJECTED`                                      | no        |

**Why the predicate `startsWith('TRANSACTION_')` and not an array slice by index.** The index coincides
today by accident (the transaction types are the first two in `INFORMING_NOTIFICATION_TYPES`) — a predicate
on the type name will not break if the registry ever reorders or adds an eleventh
type between them. It is cheaper to write it right once than to fix silent drift later.

**The group was renamed and opened to HR — SR-M-3 (security-review, fix round 2, PR #675).** Round 1 named
the group by a role name (not by subject) and gated it with `viewer.role === 'ADMIN'`, based on the assumption "these emails
go to the administrator". The actual recipient of `APPROVAL_CONFIRMED`/`APPROVAL_REJECTED` is not the
ADMIN role, but the author of the proposal (`approvals.service.ts`: `userId: row.proposedByUserId`), and
`proposedByUserId` is whoever created the project, and `ADMIN` **and `HR`** are allowed to create projects
(`projects.service.ts`). The old assumption about the recipient was wrong: HR received these emails and had
no row in the interface to turn them off. The name was changed to «Решения по вашим предложениям»
(it names the subject — the decision on what the viewer proposed — not a role) and the visibility condition
was extended to `HR`. **The visibility condition in the UI is still NOT the same as the list from the backend**:
the task says "the list is provided by the backend, the UI does not decide for it" — if the backend returned these two types
to a non-ADMIN/HR/ACCOUNTANT role by mistake, the UI still will not show the group — double protection, not
reliance on one of the two.

**The name was shortened to «Ваши предложения» — COPY-L-5 (copy-review, fix round 3, PR #675).**
Round 2 renamed the group to «Решения по вашим предложениям» (29 characters), but did not check it at
real width — a measurement on the live stand at 320px under ADMIN showed a wrap onto two lines (block height
48px at `line-height` 16px). The headings of the neighboring groups («Деньги», «Команда и проекты») fit on
one line; a two-line heading for THIS group in particular would be an asymmetry without
reason. «Ваши предложения» (16 characters) fits on one line — the second half of the meaning
("decisions ON THEM") is completed by the group's own rows: «Предложение принято» / «Предложение
отклонено».

**The role was extended to `{ADMIN, HR, ACCOUNTANT}` — SR-M-4 (security-review, fix round 3, PR #675).**
Round 2 closed HR, but `proposedByUserId` appears not only through project creation. `projects.
service.ts` `update()` lets ACCOUNTANT through on a finance-scoped patch (only the field
`seniorSharePercentOverride`, the `hasOnlyOverride` gate) — this patch goes through
`proposeSeniorShareChange(...)` and writes `proposedByUserId: <ACCOUNTANT>`. It is confirmed by the project's SENIOR —
another user, so the early exit "proposer == decider → no email"
(`approvals.service.ts`) does not fire, and ACCOUNTANT receives both types of emails with no row in the
interface to turn them off — the same defect that SR-M-3 closed for HR, one role further.

**An unknown type** (the same position as AC2 of position 6) — a separate unnamed group **at the end**
of the list, without a heading like «Требуют ответа/Деньги/…», labeled with a generic text (see §9.3).

---

## 3. Token map (existing tokens only — nothing is added to `@theme inline`)

| Purpose                          | Classes / token                                                                                                        | Precedent                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tab container                    | `Card` + `CardContent className="p-0"`                                                                                 | `FinanceTab.tsx:169-170`                                                                                             |
| Group heading (inside the table) | `bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide` on a full-width `<tr><td colSpan={3}>` | A `TableHeader`-like row pattern; analogous to the uppercase caption in `senior-overview` KPI cards (screenshot §16) |
| Row (desktop)                    | `border-b border-border/50 hover:bg-muted/20`                                                                          | `FinanceTab.tsx` transaction table (analogous hover)                                                                 |
| Type name                        | `text-sm font-medium text-foreground`                                                                                  | Table body, general scale (`foundation.md` §4)                                                                       |
| Explanation under a `locked` row | `text-xs text-muted-foreground` (not `destructive` — this is not an error, it is a fact)                               | `ContractPdfPreview.tsx` error text in tone, but without red — neutral information                                   |
| «Всегда» («В приложении» column) | `text-xs text-muted-foreground`                                                                                        | A neutral caption, not a `Badge` (a badge would look like a status, but this is a fact of the column)                |
| Type icon                        | `TypeIcon` (see §0.7) — its per-type colors are already defined                                                        | `notifications-bell.tsx:57-84`                                                                                       |
| `Switch` on                      | `bg-primary` (track), `bg-primary-foreground` (thumb) — the standard Radix fill on tokens                              | A new component, see §5 — painted with the same tokens as the whole brand accent                                     |
| `Switch` off                     | `bg-input` (track)                                                                                                     | `--input` is already used for input fields — the switch uses the same neutral surface                                |
| `Switch` `disabled` (locked)     | `opacity-60 cursor-not-allowed` on top of the "on" look                                                                | The standard disabled pattern of `Button`/`Input` in this codebase                                                   |
| Focus ring on `Switch`           | `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`                                             | `SegmentedToggle`, `Badge` — the same formula everywhere                                                             |
| Row skeleton while loading       | `Skeleton className="h-5 w-full"` inside `<td colSpan={3}>`                                                            | `FinanceTab.tsx:223-232` (an identical skeleton-row pattern)                                                         |
| Load error — icon                | `AlertTriangle` `text-destructive/60`                                                                                  | `ContractPdfPreview.tsx:201`                                                                                         |
| «Повторить» button               | `Button size="sm" variant="outline"`                                                                                   | `ContractPdfPreview.tsx:204`                                                                                         |
| Tab label (`TAB_LABELS`)         | no styling — an ordinary string in `AnimatedTabs`                                                                      | `UserProfileShell.tsx:33-42`                                                                                         |

---

## 4. Components

### Existing (reused as is)

- `Card` / `CardContent` — the container (§3).
- `Skeleton` — the loading state.
- `Button` (`variant="outline"`, `size="sm"`) — «Повторить».
- `AnimatedTabs` — the tab is registered in the existing list, the component does not change.
- `toast` (`sonner`) — save success/error.
- `TypeIcon` (recommended to extract into a shared module, see §0.7) — the per-type icon.
- `NOTIFICATION_TITLES` (`@crm/shared`) — type titles, one source with the popup.

### New (minimal, justified)

1. **`Switch` (`apps/web/app/components/ui/switch.tsx`)** — a standard shadcn/ui primitive on top of
   `@radix-ui/react-switch` (add the dependency: `pnpm --filter @crm/web add @radix-ui/react-switch`).
   Rationale: the task requires `role="switch"` + `aria-checked` — this is the ARIA semantics of a **binary**
   state switch, not a radio group (`SegmentedToggle`/`radio-group.tsx` encode "choose
   one of N", not "on/off"). Use the native Radix primitive, not a hand-rolled `<button>`
   with manual ARIA attributes — Radix already gives correct keyboard navigation (`Space`/`Enter`),
   `data-state`, `aria-checked`, `aria-disabled` for free. Styled with the tokens from §3 — a new
   component, but NOT a new visual language (the same `--primary`/`--input`/`--ring` as everywhere).
2. **`useNotificationPreferences()` / `useUpdateNotificationPreference()`** (hooks, mirroring the pattern of
   `use-notifications-api.ts`) — `GET/PUT /notifications/preferences`, see §7 for the contract and
   behavior. Not a UI component, but part of this spec's contract.
3. **`NotificationSettingsTab.tsx`** (in `apps/web/app/components/user-profile/tabs/`, following the
   neighboring `*Tab.tsx`) — the tab itself: grouping (§2), table/stack rendering (§6), states (§9).

**Explicitly NOT introduced:** a separate component for a "master switch for all emails at once" — not
requested by the task, I will not invent it (see `codebase-design`: deletion test — add only what is actually
needed now).

---

## 5. Markup

### 5.1 Desktop (≥768, table)

```
┌─ Card ──────────────────────────────────────────────────────────────────┐
│  Уведомления                                                            │  ← optional, the tab title is already in AnimatedTabs — see §12
│  Выберите, о чём присылать письма. В приложении уведомления видны всегда.        │  ← subtitle, text-sm text-muted-foreground
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ ТРЕБУЮТ ОТВЕТА                                          [colSpan=3] │
│  ├────────────────────────────┬────────────────┬───────────────────┤
│  │ Тип уведомления            │ В приложении   │ Письмо            │
│  ├────────────────────────────┼────────────────┼───────────────────┤
│  │ ⚠ Проект ждёт решения      │ Всегда         │ ●━━ (вкл, disabled)│
│  │   Письма о запросах на     │                │                   │
│  │   подтверждение и подпись  │                │                   │
│  │   отключить нельзя — без   │                │                   │
│  │   них процесс встанет.     │                │                   │
│  ├────────────────────────────┼────────────────┼───────────────────┤
│  │ ⚠ Предложение по доле      │ Всегда         │ ●━━ (вкл, disabled)│
│  │   (то же объяснение)       │                │                   │
│  ├────────────────────────────┼────────────────┼───────────────────┤
│  │ ⚠ Контракт на подпись      │ Всегда         │ ●━━ (вкл, disabled)│
│  │   (то же объяснение)       │                │                   │
│  ├────────────────────────────┴────────────────┴───────────────────┤
│  │ ДЕНЬГИ                                                            │
│  ├────────────────────────────┬────────────────┬───────────────────┤
│  │ 💰 Вам добавили транзакцию │ Всегда         │ ○━━ / ━━●          │
│  │ 💰 Решение по доходу       │ Всегда         │ ○━━ / ━━●          │
│  ├────────────────────────────┴────────────────┴───────────────────┤
│  │ КОМАНДА И ПРОЕКТЫ                                                 │
│  ├────────────────────────────┬────────────────┬───────────────────┤
│  │ 👥 Вас добавили в команду  │ Всегда         │ ○━━ / ━━●          │
│  │ 📁 Вас добавили в проект   │ Всегда         │ ○━━ / ━━●          │
│  │ 👥 В команде новый участник│ Всегда         │ ○━━ / ━━●          │
│  ├────────────────────────────┴────────────────┴───────────────────┤
│  │ ВАШИ ПРЕДЛОЖЕНИЯ                (ADMIN, HR, ACCOUNTANT)            │
│  ├────────────────────────────┬────────────────┬───────────────────┤
│  │ ✓ Предложение принято      │ Всегда         │ ○━━ / ━━●          │
│  │ ✗ Предложение отклонено    │ Всегда         │ ○━━ / ━━●          │
│  └────────────────────────────┴────────────────┴───────────────────┘
└──────────────────────────────────────────────────────────────────────────┘
```

Columns: `Тип уведомления` (flexible, minimum ~55% of the width — titles + explanation are the longest),
`В приложении` (narrow, fixed ~120px, text centered or left — alignment is secondary), `Письмо`
(narrow, fixed ~100px, the `Switch` centered in the cell). Implementation — `<table className="w-full">` with
a `<col>` group or `w-[...]` on `<th>`, in the same way `FinanceTab` forms its header.

### 5.2 Mobile (320/375, a single-column stack)

A per-row card (not a `<table>` — see §9 responsive):

```
┌────────────────────────────────────────────────┐
│  ТРЕБУЮТ ОТВЕТА                                 │  ← group heading, text-xs uppercase muted
│  Письма о запросах на подтверждение и           │  ← ONE explanation under the group heading
│  подпись отключить нельзя — без них             │    (COPY-M-2, not per-row — see §10)
│  процесс встанет.                               │
├────────────────────────────────────────────────┤
│  ⚠ Проект ждёт решения             [●━━]        │  ← switch top-right, disabled, ≥44×44 hit
├────────────────────────────────────────────────┤    area; there is NO per-row repeat of the channel (COPY-M-4,
│  ⚠ Предложение по доле             [●━━]        │    fix round 3): the fact "in the app — always" is
├────────────────────────────────────────────────┤    stated once, in the subtitle above the stack;
│  ...                                             │    the desktop cell of §5.1 stays — there it is
└────────────────────────────────────────────────┘    a matrix coordinate, not an independent repeat.
```

The mockup breaks off at the first group (`...`) for brevity — unlike §5.1, where the desktop mockup
draws all four groups in full, including «ВАШИ ПРЕДЛОЖЕНИЯ» (ADMIN, HR, ACCOUNTANT). On mobile
this group is rendered by the same `MobileStack` component and the same group heading, simply
as the next card in the stack — there is no need to create a separate mockup for it, the layout is identical.

A row — `flex flex-col gap-1 p-4 border-b border-border/50` (a card inside the same `Card`, not
separate nested cards — "card in a card" is forbidden by the `foundation.md` anti-patterns).
The row heading — `flex items-start justify-between gap-3`: on the left icon+name (`flex-1 min-w-0`,
`break-words`, NOT `truncate` — long titles are already short ≤24 characters per the registry's COPY rounds,
but the explanation always wraps), on the right the `Switch` (`shrink-0`).

---

## 6. Behavior: loading / saving / errors

### 6.1 Loading

`useNotificationPreferences()` — `useQuery`, `queryKey: ['notification-preferences']`. While
`isLoading` — a skeleton: on desktop 10 rows of `<Skeleton className="h-5 w-full" />` in `<td colSpan={3}>`
(grouping is not shown, just 10 identical gray bars — the groups appear together with the data,
it is cheaper not to draw fake group headings); on mobile — 10 placeholder cards of the same shape as the
real row, but with `Skeleton` instead of the text/switch.

### 6.2 Saving — optimistic, no button

`useUpdateNotificationPreference()` — `useMutation<void, Error, { type: NewNotificationType; email: boolean }>`:

```
onMutate({ type, email }):
  cancel queries ['notification-preferences']
  snapshot previous data
  setQueryData: replace email for this type in the cache (the switch visually jumps immediately)
  return { previous }
onError(err, vars, context):
  setQueryData(context.previous)   // rollback
  toast.error(`Не удалось сохранить настройку: ${msg}`)
onSuccess():
  toast.success('Сохранено')
onSettled():
  invalidate ['notification-preferences']  // confirm consistency with the server
```

A click on the `Switch` triggers the mutation immediately — with no intermediate "draft". While the mutation is in flight,
the `Switch` itself can be left clickable (the next click simply queues a new mutation on top) —
there is no anti-pattern, because the rollback reverts exactly the mutation that failed, and `onSettled`
pulls the actual state from the server at the end. If the Coder prefers to block a repeat click
during the in-flight mutation (`disabled={mutation.isPending}` in addition to `locked`) — also acceptable,
not a design requirement.

### 6.3 API contract (proposed — verify against 7a)

```
GET /notifications/preferences
→ Array<{ type: NewNotificationType; email: boolean; locked: boolean }>

PUT /notifications/preferences
body: { type: NewNotificationType; email: boolean }
→ 204 / the updated record
```

The `inApp`/"in the app" field is **not needed in the contract** — the «В приложении» column does not read data,
it is a static caption «Всегда» on every row (see the orchestrator's assumption: the channel is shown
but never switched). If 7a does send such a field — the UI ignores it, it is not an
error.

`locked` determines: the `Switch` is rendered with `checked={true}` (or `email === true` — both must
match for locked rows, but `checked` is forced to `true` on the client in any case, even if the
backend sent `false` by mistake — an unavailable state must not visually contradict the text of
the explanation "cannot be turned off"), `disabled={true}`, `aria-disabled="true"`, a click does not trigger the mutation
(the `onCheckedChange` handler is not assigned or is a no-op).

---

## 7. States

| State                          | What we show                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading (`isLoading`)          | Skeleton rows, §6.1. The tab title/subtitle remain visible (not skeletonized — static text).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Load error (`isError`)         | `AlertTriangle` + «Не удалось загрузить настройки.» (COPY-L-3, fix round 2) + `Button variant="outline" size="sm"` «Повторить» → `refetch()`. Replaces the whole content of `CardContent`, the tab itself stays selected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Success, ten types             | The regular rendering of §5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Unknown `type` in the response | A separate unnamed group at the end: the "Тип уведомления" row = `Новый тип` (COPY-L-4, fix round 3 — the raw `type` value remains available only in `data-testid` and the `title` attribute, NOT on screen: showing an English-language machine identifier to a Russian-speaking employee is the HIGH finding COPY-H-1, round 2, closed by the same PR), the explanation — «Настройка появится после обновления приложения.» (COPY-L-6, fix round 4 — after COPY-L-4 removed the word «уведомления», the phrase was left with the single noun «обновление» with no named actor, and "после обновления" on its own in this product reads as "refresh the page"; the earlier round-2 wording, COPY-L-1, had also rephrased the original text with a request to wait — round 3 removed the repetition of the word «уведомления» between the label and the explanation), the `Switch` is rendered **in `aria-disabled`** (not absent — the component always renders the `Switch`, just without `onCheckedChange`), a click is a no-op, since the semantics of the type are unknown to the client, it is safer not to allow switching it. The tab does not crash (the same requirement as AC2 of position 6). |
| Empty response                 | Impossible by the contract (always ten types, filtered by role) — a special empty state is not designed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Mutation in progress           | See §6.2 — the switch is already visually in the new position (optimistically), no separate spinner needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 8. Responsive (320/375 · 768 · 1024/1280 · 1440/1920)

**A layout switch, not a CSS reformat of one markup.** Following the precedent of `foundation.md` §10
("dense table → card stack OR h-scroll") a **card stack** is chosen, not horizontal scroll: the notification
table is not a money table with 6 columns where scrolling would be acceptable, but a 3-column one with
long text content (the explanation of locked rows) — cropping/scrolling text is worse than changing
the form. Technically — two independent markup blocks under a width condition:

```tsx
<div className="hidden md:block"> … <table> … </table> … </div>
<div className="md:hidden"> … per-row cards … </div>
```

These are NOT two duplicate components with diverging logic — both read the same
grouped array (§2), only the row's JSX wrapper differs. Both branches keep ONE
source of row markup at the computation level (grouped data + text), the difference is only
in the container (`<tr>` vs `<div>`).

| Class      | Widths    | Behavior                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mobile** | 320 / 375 | A card stack (§5.2). The `Switch` — a final hit area ≥44×44px (the Radix visual track itself is already compact ~36×20 — wrap in `inline-flex items-center justify-center` with `min-w-11 min-h-11`, a pattern analogous to `[&>button]:max-[639px]:min-h-11` from `project-status-filter.md` §5). No horizontal scroll — all text wraps (`break-words`, no `truncate`). |
| **Tablet** | 768       | Switch to the table (the `md:` breakpoint) — 768px already comfortably fits 3 columns at the current type scale (titles ≤24 characters, the explanation — the longest — wraps onto 2-3 lines inside its cell, the cell has no fixed height).                                                                                                                             |
| **Laptop** | 1024/1280 | The table, full layout, unchanged relative to 768 except for the available width.                                                                                                                                                                                                                                                                                        |
| **Large**  | 1440/1920 | Content inside `max-w-6xl` (the shared cap of `UserProfileShell.tsx`, already applied to all tabs) — the table does not stretch to the full ultra-width, the "Тип уведомления" column does not turn into an unreadably long line.                                                                                                                                        |

**Touch target ≥44×44 — the only hard number of this spec besides the WCAG minimum** (§9) — Radix
`Switch` by default renders a small `<button role="switch">`; the wrapper must extend
the **clickable area**, not the visual track (otherwise the track visually "balloons" and does not look
like a switch anywhere else in the UI — and we are introducing this component for the first time, setting its look once
for the whole app).

---

## 9. A11y (WCAG 2.2 AA)

Verified via the `accessibility` skill.

- **`role="switch"` + `aria-checked`.** Radix `Switch` provides this natively (`data-state` +
  `aria-checked` are synchronized) — do not emulate manually.
- **The label is tied to the type.** Each `Switch` — `aria-labelledby={id of the type name}` OR
  `aria-label={'Письма: ' + NOTIFICATION_TITLES[type]}` (the second is simpler and does not require generating an `id`
  per row; I explicitly choose **`aria-label`** as the decision of this spec). **Order — the channel
  first (COPY-L-2, fix round 2, PR #675; it was `NOTIFICATION_TITLES[type] + ' — письмо'`, i.e.
  name-then-channel):** a label leading with the channel names WHAT is controlled before naming
  WHICH row it belongs to — the same order in which any other control on this
  screen is announced ("Switch"/"toggle" always comes target-first), and without quotation marks as the only
  (not voiced by most screen readers) boundary between the two parts of the phrase.
- **`locked` → `aria-disabled="true"` + `aria-describedby`.** `aria-disabled`, not the native HTML
  `disabled` — the difference matters: native `disabled` removes the element from the tab sequence
  (a screen reader user will not even learn that such a setting exists and why it is unavailable);
  `aria-disabled` keeps the element in the Tab order, but marks it unavailable — SC 4.1.2 requires that the
  state be programmatically determinable, not that the element disappear. **`aria-describedby` — to ONE
  shared `id` of the explanation under the «Требуют ответа» group heading, one for all three `locked` rows
  (revised by COPY-M-2, fix round 2 — see §10 "Assumptions"; the previous edition of this paragraph
  prescribed a per-row id and directly contradicted the already rewritten §10 — this fixes
  the document's self-contradiction, not reopening the decision).** The unknown-type row has its
  own per-row `id` (that explanation is specific to the particular row, not shared for the group).
  Radix `Switch` supports a `disabled` prop, which by default maps to the native `disabled` —
  **explicitly pass `aria-disabled` separately** and do NOT rely on the default mapping, or use
  `disabled={false}` + manual `aria-disabled`/`onCheckedChange={undefined}` for visual-disabled without
  dropping out of the Tab order. The specific call API is at the Coder's discretion, the requirement is recorded.
- **Focus.** `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` — the same
  formula as everywhere in this codebase (§3).
- **Tab order by rows.** The natural DOM order (group → row → `Switch`) already gives the
  correct order without `tabIndex` tricks — groups and rows go visually top to bottom, Tab goes
  the same way.
- **Target size.** ≥44×44 on mobile (see §8) — larger than the WCAG minimum of 24×24 (SC 2.5.8), chosen per
  `foundation.md` §9 "on mobile we aim for ≥44px".
- **Contrast.** `text-muted-foreground` on `bg-card`/`bg-background` — an already verified pair across the whole
  app (not a new combination, no measurement required).
- **Color is not the only carrier.** The `locked` state carries three independent signals: (1) the explanation
  text — not merely a visually muted switch; (2) `aria-disabled` — programmatically
  determinable; (3) the switch is fixed in the "on" position (not in an indeterminate "gray"
  state) — the very fact "on and not touchable" already communicates "mandatory", without relying on one color.

---

## 10. Assumptions (A1, recorded, not escalated)

- **The locked explanation — moved out once per group (revised, COPY-M-2, fix round 2, PR #675).**
  Round 1 implemented a per-row repeat (this was the previous assumption here: "make
  `aria-describedby` self-sufficient at the row level"). `copy-reviewer` found that three identical sentences in a row
  take up a third of the first screen at 320px — the very effect for the sake of which the repeat seemed
  justified turned out to be a cost, not an advantage. The text is now rendered once under the heading of the
  «Требуют ответа» group (`DesktopGroupHeader`/`MobileStack`), all three `locked` switches
  point `aria-describedby` at this one id — a valid ARIA pattern (one description for several
  elements), and the `id` is stable (does not depend on `row.type`), so the risk of a "more fragile reference",
  with which round 1 justified the per-row variant, did not materialize in practice.
- **The order of groups/types — as in §2**, including partitioning `INFORMING_NOTIFICATION_TYPES` by
  a name predicate, not by array index (rationale in the same place).
- **The tab title inside `CardContent`** («Уведомления» + subtitle, §5.1) — optional:
  `AnimatedTabs` already shows «Уведомления» as the tab's own label right above the content, a second
  heading would be redundant on a strict reading of `foundation.md` ("do not repeat"); the subtitle,
  however, carries new information ("in the app — always") and is kept. The Coder may remove the heading
  «Уведомления» from `CardContent` if they consider it duplicative — does not block acceptance.
- **`Switch` — a new primitive is introduced by this task**, rather than taken from an external ready place —
  confirmed by grepping the directory and `package.json` (§0.3). Styling — per the §3 tokens, with no new
  visual language.
- **An unknown type does not allow toggling `Письмо`** (§7) — since the semantics are unknown to the client, erring
  toward "cannot be configured" is safer than the error "configured not what they thought".
- **The RBAC composition of roles to which the tab is open at all** (apart from the exception of the group «Решения по вашим
  предложениям» — that is a separate, already covered condition, revised in fix round 2 — see below) —
  by default all self roles, except those for whom the backend will not include `'notifications'` in
  `permissions.tabs`. The spec does not restrict the list of roles itself — see §12 (an open item for
  security-reviewer/backend, not a design decision); the DROP branch of the item was closed by the orchestrator as A1 in
  fix round 2 (PR #675: DROP receives notifications about share/transactions and must manage emails,
  like any other self profile).
- **The group was renamed from the old role-based name to «Решения по вашим предложениям» and opened to HR
  (SR-M-3, fix round 2, PR #675).** Round 1 gated it with `viewer.role === 'ADMIN'`, based on the
  assumption that the `APPROVAL_CONFIRMED`/`APPROVAL_REJECTED` emails are addressed to the administrator.
  `security-reviewer` checked the actual sending logic (`approvals.service.ts`) and found that the
  addressee is the author of the proposal (`proposedByUserId`), and ADMIN **and** HR are allowed to create projects
  (`projects.service.ts`). The name and the visibility condition were brought in line with the real
  recipient; §2/§5.1/§5.2/§11 were updated by the same commit.
- **The name was shortened once more to «Ваши предложения» (COPY-L-5, fix round 3, PR #675)** — round 2
  renamed by meaning, but did not check the width; on the live stand at 320px under ADMIN the 29-character
  heading wraps onto two lines, while the neighboring headings fit on one. See §2 for the
  measurement and reasoning. Visibility in the same round was extended to `{ADMIN, HR, ACCOUNTANT}` (SR-M-4,
  §2) — these are two independent changes of one line, both recorded separately.

---

## 11. Texts (for `copy-reviewer`; the draft was composed per the principles of the `copywriting` skill — dense/quiet, no filler words)

| Place                              | Text                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab title (`TAB_LABELS`)           | `Уведомления`                                                                                                                                                                                                                                                                                                                                                   |
| Section subtitle                   | `Выберите, о чём присылать письма. В приложении уведомления видны всегда.`                                                                                                                                                                                                                                                                                      |
| Group headings                     | `Требуют ответа` / `Деньги` / `Команда и проекты` (the first three were given by the owner verbatim) / `Ваши предложения` (renamed by SR-M-3 to «Решения по вашим предложениям» — names the subject, not the role — then shortened by COPY-L-5, fix round 3, to a single line at 320px; visibility extended to `{ADMIN, HR, ACCOUNTANT}` by SR-M-4, see §2/§10) |
| Column 1                           | `Тип уведомления`                                                                                                                                                                                                                                                                                                                                               |
| Column 2                           | `В приложении`                                                                                                                                                                                                                                                                                                                                                  |
| Column 2 value (each row)          | `Всегда`                                                                                                                                                                                                                                                                                                                                                        |
| Column 3                           | `Письмо`                                                                                                                                                                                                                                                                                                                                                        |
| Locked-row explanation             | `Письма о запросах на подтверждение и подпись отключить нельзя — без них процесс встанет.` (given by the owner verbatim, not rewritten)                                                                                                                                                                                                                         |
| Unknown type — label / explanation | `Новый тип` / `Настройка появится после обновления приложения.` (COPY-L-4, fix round 3 + COPY-L-6, fix round 4; the label used to be a generic word for a notification with no qualifier, the explanation — a longer phrase with a request to wait; see §7 and the history of COPY-H-1/COPY-L-1 of round 2)                                                     |
| Success toast                      | `Сохранено` (given in the task verbatim — a short participle, the same pattern as «Аватар обновлён», «Пользователь обновлён» in this same codebase)                                                                                                                                                                                                             |
| Save error toast                   | `Не удалось сохранить настройку: ${msg}` (the `useEmployeeContract.ts` pattern, `${msg}` — from `err.message`, already run through `getUserFacingErrorMessage`)                                                                                                                                                                                                 |
| Load error                         | `Не удалось загрузить настройки.` (COPY-L-3, fix round 2 — it was `Не удалось загрузить настройки уведомлений.`, the word «уведомлений» repeated the name of the tab under which this text sits)                                                                                                                                                                |
| Retry button                       | `Повторить` (identical to `ContractPdfPreview.tsx`)                                                                                                                                                                                                                                                                                                             |
| Switch `aria-label` (example)      | `Письма: Вам добавили транзакцию` (COPY-L-2, fix round 2 — it was `«Вам добавили транзакцию» — письмо`; channel first, without quotation marks as the only voiced boundary — see §9)                                                                                                                                                                            |

Rationale per the `copywriting` principles: concrete nouns without filler
(«настроить»/«управлять»/«гибко» — not used), the toast participles match the form already accepted
in the codebase, no adjective triads, not a single phrase that the owner did not say
literally, where he already said it (the locked text, the success toast).

---

## 12. Open questions (A2 — do not block layout, but an answer is needed before the final review)

1. **The exact list of roles for which the backend includes `'notifications'` in `permissions.tabs`.** The task
   says "the employee themselves" without exceptions by role (apart from gating the admin group inside the tab) — this
   spec assumes "all self roles", but the actual list is set by 7a/the backend, not this spec. It does not
   block layout (the UI simply renders what it received).
   **Closed by the orchestrator as A1 in fix round 2 (PR #675, `spec-reviewer` SPEC-M-1).** The implementation
   went further than the wording — the tab is added client-side unconditionally for ANY `mode === 'self'`
   role, DROP included. Decision: leave as is — DROP receives notifications (about share, about
   transactions) and must be able to manage emails on a par with any other self profile;
   DROP indeed has no separate "team" profile, but `/profile` (its own, self) it does have,
   like any role. Recorded in the PR body ("Допущения"), not escalated.
2. **Whether a separate notification email is needed about the very fact of a setting change** (for example,
   "you turned off emails about …") — the task does not ask for it, and this spec does not design it. I leave it as an
   explicitly unasked question, rather than quietly dropping it.

---

## 13. Test widths for Mode B (fidelity audit)

320, 375, 768, 1024, 1280, 1440, 1920 — identical to `responsive-design.md`. At each: no
horizontal overflow (`scrollWidth <= clientWidth`), all ten rows visible/reachable without
cropping the explanation text, the `Switch` at 320/375 — hit area measured ≥44×44 (not only the visual
track), focus visible on Tab through each switch. `design.png` is absent (degraded, see the file
header) — the check goes against this spec + `foundation.md`, not against a raster mockup.

---

## 14. Checklist for the Coder (summary, does not duplicate the sections above)

- [ ] `apps/web/app/components/ui/switch.tsx` — a new primitive (§4, §5, dependency `@radix-ui/react-switch`).
- [ ] `apps/web/app/components/user-profile/tabs/NotificationSettingsTab.tsx` — the whole tab.
- [ ] `apps/web/app/hooks/use-notification-preferences.ts` (or an extension of `use-notifications-api.ts`) — `GET`/`PUT` hooks (§6.3).
- [ ] `UserProfileShell.tsx`: `TAB_LABELS['notifications'] = 'Уведомления'`, `SELF_ALLOWED_TABS` +=
      `'notifications'`, the render branch at the end of the file (§0.1).
- [ ] `packages/shared/src/schemas/view-permissions.ts`: `tabKeySchema` += `'notifications'`.
- [ ] `apps/web/app/routes/_authenticated/profile/index.tsx`: `searchSchema.tab` enum += `'notifications'`.
- [ ] Backend (7a/a related task, outside this spec's zone): `permissions.tabs` for `mode==='view'`
      NEVER includes `'notifications'` (§0.2) — verify, do not reimplement here.
- [ ] `TypeIcon` — extract into a shared module where possible (§0.7), not a mandatory acceptance condition.
- [ ] Do not touch: `/pending` (7c, a separate screen), email texts (out of zone), settings on behalf of another
      user (the task explicitly excludes).

---

## 15. Related tests (a guide for AutoTest, not an implementation mandate)

Duplicates the ACs from the task file line by line — here only the details that concern layout specifically:

- Unit: comparing `NOTIFICATION_TITLES[type]` with the string in the rendered cell — importing one
  map (AC2), rather than hardcoding a second copy of the text in the test.
- Unit: a `locked` row — zero mutation calls on click/Enter/Space press on the `Switch` (AC3).
- E2E: touch target ≥44×44 is measured via `getBoundingClientRect()` at 320/375, not "by eye".

---

## 16. Screenshots (a style reference — NOT the tab's content, it does not exist yet)

- `docs/design/assets/notification-settings/reference-profile-tabs-card-320.png` — the «Реквизиты»
  tab of the same profile, mobile: the `Card` + form + `SegmentedToggle` pattern, used as
  a reference for the card stack of §5.2.
- `docs/design/assets/notification-settings/reference-profile-tabs-card-1440.png` — the same, desktop:
  the tabs pattern (`AnimatedTabs`) above the content, a `Card` container.
- `docs/design/assets/notification-settings/reference-profile-kpi-form-1440.png` — the «Обзор» tab,
  desktop: the uppercase-caption KPI-card pattern (a reference for the group headings of §3) and dense forms.

Captured by a live Playwright pass (SENIOR, dev-login, scratch DB `crm_design_notif_scratch`,
`colorScheme: 'dark'`) right before writing this spec — not from memory of how the screen
is built. `design.png` for the «Уведомления» tab itself is absent by construction (the tab does not yet exist
in code, Tier 2 + degraded) — this is expected, not a gap.
