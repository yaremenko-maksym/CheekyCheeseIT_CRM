# Design Spec: Junior Hub Round 2 — Bento Grid, Passwords, Profile Layout

> Mode A → B — Design Direction (round 2, post-UT feedback)
> Spec slug: `junior-hub-round2`
> Source: UT feedback 2026-06-12 (7 items), task `.claude/tasks/task-junior-ut-round2.md`
> Precedent: `docs/design/junior-hub.md` (round 1) · `docs/design/project-credentials.md` · `docs/design/drop-role-ux.md`
> Author: ui-ux-designer · 2026-06-12

---

## Current state (baseline)

Screenshots in `docs/design/assets/junior-r2/`:

- `01-hub-current-1440.jpeg` — the hub at 1440×900: 5 rows of vertical scroll, a poor "ПАРОЛИ ПРОЕКТА" section at the bottom, QuickLinksBar at the very bottom (to be removed).
- `02-legend-current.jpeg` — the "Легенда" page: view mode — fine.
- `03-datepicker-form-current.jpeg` — the "Персона" form in edit mode: the date picker _with a date already selected_ fits. The problem is only with the _empty_ placeholder `«Выберите дату рождения»`.
- `04-profile-current.jpeg` — the junior's profile: 6 tabs (Обзор / Проект / Команда / Реквизиты / Документы / Финансы).

**Diagnosis for item 1 (scroll):** at 1440×900 the content takes ~1050px of height because of the vertical stack: heading + [2-col row] + [2-col row] + [full-width HR] + [full-width Credentials] + [full-width QuickLinksBar]. 150px over the limit + QuickLinksBar duplicates the nav.

---

## 1. Hub grid redesign — Bento Grid (item 1)

### 1.1 Problem

The current layout: `space-y-4` with 4 nested grid containers. At 1440px it does not fit into a 900px viewport. QuickLinksBar (removed in item 2) takes a whole row and duplicates the side menu.

### 1.2 Solution: a 3-column bento grid

Key idea: a _single_ CSS grid `grid-cols-3` on desktop, where cards take different col-spans. The grouping is logical: the left column — project identity + persona, the middle — contractual data, the right — finances + contact. Passwords are embedded in the bottom strip.

#### Desktop ≥ 1024px (3 columns)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  <h1>Мой проект</h1>  · subtitle: companyName                                  │
│  [ProjectSwitcher — only with >1 project]                                      │
├─────────────────────┬─────────────────────┬───────────────────────────────────┤
│  ProjectInfoCard    │  PersonaCard        │  ContractStatusCard + SalaryCard   │
│  col-span-1         │  col-span-1         │  col-span-1                        │
│  (logo · company ·  │  (initials avatar · │  flex-col gap-3:                  │
│   domain · start ·  │   full name · role ·│  ─ ContractStatusCard (h-auto)     │
│   status)           │   «Открыть легенду»)│  ─ SalarySnapshotCard (flex-1)     │
│                     │                     │  (no Separator between them)       │
├─────────────────────┴─────────────────────┴───────────────────────────────────┤
│  HrContactCard + ProjectCredentialsSection — col-span-3                       │
│  flex gap-4 (horizontal):                                                     │
│  ├── HrContactCard  flex-shrink-0 w-[280px]                                   │
│  └── ProjectCredentialsSection  flex-1                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

CSS:

```tsx
// Outer HubCards container
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  variants={container}
  initial="hidden"
  animate="show"
>
  {/* Left column */}
  <motion.div variants={card} className="lg:col-span-1">
    <ProjectInfoCard ... />
  </motion.div>

  {/* Middle column */}
  <motion.div variants={card} className="lg:col-span-1">
    <PersonaCard ... />
  </motion.div>

  {/* Right column: Contract + Salary in flex-col */}
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-3">
    <ContractStatusCard ... />
    <SalarySnapshotCard className="flex-1" ... />
  </motion.div>

  {/* Bottom strip: HR + Credentials side by side */}
  <motion.div variants={card} className="col-span-full flex flex-col md:flex-row gap-4">
    <HrContactCard className="md:w-[280px] shrink-0" ... />
    <div className="flex-1 min-w-0">
      <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd={true} />
    </div>
  </motion.div>
</motion.div>
```

#### Tablet 768–1023px (2 columns)

