# Design Spec: Junior Hub Round 3 — Dense Bento, No Contract, No Empty Space

> Mode A → B — Design Direction (round 3, post-UT feedback #184)
> Spec slug: `junior-hub-round3`
> Source: owner UT feedback (2026-06-13) — "still limping, looks raw, empty spaces"
> Precedents: `docs/design/junior-hub-round2.md` (round 2, implemented in #184) · `docs/design/drop-role-ux.md` (unified language)
> Author: ui-ux-designer · 2026-06-13
> "Before" screenshot: `docs/design/assets/junior-r3/01-before-1440.jpeg`

---

## 0. Diagnosis (why round 2 came out raw)

### Measured heights at 1440×900 (live stack after #184)

| Component          | Actual height | Content height | Emptiness  |
| ------------------ | ------------- | -------------- | ---------- |
| ProjectInfoCard    | 397px         | ~130px         | **~267px** |
| PersonaCard        | 397px         | ~160px         | **~237px** |
| ContractStatusCard | 113px         | 113px          | 0px        |
| SalarySnapshotCard | 272px         | 272px          | 0px        |
| HrContactCard      | 154px         | 154px          | 0px        |
| ProjectCredentials | 239px         | 239px          | 0px        |

### Root cause

1. **`h-full` on the top-row cards** — ProjectInfoCard and PersonaCard get `h-full`, which in a CSS grid stretches them to the height of the tallest cell in the row (397px). But in the left cell: logo + company + 2 data rows = ~130px. In the middle: avatar + name + button = ~160px. The difference ~240px is pure emptiness.

2. **The content in PersonaCard is pinned neither up nor down** — `flex-col gap-4` without `justify-between`. The avatar sits at the top, the button under it, the bottom ~120px are empty.

3. **ContractStatusCard is skinny (113px)** — only a "Подписан" badge next to a filled SalaryCard (272px). In a flex-col this looks fine, but it creates a visual imbalance: the right column starts with a small card, then a big one.

4. **The bottom strip is unbalanced** — HrContactCard 154px, Credentials 239px. HR visually "does not reach".

5. **A 3-column layout with a skinny left column** — at 1440px each column is 304px. ProjectInfo at 304px looks loose — company, domain, start, status — just 4 data rows in a column 304px wide.

### Conclusion

Round 2 solved the scroll problem (the content fits into 900px vertically), but did not solve the problem of **horizontal air**. The cards stretch in height to align even though there is no content. The solution — remove `h-full`, switch to `items-start` in the grid, and restructure the cards so that the content truly fills them.

---

## 1. New hub architecture (round 3)

### 1.1 Redesign principles

- **No contract** — `ContractStatusCard` is removed entirely (UT requirement). The space goes to salary.
- **No `h-full` on skinny cards** — cards are `h-fit`, the grid gets `items-start` so rows do not stretch.
- **Content fills the cards** — we add the HR contact to ProjectInfoCard (it is compact); PersonaCard gets `justify-between` + additional persona data.
- **Salary expands** — without ContractCard the col-span on the right is freed: salary takes the full right column from the top.
- **Bottom strip** — only Credentials (full-width), no separate HR (HR moved into ProjectInfoCard).

### 1.2 Logical blocks (new grouping)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Мой проект · LearnSpace Inc                                                  │
├──────────────────────────┬──────────────────────────────────────────────────┤
│  О ПРОЕКТЕ               │  МОЯ ЗАРПЛАТА                                   │
│  col-span-1 (lg: 4/12)   │  col-span-1 (lg: 8/12)  — wide                  │
│                          │                                                  │
│  [Лого] LearnSpace Inc   │  [amount, large]  500 USD / мес                 │
│         learnspace.io    │                                                  │
│  ────────────────────    │  [payouts] last 3 in horizontal rows             │
│  Старт   05 янв 2026     │                                                  │
│  Статус  Активный        │  [→ Все мои выплаты]                            │
│  ────────────────────    │                                                  │
│  Ваш HR                  │                                                  │
│  Anna Lysenko            │                                                  │
│  TG · Phone              │                                                  │
├──────────────────────────┤                                                  │
│  СИНЬОР ПРОЕКТА          │                                                  │
│  col-span-1 (lg: 4/12)   │                                                  │
│                          │                                                  │
│  [Аватар] фыв фыв ф фыв  │                                                  │
│           фывфыв         │                                                  │
│  [Открыть легенду]       │                                                  │
├──────────────────────────┴──────────────────────────────────────────────────┤
│  ПАРОЛИ ПРОЕКТА                         col-span-full                       │
│  [+ Добавить] · credentials list horizontally in 2 columns                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Grid structure (Tailwind)

**Desktop ≥ 1024px (12-col subgrid pattern via a 3-col grid with col-span)**

```tsx
// Outer grid: 3 columns, items-start (critical — without the h-full stretch)
<motion.div
  className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start"
  data-testid="junior-hub-bento"
>
  {/* Left column: О проекте + Синьор stacked */}
  <div className="lg:col-span-1 flex flex-col gap-4">
    <ProjectInfoCard project={project} hrContact={hrContact} />
    <PersonaCard legend={legend} isLoading={legendLoading} />
  </div>

  {/* Right column: Salary — wide (2/3 of the width) */}
  <div className="lg:col-span-2">
    <SalarySnapshotCard salaryMeta={salaryMeta} salaryTxs={salaryTxs} isLoading={salaryLoading} />
  </div>

  {/* Bottom strip: Credentials full-width */}
  <div className="col-span-full">
    <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd />
  </div>
</motion.div>
```

**Key changes from round 2:**

- `items-start` on the grid → cards do NOT stretch to the row height
- The left `div` wrapper (not `motion.div`) for the `flex-col gap-4` stack of ProjectInfo + Persona
- `lg:col-span-2` for SalaryCard — takes 2/3 of the width, visually dominates
- HR moves inside ProjectInfoCard (instead of a separate `HrContactCard`)
- No `ContractStatusCard` at all
- No separate `HrContactCard` in the bottom strip

**Tablet 768–1023px (2 columns):**

```tsx
className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start'
```

At md: the left `div` — col-1, the right div (Salary) — col-1 → 2 equal columns. Credentials — col-span-full.

**Mobile < 768px (1 column, order):**

1. ProjectInfoCard (with HR inside)
2. PersonaCard
3. SalarySnapshotCard
4. ProjectCredentialsSection

### 1.4 Height calculation at 1440×900

| Element                              | Height (approx.)    |
| ------------------------------------ | ------------------- |
| Heading h1 + subtitle                | ~56px               |
| gap-4                                | 16px                |
| Top row (left column — stack)        | ~280px              |
| ↳ ProjectInfoCard (with HR embedded) | ~170px              |
| ↳ gap-4                              | 16px                |
| ↳ PersonaCard (compact)              | ~104px              |
| Right column (Salary, wide)          | ~260px (≤ the left) |
| gap-4                                | 16px                |
| Credentials (full-width)             | ~180px              |
| **Content total**                    | **~344px**          |
| + page padding (py-6)                | ~48px               |
| **Total**                            | **~404px**          |

Significantly less than 900px — the hub on one screen. The left and right columns are aligned by `items-start`, visually height-matched through a similar volume of content.

---

## 2. Changes in each card

### 2.1 ProjectInfoCard — add the HR contact

**Round 2 problem:** ProjectInfoCard contains 4 rows (logo, domain, start, status). At 304px this looks loose. `h-full` stretched it to 397px — 267px of emptiness.

**Round 3:** embed the HR contact directly in ProjectInfoCard as a section below. Remove `h-full`.

```
┌─ Card border-border/40 ──────────────────────────────────────┐
│  [Лого] LearnSpace Inc                                        │
│         learnspace.io                                         │
│  ─────────────────────────────────────────────────────────── │
│  Старт   05 января 2026 г.                                    │
│  Статус  [Активный]                                           │
│  ─────────────────────────────────────────────────────────── │
│  Ваш HR                     (text-xs text-muted-foreground)   │
│  Anna Lysenko               (text-sm font-medium)             │
│  [TG] @anna_lysenko · [Phone] +38...                         │
└──────────────────────────────────────────────────────────────┘
```

**Implementation:**

```tsx
function ProjectInfoCard({
  project,
  hrContact,
  hrLoading,
}: {
  project: ProjectDto
  hrContact: HrContactDto | null
  hrLoading: boolean
}) {
  const isActive = !project.archivedAt

  return (
    <Card className="border-border/40 bg-card" data-testid="project-info-card">
      <CardHeader className="flex flex-row items-start gap-3 pb-3">
        <ProjectLogo ... />
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold leading-tight truncate">
            {project.companyName}
          </CardTitle>
          {project.domain && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{project.domain}</p>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3 text-sm">
        {/* Project meta */}
        <div className="space-y-2">
          {project.startDate && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Старт</span>
              <span className="font-medium text-xs">
                {new Date(project.startDate).toLocaleDateString('ru-RU', {
                  day: '2-digit', month: 'long', year: 'numeric',
                })}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Статус</span>
            <Badge variant={isActive ? 'status-active' : 'status-closed'} className="text-xs">
              {isActive ? 'Активный' : 'Завершён'}
            </Badge>
          </div>
        </div>

        {/* HR contact — embedded, no separate card */}
        <Separator className="opacity-30" />
        <HrInline hrContact={hrContact ?? null} isLoading={hrLoading} />
      </CardContent>
    </Card>
  )
}

// Compact inline HR — NOT a separate Card
function HrInline({ hrContact, isLoading }: { hrContact: HrContactDto | null; isLoading: boolean }) {
  if (isLoading) return <Skeleton className="h-4 w-32" />

  const hasContact = hrContact?.displayName || hrContact?.telegram || hrContact?.phone

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">Ваш HR</p>
      {!hasContact ? (
        <p className="text-xs text-muted-foreground/60 italic">HR не назначен</p>
      ) : (
        <div className="space-y-1.5">
          {hrContact?.displayName && (
            <p className="text-sm font-medium">{hrContact.displayName}</p>
          )}
          <div className="flex flex-wrap gap-3">
            {hrContact?.telegram && (
              <a href={`https://t.me/${hrContact.telegram.replace(/^@/, '')}`}
                 target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]">
                <Send className="h-3 w-3 shrink-0" />
                {hrContact.telegram}
              </a>
            )}
            {hrContact?.phone && (
              <a href={`tel:${hrContact.phone}`}
                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]">
                <Phone className="h-3 w-3 shrink-0" />
                {hrContact.phone}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

**Removed:** `function HrContactCard()` and all the `HrContactCard` code. The props `hrContact` and `hrLoading` are passed into `ProjectInfoCard`.

**data-testid changes:**

| Old testid                      | New testid                               | Change                                |
| ------------------------------- | ---------------------------------------- | ------------------------------------- |
| `hr-contact-card`               | `hr-inline` (inside `project-info-card`) | Moved inside ProjectInfoCard          |
| `junior-hub-hr-credentials-row` | REMOVED                                  | No flex-row wrapper of HR+Credentials |

### 2.2 PersonaCard — `justify-between` + remove h-full

**Round 2 problem:** `h-full` + `flex-col gap-4` — the avatar/name stand at the top, the button under them, the bottom ~120px are empty.

**Round 3:** Remove `h-full`. The card is `h-fit`. PersonaCard now stands in a `flex-col gap-4` together with ProjectInfoCard — their combined height matches the SalaryCard on the right.

```tsx
<Card className="border-border/40 bg-card" data-testid="persona-card">
  {/* CardContent: flex-col, without justify-between — no h-full, no forced height */}
  <CardHeader className="flex flex-row items-center justify-between pb-3">
    <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
  </CardHeader>
  <CardContent className="flex flex-col gap-3">
    <div className="flex items-center gap-3">
      <Avatar className="h-10 w-10 shrink-0">
        {' '}
        {/* h-12 → h-10: more compact */}
        <AvatarFallback className="bg-yellow-subtle text-avatar-text font-bold text-sm">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="font-semibold text-sm leading-tight truncate" data-testid="persona-fullname">
          {fullName ?? '—'}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate" data-testid="persona-role">
          {presentedRole ?? '—'}
        </p>
      </div>
    </div>
    <Button
      size="sm"
      variant="outline"
      className="w-full gap-2"
      onClick={() => void navigate({ to: '/crm/legend' })}
      data-testid="persona-open-legend-btn"
      aria-label="Открыть легенду"
    >
      <BookOpen className="h-3.5 w-3.5" />
      Открыть легенду
    </Button>
  </CardContent>
</Card>
```

Changes from round 2:

- `h-full` → remove (now `h-fit` by default)
- `gap-4` → `gap-3` (~10px more compact)
- Avatar `h-12 w-12` → `h-10 w-10` (minor, but denser)
- No `className="lg:col-span-1"` on the motion.div wrapper — PersonaCard goes into the `flex-col` stack

### 2.3 SalarySnapshotCard — wide (col-span-2), content enrichment

**Round 2 problem:** Salary took 1/3 of the width (304px) while being the most informative card. Now we remove ContractCard, salary gets 2/3 (≈624px at 1440px).

**Round 3:** Salary expands. We use the extra width to improve the readability of payouts — the 3 latest payouts are shown as full-fledged rows (not compact). "Все мои выплаты" — a button, not just a link.

```tsx
function SalarySnapshotCard({ salaryMeta, salaryTxs, isLoading, className }) {
  // ... similar loading skeleton
  return (
    <Card className={cn('border-border/40 bg-card', className)} data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rate display */}
        {hasRate ? (
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums" data-testid="salary-rate-amount">
              {Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU')}
            </span>
            <span className="text-sm text-muted-foreground uppercase">
              {salaryMeta!.salaryCurrency ?? ''}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">/ мес</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
            Ставка не назначена
          </p>
        )}

        {/* Last 3 payments — visible even without hasRate */}
        {salaryTxs.length > 0 && (
          <div className="space-y-2" data-testid="salary-tx-list">
            <p className="text-xs text-muted-foreground">Последние выплаты</p>
            {salaryTxs.map((tx) => {
              const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0"
                  data-testid="salary-tx-row"
                >
                  <span className="text-sm text-muted-foreground">
                    {tx.salaryMonth ??
                      new Date(tx.createdAt).toLocaleDateString('ru-RU', {
                        month: 'long',
                        year: 'numeric',
                      })}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-sm font-medium">
                      {Number(tx.amount).toLocaleString('ru-RU')} {tx.currency}
                    </span>
                    <Badge variant={isPaid ? 'paid' : 'pending'} className="text-xs">
                      {isPaid ? 'Выплачено' : 'Ожидание'}
                    </Badge>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Link to /crm/finance */}
        <Link
          to="/crm/finance"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="salary-all-link"
        >
          <ExternalLink className="h-3 w-3" />
          Все мои выплаты
        </Link>
      </CardContent>
    </Card>
  )
}
```

Changes from round 2:

- `text-2xl` → `text-3xl` for the amount (the wide card allows it)
- Payout row dividers: `border-b border-border/20` instead of `<Separator className="opacity-30" />`
- Added a section heading «Последние выплаты» above the list
- The `className` prop is kept for compatibility

### 2.4 ContractStatusCard — REMOVE

The card is removed from `project.tsx` entirely. The `useMyContract()` hook is removed too (if it is not used elsewhere — check imports).

**Remove:**

- `function ContractStatusCard()`
- `function useMyContract()`
- Imports: `ContractStatusMeDto`, `contractStatusMeDtoSchema`
- Variables: `contract`, `contractLoading`, `contractError` from `HubCards`

**data-testids that are removed:**

| testid                  | Status  |
| ----------------------- | ------- |
| `contract-status-card`  | REMOVED |
| `contract-status-badge` | REMOVED |
| `contract-sign-btn`     | REMOVED |

If E2E tests (`apps/e2e/**`) reference these testids — the AutoTest agent fixes them.

### 2.5 ProjectCredentialsSection — full-width, 2-column layout

**Round 2 problem:** Credentials took the bottom strip next to HrContactCard. Now HR has moved into ProjectInfoCard. Credentials gets the full width.

**Round 3:** `col-span-full` on Credentials. If there are >= 2 accounts — show the list in 2 columns (`grid grid-cols-1 sm:grid-cols-2 gap-2` inside `ProjectCredentialsSection`).

This change is inside the `ProjectCredentialsSection.tsx` component (not in `project.tsx`):

```tsx
// In ProjectCredentialsSection — the items list:
<div className={cn(
  'gap-2',
  items.length >= 2 ? 'grid grid-cols-1 sm:grid-cols-2' : 'flex flex-col'
)}>
  {items.map((cred) => <CredentialItem key={cred.id} ... />)}
</div>
```

This fills the wide space without gaps. With 1 entry — 1 column. With 2+ — 2 columns, each ~50% of the width.

---

## 3. HubCards — final template

```tsx
function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)
  // ContractStatusCard removed: useMyContract() is removed
  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
      variants={container}
      initial="hidden"
      animate="show"
      data-testid="junior-hub-bento"
    >
      {/* Left stack: О проекте (with HR) + Синьор проекта */}
      <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
        <ProjectInfoCard project={project} hrContact={hrContact ?? null} hrLoading={hrLoading} />
        <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
      </motion.div>

      {/* Right wide: Моя зарплата — col-span-2 */}
      <motion.div variants={card} className="lg:col-span-2">
        <SalarySnapshotCard
          salaryMeta={salaryMeta ?? null}
          salaryTxs={salaryTxs ?? []}
          isLoading={salaryLoading}
        />
      </motion.div>

      {/* Bottom full-width: Пароли проекта */}
      <motion.div variants={card} className="col-span-full">
        <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd />
      </motion.div>
    </motion.div>
  )
}
```

**Removed imports from project.tsx:**

```tsx
// REMOVE:
import type { ContractStatusMeDto } from '@crm/shared'
import { contractStatusMeDtoSchema } from '@crm/shared'
import { CheckCircle2 } from 'lucide-react'
// HrContactCard — remove the function, keep the className import (used elsewhere)
```

---

## 4. Skeleton loading — update

The current skeleton in `JuniorProjectHub` reflects the old structure (2×2 + full-width + a small one). It must be updated for the new layout:

```tsx
if (projectsLoading) {
  return (
    <div className="space-y-4" data-testid="junior-hub">
      <Skeleton className="h-7 w-44" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
        {/* Left stack */}
        <div className="lg:col-span-1 flex flex-col gap-4">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        {/* Right wide */}
        <div className="lg:col-span-2">
          <Skeleton className="h-56 rounded-lg" />
        </div>
        {/* Bottom */}
        <div className="col-span-full">
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    </div>
  )
}
```

---

## 5. Responsive behavior

### Desktop 1440px (3-col grid)

- Left stack (ProjectInfo+Persona): `lg:col-span-1` = 1/3 of the width ≈ 456px (accounting for the gap)
- Right Salary: `lg:col-span-2` = 2/3 of the width ≈ 928px
- Bottom Credentials: `col-span-full`

### Tablet 768–1023px (2-col grid)

- At `md:grid-cols-2`: left stack col-1, right Salary col-1 — equal columns
- Credentials — `col-span-full`

### Mobile < 768px (1-col stack)

1. ProjectInfoCard (with HR embedded)
2. PersonaCard
3. SalarySnapshotCard
4. ProjectCredentialsSection

### Overflow check (mandatory before merge)

- [ ] 320px: no horizontal overflow
- [ ] 768px: tablet layout is correct
- [ ] 1024px: the 2→3 col transition works
- [ ] 1440px: the hub on 1 screen, no gaps

---

## 6. Token map

All tokens come from `apps/web/app/styles/globals.css`. **No new tokens are added.**

| Purpose                    | Token                                    | Tailwind class            |
| -------------------------- | ---------------------------------------- | ------------------------- |
| Bento cards                | `--color-card`                           | `bg-card`                 |
| Card border                | `--color-border`                         | `border-border/40`        |
| Primary text               | `--color-foreground`                     | `text-foreground`         |
| Secondary text             | `--color-muted-foreground`               | `text-muted-foreground`   |
| Avatar initials background | `--color-yellow-subtle`                  | `bg-yellow-subtle`        |
| Avatar initials text       | `--color-avatar-text`                    | `text-avatar-text`        |
| CTA buttons                | `--color-primary`                        | `bg-primary text-primary` |
| Dividers                   | `--color-border` × 0.2 opacity           | `border-border/20`        |
| Errors                     | `--color-destructive`                    | `text-destructive`        |
| Card radius                | `--radius-lg` = 0.625rem                 | `rounded-lg`              |
| Button radius              | `--radius-md` = calc(var(--radius)-2px)  | `rounded-md`              |
| Amounts                    | CSS `font-variant-numeric: tabular-nums` | `tabular-nums`            |

**Concentric radius:** buttons inside cards `rounded-md`, cards `rounded-lg`. The Credentials reveal container — `rounded-[calc(var(--radius)-4px)]`.

---

## 7. Motion spec

The stagger pattern is kept from round 2:

```tsx
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}
```

`motion.div variants={card}` — three of them:

1. The left stack wrapper (animates ProjectInfo + Persona as a single block)
2. SalaryCard (col-span-2)
3. Credentials (col-span-full)

This is right: stagger at the grid-item level, not at the level of each separate card inside the stack.

---

## 8. A11y critical paths (WCAG 2.2 AA)

### 8.1 Focus order

The DOM order matches the visual one (grid + CSS do not shuffle the DOM):

1. ProjectSwitcher (if > 1 project)
2. ProjectInfoCard → TG/phone links (HrInline)
3. PersonaCard → the "Открыть легенду" button
4. SalarySnapshotCard → the "Все мои выплаты" link
5. ProjectCredentialsSection → "+ Добавить" → rows → [👁] buttons

### 8.2 Target size (SC 2.5.8)

| Element                           | Size           | Status      |
| --------------------------------- | -------------- | ----------- |
| "Открыть легенду" button          | `h-8` 32px     | ≥ 24px PASS |
| "+ Добавить" button (credentials) | `h-8` 32px     | ≥ 24px PASS |
| TG/phone links (HrInline)         | `min-h-[24px]` | ≥ 24px PASS |
| Reveal button `[👁]`               | `h-7 w-7` 28px | ≥ 24px PASS |

### 8.3 Contrast (SC 1.4.3)

Tokens were checked in round 1/2. HrInline links: `text-muted-foreground` (L=0.58) on `bg-card` (dark L=0.12) → ≈3.5:1 for decorative/UI elements (SC 1.4.11 ≥ 3:1 PASS). On hover: `text-foreground` (L=0.97) → 14:1 PASS.

### 8.4 Semantics

```tsx
// ProjectInfoCard CardContent:
<section aria-label="Контакт HR">  // HrInline wrapper
  <HrInline ... />
</section>
```

HrInline contains an `<a>` with visible text → `aria-label` is not needed.

### 8.5 Reflow (SC 1.4.10)

`grid-cols-3` → at 400% zoom on 1440px effective width ≈ 360px → `grid-cols-1` kicks in. No horizontal overflow.

---

## 9. Anti-pattern checklist (Mode C)

- No purple/gradient on cards.
- No `rounded-2xl` everywhere — only `rounded-lg` Card + `rounded-md` inside.
- No `shadow-xl` — only `border-border/40`.
- No decorative blobs.
- No `transition: all` — only explicit properties.
- No Cards inside Cards (HrInline — a `div`, not a `Card`; the former HrContactCard is removed).
- No generic hero section.
- SalaryCard at 2/3 of the width — functional logic (salary is the junior's main interest), not decorative.
- `text-3xl` for the salary amount — the only size accent, not everywhere.

---

## 10. Edge cases

| Case                              | Behavior                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Salary not assigned               | SalaryCard: «Ставка не назначена» + payout list (if any). The card is `h-fit` — short.                               |
| No payouts                        | SalaryCard: only the rate amount (or italic «Ставка не назначена»). No empty dividers.                               |
| HR not assigned                   | HrInline (inside ProjectInfoCard): italic «HR не назначен». ProjectInfoCard does not expand beyond its content.      |
| Legend not filled in              | PersonaCard: initials «?», full name «—», role «—», CTA button «Открыть легенду» (unchanged).                        |
| > 8 passwords                     | Credentials: `ScrollArea max-h-[480px]` (from project-credentials.md §9.2). A 2-col grid inside the ScrollArea.      |
| 1 password                        | Credentials: 1-col layout (no `sm:grid-cols-2`). Does not look loose — the [👁] buttons are pinned to the right edge. |
| Project finished (isActive=false) | StatusBadge «Завершён», the rest of the content unchanged.                                                           |

---

## 11. data-testid registry (changes from round 2)

### Removed

| testid                          | Reason                                                |
| ------------------------------- | ----------------------------------------------------- |
| `hr-contact-card`               | HrContactCard removed, HR embedded in ProjectInfoCard |
| `junior-hub-hr-credentials-row` | the HR+Credentials flex wrapper removed               |
| `contract-status-card`          | ContractStatusCard removed                            |
| `contract-status-badge`         | Part of ContractStatusCard                            |
| `contract-sign-btn`             | Part of ContractStatusCard                            |

### Added

| testid      | What                                               |
| ----------- | -------------------------------------------------- |
| `hr-inline` | `div` container of HrInline inside ProjectInfoCard |

### Kept (unchanged)

| testid                    | What                                 |
| ------------------------- | ------------------------------------ |
| `project-info-card`       | ProjectInfoCard (now with HR inside) |
| `persona-card`            | PersonaCard                          |
| `persona-fullname`        | Persona name                         |
| `persona-role`            | Persona role                         |
| `persona-open-legend-btn` | The "Открыть легенду" button         |
| `salary-snapshot-card`    | SalarySnapshotCard                   |
| `salary-rate-amount`      | Rate amount                          |
| `salary-tx-list`          | Transaction list                     |
| `salary-tx-row`           | Transaction row                      |
| `salary-all-link`         | The "Все мои выплаты" link           |
| `junior-hub-bento`        | Root motion.div                      |
| `credentials-section`     | ProjectCredentialsSection            |
| `credentials-add-btn`     | The "+ Добавить" button              |

---

## 12. Handoff checklist for the Coder

### apps/web/app/routes/crm/project.tsx

- [ ] `HubCards`: replace the grid with `className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"` (add `items-start`)
- [ ] Wrap the left column in `<motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">` — ProjectInfoCard + PersonaCard go there
- [ ] Wrap SalarySnapshotCard in `<motion.div variants={card} className="lg:col-span-2">`
- [ ] Wrap Credentials in `<motion.div variants={card} className="col-span-full">`
- [ ] Remove the `<section aria-label="HR и пароли проекта"...>` flex wrapper (no longer needed)
- [ ] Remove `function HrContactCard()` and all its props/usages in HubCards
- [ ] Remove `function ContractStatusCard()` and `function useMyContract()`
- [ ] Remove from HubCards: `const { data: contract, isLoading: contractLoading, isError: contractError } = useMyContract()`
- [ ] Remove unused imports: `ContractStatusMeDto`, `contractStatusMeDtoSchema`, `CheckCircle2`
- [ ] `ProjectInfoCard`: add the props `hrContact: HrContactDto | null` and `hrLoading: boolean`; embed the `HrInline` component (or an inline section) as in §2.1
- [ ] `PersonaCard`: remove `h-full` from Card; `gap-4` → `gap-3`; Avatar `h-12 w-12` → `h-10 w-10`
- [ ] Update the skeleton in `JuniorProjectHub` for the new layout (§4)
- [ ] `SalarySnapshotCard`: `text-2xl` → `text-3xl` for the amount; add the heading «Последние выплаты» above the list; dividers via `border-b border-border/20` instead of `<Separator>`

### apps/web/app/components/projects/ProjectCredentialsSection.tsx

- [ ] Items list: `flex flex-col` → `grid grid-cols-1 sm:grid-cols-2 gap-2` when `items.length >= 2` (§2.5)
- [ ] Check that the `canAdd` prop works (from round 2, unchanged)

### E2E (AutoTest zone)

- [ ] Remove/update tests for `hr-contact-card`, `junior-hub-hr-credentials-row`, `contract-status-card`, `contract-status-badge`, `contract-sign-btn`
- [ ] Add a check of `hr-inline` inside `project-info-card`
- [ ] Check that `salary-snapshot-card` renders at `lg:col-span-2` (visually wider)

---

## 13. Open questions for the PM

1. **Is `useMyContract` used anywhere else?** — the Coder checks before removing. If it is used on the `/crm/onboarding` page or another route — keep the hook as shared, just remove it from `project.tsx`.

2. **2-column credentials layout** — a change inside `ProjectCredentialsSection.tsx`. This affects not only the junior hub but also the ADMIN/HR views (they see Credentials on the project). Make sure the 2-col grid does not break the ADMIN interface. If in doubt — do it through a prop `twoColumn?: boolean` on `ProjectCredentialsSection`.

3. **SalarySnapshotCard widened to col-span-2** — on mobile/tablet it is col-span-1 (one column). Visually check 768px: SalaryCard next to the left stack — are the heights equal? If salary is short (no payouts) — the left stack is taller, emptiness on the right. Candidate for `items-start` → OK.

4. **Contract for a JUNIOR with the READY_TO_SIGN status** — after removing ContractStatusCard the "Подписать контракт" CTA disappears from the hub. Should the notification about an unsigned contract be moved elsewhere (e.g. a toast or a banner at the top of the hub)? The current UT requirement is "remove the contract". Clarify with the owner: "remove the card" or "remove any mention of the contract at all".