```
┌─────────────────────────────┬──────────────────────────────┐
│  ProjectInfoCard            │  PersonaCard                 │
├─────────────────────────────┴──────────────────────────────┤
│  ContractStatusCard   │  SalarySnapshotCard               │
│  col-span-1           │  col-span-1                       │
├─────────────────────────────────────────────────────────────┤
│  HrContactCard  (col-span-full, w-full)                    │
├─────────────────────────────────────────────────────────────┤
│  ProjectCredentialsSection  (col-span-full)                │
└─────────────────────────────────────────────────────────────┘
```

On tablet HR and Credentials unfold into `flex-col` (each full-width). CSS:

```tsx
// bottom strip:
className = 'col-span-full flex flex-col md:flex-row gap-4'
// at md: flex-row (HR 280px + Credentials flex-1)
// below md: flex-col (both full-width, stacked)
```

#### Mobile < 768px (1 column, order = priority)

1. ProjectInfoCard
2. PersonaCard
3. ContractStatusCard
4. SalarySnapshotCard
5. HrContactCard
6. ProjectCredentialsSection

No horizontal dividers. Cards `w-full`.

### 1.3 Height at 1440×900 — calculation

| Element                           | Height (approx.) |
| --------------------------------- | ---------------- |
| Heading + subtitle                | ~56px            |
| gap + ProjectSwitcher (if absent) | 0px              |
| gap-4                             | 16px             |
| Top row (3 cards)                 | ~160px           |
| gap-4                             | 16px             |
| Bottom strip (HR + Credentials)   | ~140px           |
| Content total                     | ~388px           |
| + outer page padding              | ~48px            |
| **Total**                         | **~436px**       |

Significantly less than the 900px viewport — the "fits on one screen" goal is reached. (The current stack: ~1050px.)

### 1.4 What is removed

`QuickLinksBar` — the component and its render are removed entirely (item 2 of the task file, Coder).
The shortcuts `Легенда / Документы / Финансы` do not move into the hub — they are available from the side navigation (5 items). No duplication needed.

---

## 2. Credentials: revisiting placement and behavior (item 4 + item 6)

### 2.1 Problem with the current state

`ProjectCredentialsSection` — `col-span-full` as a separate strip, visually isolated. The heading «ПАРОЛИ ПРОЕКТА» + «Нет сохранённых паролей» — a poor state. The JUNIOR cannot add (only view+reveal). In the RBAC table from the task file: JUNIOR now gets add.

### 2.2 New placement in the bento

In the bottom strip next to `HrContactCard` (see §1.2). The advantage:

- The HR card is compact (~120px in height), Credentials gets all the remaining width.
- Visual logic: "who is responsible" (HR) + "what is needed for work" (passwords) — in one horizontal zone.

### 2.3 New prop `canAdd`

**RBAC change (round 2):** a JUNIOR project member can **create** entries (add). Edit/delete — still only ADMIN/HR.

```tsx
interface ProjectCredentialsSectionProps {
  projectId: string
  canEdit: boolean // edit + delete (ADMIN/HR → true; JUNIOR → false)
  canAdd?: boolean // create new (JUNIOR on their own project → true; everyone else inherits from canEdit)
}
```

The default `canAdd = canEdit` — backward compatibility. For JUNIOR: `canEdit={false} canAdd={true}`.

Rendering the "+ Добавить" button:

```tsx
// Was: canEdit
// Now: canEdit || canAdd
const showAddButton = canEdit || (canAdd ?? false)
```

### 2.4 Empty state for JUNIOR (with canAdd=true)

```
┌─ Card border-border/40 ─────────────────────────────────────────────────────────┐
│  [KeyRound h-4 w-4] ПАРОЛИ ПРОЕКТА                         [+ Добавить]         │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  Нет сохранённых паролей                          text-sm text-muted-foreground  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The "+ Добавить" button is shown to the JUNIOR (for the first time). Tooltip: `«Добавить аккаунт проекта»`.
`data-testid="credentials-add-btn"` — the same, AutoTest does not break.

### 2.5 List state for JUNIOR (canAdd=true, canEdit=false)

```
┌─ Card border-border/40 ─────────────────────────────────────────────────────────┐
│  [KeyRound] ПАРОЛИ ПРОЕКТА                                  [+ Добавить]         │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  [G] GitHub                                                              [👁]     │
│       login: john.doe@company.com · github.com                                   │
│       ••••••••                                                                    │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  [J] Jira                                                                [👁]     │
│       login: john.doe · jira.company.com                                         │
│       ••••••••                                                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Only `[👁]` (without `[✏] [🗑]`) — as in round 1. The "+ Добавить" button is present.

### 2.6 New data-testid (addition to the registry from project-credentials.md §12)

| testid                          | What                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `credentials-add-btn`           | The "+ Добавить" button — already in the registry, do NOT change   |
| `credentials-section`           | Already exists                                                     |
| `junior-hub-hr-credentials-row` | `flex` wrapper of the bottom strip (HR + Credentials) in the bento |

---

## 3. Junior profile — final layout (item 3)

### 3.1 Current state

Tabs: `Обзор / Проект / Команда / Реквизиты / Документы / Финансы` — 6 of them. Of these, Проект/Команда/Финансы are a data leak (see task §3 + `users-access.service.ts`).

### 3.2 Target tab allowlist for JUNIOR

The Coder changes `users-access.service.ts` — an allowlist (NOT a denylist):

```ts
// A JUNIOR views their own profile (isSelf && viewer.role === 'JUNIOR'):
tabs.push('overview', 'requisites', 'documents')
// do NOT include: 'projects', 'team', 'finance', 'interviews', 'contract'

// Someone views a JUNIOR's profile (target.role === 'JUNIOR'):
// ADMIN → all tabs (existing logic around line ~40 — keep)
// HR → overview + documents + requisites (existing logic)
// SENIOR → 0 tabs (existing logic at lines ~122-136 — keep)
```

### 3.3 How not to look empty with 3 tabs

After removing 3 tabs, 3 remain: "Обзор", "Реквизиты", "Документы". The risk — the tab bar looks sparse. Solution: **tighten the tabs via `gap`** and make sure `AnimatedTabs` does not stretch them to full width.

The current `AnimatedTabs` — check that the `tabs` container has `w-fit` or `inline-flex`, not `w-full`. If it is currently `w-full justify-between` — change to `w-fit gap-1` (Coder). 3 tabs with `w-fit` look dense and natural.

**The "Обзор" tab** — contributes the most to richness. Check that it contains:

- KPI cards (Зарплата / Способ выплат) — _already shown_ (see the screenshot `04-profile-current.jpeg`).
- Technologies — a badge list.
- Personal data — a form.

This is enough. The emptiness is _perceived_, not real. The main reason is the wide spacing between 6 tabs → with 3 tabs it will be better.

### 3.4 "Пароли проекта" section in the junior's profile (item 6 — a new surface for ADMIN/HR)

**Where:** in the "Обзор" tab of the JUNIOR profile (`OverviewTab`). Position — **after** the KPI cards (Зарплата/Способ выплат) and **before** the Технологии block.

**Who sees it:** only ADMIN and HR (per the visibility rules from `buildProfileView`). The JUNIOR themselves — does not see it (not needed: they have the hub).

**Implementation:** conditional render inside `OverviewTab`:

```tsx
// In OverviewTab (apps/web/app/components/user-profile/tabs/OverviewTab.tsx):
{
  user.role === 'JUNIOR' && permissions.fields.projectCredentials === true && (
    <ProfileCredentialsSection
      userId={user.id}
      canEdit={permissions.fields.editCredentials === true}
    />
  )
}
```

**New component `ProfileCredentialsSection`** (created by the Coder):

```
apps/web/app/components/user-profile/ProfileCredentialsSection.tsx
```

Endpoint: `GET /api/credentials?userId={juniorId}` with guard: `ADMIN || (HR && hrSharesActiveTeamWith(juniorId))`.
Behavior: analogous to `ProjectCredentialsSection` — list + reveal + edit (for ADMIN/HR). Reveal requires a separate `GET /api/credentials/:id/reveal?userId={juniorId}`.

**Visual structure** — identical to `ProjectCredentialsSection` (Card + CardHeader «ПАРОЛИ ПРОЕКТА» + list). Reuse the same component with a `userId` prop instead of `projectId`, or create `ProfileCredentialsSection` as a thin wrapper with a different hook.

### 3.5 permissions.fields extension

The Coder adds two new fields to the `buildProfileView` result:

```ts
fields: {
  // ...existing...
  projectCredentials: boolean // ADMIN || HR-own-team → true; others → false
  editCredentials: boolean // ADMIN → true; HR-own-team → true; others → false
}
```

### 3.6 Final RBAC table for the JUNIOR profile

| Viewer                     | Tabs                              | "Пароли" section   |
| -------------------------- | --------------------------------- | ------------------ |
| The JUNIOR themselves      | Обзор / Реквизиты / Документы     | Not shown          |
| ADMIN                      | All (existing logic)              | Shown, edit+reveal |
| HR (own team)              | overview + requisites + documents | Shown, edit+reveal |
| HR (other team)            | 0 tabs (403)                      | —                  |
| SENIOR / ACCOUNTANT / DROP | 0 tabs                            | —                  |

### 3.7 data-testid for the new section

| testid                                | What                                   |
| ------------------------------------- | -------------------------------------- |
| `profile-credentials-section`         | Root Card in ProfileCredentialsSection |
| `profile-credentials-add-btn`         | The "+ Добавить" button (ADMIN/HR)     |
| `profile-credentials-reveal-btn-{id}` | Reveal button in the profile           |
| `profile-credentials-edit-btn-{id}`   | Edit button (ADMIN/HR)                 |
| `profile-credentials-delete-btn-{id}` | Delete button (ADMIN/HR)               |

---

## 4. Date picker: fix of the «Выберите дату рождения» placeholder (item 5)

### 4.1 Diagnosis

File: `apps/web/app/routes/crm/legend.tsx:283`

```tsx
<DatePickerField
  value={field.state.value ?? ''}
  onChange={(v) => field.handleChange(v)}
  placeholder="Выберите дату рождения"
/>
```

Context: the form is `grid-cols-2 sm:grid-cols-2`, DatePickerField sits next to the "ФИО" Input in one cell. The trigger button in `date-picker.tsx` has `w-full justify-start`. The placeholder «Выберите дату рождения» (25 characters) + `CalendarIcon mr-2` = a text sum wider than the grid cell on small screens (<640px) and with the sidebar open at a ~900px viewport.

`date-picker.tsx` has no `truncate` on the text inside the button — the text widens the button or is cut off without an ellipsis.

### 4.2 Fix A — shorten the placeholder (recommended, zero cost)

Replace the long placeholder with a compact one:

```tsx
// Was:
placeholder = 'Выберите дату рождения'

// Now:
placeholder = 'Дата рождения'
```

«Дата рождения» = 14 characters (vs 25). Fits into any cell from 180px. The semantics are not lost — the Label above the field already says "Дата рождения".

### 4.3 Fix B — add `truncate` to DatePickerField (defensive, always apply)

File: `apps/web/app/components/ui/date-picker.tsx`

**Current code of lines 34–35:**

```tsx
;<CalendarIcon className="mr-2 h-4 w-4" />
{
  selected ? format(selected, 'dd MMM yyyy', { locale: ru }) : placeholder
}
```

**After the fix:**

```tsx
<CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
<span className="truncate">{selected ? format(selected, 'dd MMM yyyy', { locale: ru }) : placeholder}</span>
```

Changes:

- `shrink-0` on the icon — the icon does not shrink when space is short.
- `<span className="truncate">` — the text is cut off with an ellipsis instead of widening the button.
- The button already has `w-full` — `min-w-0` is not needed on it (the parent flex container is already `w-full`).

Apply both fixes together: A — in `legend.tsx`, B — in `date-picker.tsx`.

### 4.4 Before/after screenshot

The "before" screenshot — `docs/design/assets/junior-r2/03-datepicker-form-current.jpeg` (the form with a date already selected — does not reproduce the problem). The problem occurs with an **empty** value — the placeholder «Выберите дату рождения» overflows the button. The Coder takes the after screenshot after implementation (Mode D or in the PR).

---

## 5. Token map

All tokens come from `apps/web/app/styles/globals.css`. **No new tokens are added.**

| Purpose                        | Token                                      | Tailwind class            |
| ------------------------------ | ------------------------------------------ | ------------------------- |
| Bento cards                    | `--color-card`                             | `bg-card`                 |
| Card border                    | `--color-border`                           | `border-border/40`        |
| Primary text                   | `--color-foreground`                       | `text-foreground`         |
| Secondary text                 | `--color-muted-foreground`                 | `text-muted-foreground`   |
| Avatar initials background     | `--color-yellow-subtle`                    | `bg-yellow-subtle`        |
| Avatar initials text           | `--color-avatar-text`                      | `text-avatar-text`        |
| CTA buttons, Badge primary     | `--color-primary`                          | `bg-primary text-primary` |
| Credentials reveal zone        | `--color-muted`                            | `bg-muted/40`             |
| Errors                         | `--color-destructive`                      | `text-destructive`        |
| Card radius                    | `--radius-lg` = `var(--radius)` = 0.625rem | `rounded-lg`              |
| Radius of buttons inside cards | `--radius-md` = `calc(var(--radius)-2px)`  | `rounded-md`              |
| Amounts                        | CSS `font-variant-numeric: tabular-nums`   | `tabular-nums`            |

**Concentric radius**: the bottom strip (HR + Credentials) — `rounded-lg` on both Cards. The reveal container inside Credentials — `rounded-[calc(var(--radius)-4px)]` (as in project-credentials.md §4).

---

## 6. Motion spec

The same stagger pattern as in round 1 (`docs/design/junior-hub.md §5`):

```tsx
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] } },
}
```

On the move to the bento — the same `motion.div variants={card}` wrap each grid item. The bottom strip (HR + Credentials flex-row) — one `motion.div variants={card}` for the whole flex container, not two separate ones.

---

## 7. A11y critical paths (WCAG 2.2 AA)

### 7.1 Focus order of the new bento grid

The DOM order matches the visual one, left-to-right, top-to-bottom (CSS grid does not change the DOM order):

1. ProjectSwitcher (if >1 project)
2. ProjectInfoCard (no interactive elements)
3. PersonaCard → the "Открыть легенду" button
4. ContractStatusCard → the "Подписать" button (if visible)
5. SalarySnapshotCard → the "Все мои выплаты" link
6. HrContactCard → TG/phone links
7. ProjectCredentialsSection → the "+ Добавить" button → entry rows → [👁] buttons

On mobile ContractStatusCard and SalarySnapshotCard separate into different rows (1 column) — DOM order: Contract (row 3) → Salary (row 4). The visual and DOM orders match — the Tab order is logical.

### 7.2 Target size (SC 2.5.8)

| Element                           | Size             | Status                      |
| --------------------------------- | ---------------- | --------------------------- |
| "Открыть легенду" button          | `h-8` 32px       | ≥ 24px PASS                 |
| "+ Добавить" button (credentials) | `h-8` 32px       | ≥ 24px PASS                 |
| Reveal button `[👁]`               | `h-7 w-7` 28px   | ≥ 24px PASS                 |
| TG/phone links in HrContactCard   | `text-xs` inline | Check `min-h-[24px] py-0.5` |

### 7.3 Contrast (SC 1.4.3 / 1.4.11)

Tokens were checked in round 1 (junior-hub.md §6.3) — unchanged. The new element: the "+ Добавить" button for the JUNIOR — `Button variant="outline"`: `--foreground` on `--card` → >10:1 PASS.

### 7.4 Icon-only buttons (SC 1.1.1)

The "+ Добавить" button in Credentials contains text → `aria-label` is not needed. Reveal/copy/edit/delete — from project-credentials.md §8.4, unchanged.

### 7.5 Semantics of the bottom strip

```tsx
<section aria-label="HR и пароли проекта" className="col-span-full ...">
  <HrContactCard ... />
  <ProjectCredentialsSection ... />
</section>
```

Each Card inside keeps its own CardHeader/CardTitle — headings stay in the accessibility tree.

### 7.6 Reflow (SC 1.4.10)

`grid-cols-3` on lg → at 400% zoom on 1440px = effective width 360px → `grid-cols-1` (the mobile stack) kicks in. No horizontal overflow.

---

## 8. Edge cases

### 8.1 Bento grid

| Case                              | Behavior                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Salary not assigned               | SalarySnapshotCard: «Ставка не назначена» (italic muted). The card stays in the flex-col, minimal height. ContractStatusCard does not "stretch" beyond its natural height.           |
| Contract signed (no CTA)          | ContractStatusCard is short (~80px). SalarySnapshotCard with `flex-1` fills the right column.                                                                                        |
| No passwords + JUNIOR canAdd=true | Credentials: empty state + the "+ Добавить" button. The HR card does not "grow" to fill the space — `HrContactCard` `h-fit` (no `flex-1`).                                           |
| > 8 passwords                     | Credentials: `ScrollArea max-h-[480px]` (from project-credentials.md §9.2). The bottom strip may grow. On desktop this is ok — the user scrolls inside the ScrollArea, not the page. |
| Legend not filled in              | PersonaCard: initials «?», full name «—», role «—», CTA button «Открыть легенду». Unchanged vs round 1.                                                                              |
| HR not found                      | HrContactCard: compact empty state. The `w-[280px]` width is kept, it does not collapse — otherwise Credentials would take the whole row and look unbalanced.                        |

### 8.2 JUNIOR profile with 3 tabs

| Case                                      | Behavior                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| No documents (Documents tab empty)        | DocumentsTab: empty state «Нет документов». The tab stays in the tab bar.                                                                 |
| No requisites                             | RequisitesTab: empty state + a CTA to fill in. The tab stays.                                                                             |
| ADMIN views a JUNIOR's profile            | All tabs (existing logic `users-access.service.ts:40`). The "Контракт" tab is shown too (line 42 — `!isSelf && target.role !== 'ADMIN'`). |
| No passwords in the profile (ADMIN views) | `ProfileCredentialsSection`: empty state + the "+ Добавить" button.                                                                       |

---

## 9. Full data-testid registry (additions to round 1)

**New in round 2:**

| testid                                | What                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `junior-hub-bento`                    | Root `motion.div` of the bento grid (replaces `junior-hub` if renamed) |
| `junior-hub-hr-credentials-row`       | Flex wrapper of the bottom strip (HR + Credentials)                    |
| `profile-credentials-section`         | Root Card of `ProfileCredentialsSection` in the profile                |
| `profile-credentials-add-btn`         | The "+ Добавить" button in the profile                                 |
| `profile-credentials-reveal-btn-{id}` | Reveal button in the profile                                           |
| `profile-credentials-edit-btn-{id}`   | Edit button in the profile                                             |
| `profile-credentials-delete-btn-{id}` | Delete button in the profile                                           |

**Changes to existing testids:**

| testid                | Change                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `quick-links-bar`     | REMOVED (the component and `data-testid` are cut out, E2E is fixed by AutoTest) |
| `quick-link-legend`   | REMOVED (as part of QuickLinksBar)                                              |
| `credentials-add-btn` | KEPT — now visible to the JUNIOR too (`canAdd=true`)                            |

---

## 10. Russian texts (new/changed)

| Element                                                  | Text                                               |
| -------------------------------------------------------- | -------------------------------------------------- |
| DatePickerField placeholder (legend)                     | `«Дата рождения»` ← was `«Выберите дату рождения»` |
| Tooltip of the "+ Добавить" button (credentials, JUNIOR) | `«Добавить аккаунт проекта»`                       |
| Passwords section in the profile (heading)               | `«ПАРОЛИ ПРОЕКТА»` (the same pattern)              |
| Empty state of the section in the profile                | `«Нет сохранённых паролей»`                        |

---

## 11. Anti-patterns (Mode C checklist)

- No purple/gradient on the bento cards.
- No `rounded-2xl` everywhere — only `rounded-lg` (0.625rem) on Card + `rounded-md` inside.
- No `shadow-xl` on cards — only `border-border/40`.
- No decorative blobs/illustrations.
- No `transition: all` — only explicit properties (150ms bg-color/opacity/color).
- No Cards inside Cards (the credentials reveal block — a `div`, not a `Card`; HR and Credentials — parallel Cards in a flex-row, not nested).
- No AI-slop generic gradient hero on the hub — the hub stays `dense / quiet / scannable`.
- Placing passwords next to HR — functional logic, not decorative.

---

## 12. Handoff checklist for the Coder

### Item 1 — bento grid

- [ ] Replace `<motion.div className="space-y-4">` with `<motion.div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">` in `HubCards` (`project.tsx`)
- [ ] Wrap the right column (Contract + Salary) in `<motion.div className="flex flex-col gap-3">`
- [ ] Wrap the bottom strip (HR + Credentials) in `<section aria-label="HR и пароли проекта" className="col-span-full flex flex-col md:flex-row gap-4">`
- [ ] `HrContactCard` gets `className="md:w-[280px] shrink-0"` — add a `className` prop to the component
- [ ] Wrap `ProjectCredentialsSection` in `<div className="flex-1 min-w-0">`
- [ ] Remove `<motion.div variants={card}><QuickLinksBar /></motion.div>` and the `QuickLinksBar` component itself
- [ ] Remove unused imports (`BookOpen`, `FileText`, `DollarSign` if no longer needed)

### Item 2 — QuickLinksBar removal (task §2)

- [ ] Remove `function QuickLinksBar()` and its render in `HubCards`
- [ ] Check E2E for the `quick-links-bar` / `quick-link-legend` testids — remove or update (AutoTest zone)

### Item 3 — credentials canAdd

- [ ] `ProjectCredentialsSectionProps`: add `canAdd?: boolean`
- [ ] The "+ Добавить" button is shown when `canEdit || (canAdd ?? false)`
- [ ] In `project.tsx`: `<ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd={true} />`

### Item 4 — date-picker fix

- [ ] `apps/web/app/routes/crm/legend.tsx:283`: placeholder `"Выберите дату рождения"` → `"Дата рождения"`
- [ ] `apps/web/app/components/ui/date-picker.tsx`: `CalendarIcon` + `shrink-0`; text in `<span className="truncate">`
- [ ] Playwright before/after screenshot with an empty value (the legend.tsx persona form without a date)

### Item 5 — JUNIOR profile (frontend, no backend)

- [ ] `users-access.service.ts`: allowlist for the JUNIOR self-view: `tabs.push('overview', 'requisites', 'documents')` — remove `'projects', 'team', 'finance'`
- [ ] Check `AnimatedTabs` — 3 tabs do not stretch to full width (w-fit/inline-flex container)
- [ ] Backend: `buildProfileView` — make sure projects/team/finance data does not leak into the DTO on a JUNIOR self-view (security-reviewer checks)

### Item 6 — ProfileCredentialsSection (security-critical — requires security-reviewer)

- [ ] New component `ProfileCredentialsSection.tsx`
- [ ] New hook `use-profile-credentials.ts` (endpoint `GET /api/credentials?userId={id}`)
- [ ] Backend: endpoint + guard `ADMIN || hrSharesActiveTeamWith`
- [ ] `users-access.service.ts`: add `fields.projectCredentials` and `fields.editCredentials`
- [ ] `OverviewTab.tsx`: conditional render of `ProfileCredentialsSection` for a JUNIOR target
- [ ] security-reviewer MANDATORY: RBAC integration spec (403 for other teams' HR, SENIOR/ACCOUNTANT/DROP)

### Post-implementation

- [ ] `eslint lint-files` on the changed `.tsx` files
- [ ] `pnpm typecheck` (turbo cache bypass: `--force`)
- [ ] Playwright screenshot: hub at 1440px (one screen?), hub at 375px (mobile)
- [ ] Lighthouse: the layout adds no CLS (grid instead of space-y should not)
- [ ] Contrast: "+ Добавить" for the JUNIOR — Button variant="ghost"/"outline" on `bg-card`

---

## 13. Open questions for the PM

1. **`HrContactCard` width of 280px** — on narrow 768px-824px viewports the bottom strip may look uneven (a fixed HR card, narrow Credentials). Alternative: `min-w-[200px] max-w-[300px]`. Clarify with the Coder's visual check.

2. **`ProfileCredentialsSection` in the profile** — a separate component or shared reuse of `ProjectCredentialsSection` with a new prop `mode="profile" userId=`? Reuse is cheaper, but requires conditional hook logic (projectId vs userId). I leave it to the Coder — pick the cheaper option without duplicating the core reveal logic.

3. **JUNIOR add credentials — migration?** — if the backend already has an RBAC check on create credential (only ADMIN/HR), then adding JUNIOR will require extending `credentials.service.ts`. Check `apps/api/src/credentials/credentials.service.ts` — whether the guard needs a migration. This is the security-reviewer's zone.

4. **Date-picker before/after screenshot** — because test data has no empty value (Sofia's date is filled in), reproducing the problem via Playwright is hard without clearing the field. The Coder takes the screenshot during implementation (open the form → clear manually → screenshot).
