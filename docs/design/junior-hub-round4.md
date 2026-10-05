# Design Spec: Junior Hub Round 4 — Equal-Height Columns + Redesigned Salary Card

> Mode B → D — Visual Audit + Design Direction (round 4, post-UT feedback #188)
> Spec slug: `junior-hub-round4`
> Source: owner UT feedback (2026-06-13) — "the right column «Моя зарплата» is shorter than the left stack → emptiness at the bottom right; looks poor"
> Precedents: `docs/design/junior-hub-round3.md` (round 3, implemented in #188)
> Author: ui-ux-designer · 2026-06-13
> "Before" screenshot: `docs/design/assets/junior-r4/01-before-1440.jpeg`

---

## 0. Diagnosis (why round 3 produced unequal height)

### Real 1440×900 snapshot (live stack after #188)

```
Left stack (col-span-1):
  ├── ProjectInfoCard    ~380px  (logo, domain, start, status, HR contact)
  ├── gap-4              16px
  └── PersonaCard        ~155px  (avatar, name, role, button)
  ──────────────────────────────
  Left column total:     ~551px

Right column (col-span-2):
  └── SalarySnapshotCard ~415px  (heading, 500 USD, 3 payout rows, link)

Difference:              ~136px of emptiness at the bottom right
```

### Root cause

Round 3 applied `items-start` on the grid container — a correct fix of round 2
(it removed the `h-full` stretching inside the cards). But `items-start` has a consequence:
every grid item has `align-self: start`, i.e. takes exactly as much height
as its content. The left stack extends to PersonaCard (~551px), the right SalaryCard —
to "Все мои выплаты" (~415px). The 136px difference is visual emptiness.

Three solution options:

1. **A — purely content**: add so much content to SalaryCard that it reaches the height
   naturally. Problem: the data is unstable (there may be 0–3 rows).
2. **B — CSS stretch + left self-start**: remove `items-start` → `items-stretch`, the left
   `motion.div` gets `self-start` (its cards stay h-fit), the right `motion.div`
   gets `flex flex-col`, SalaryCard — `h-full flex flex-col`. The right column takes
   100% of the grid row height. The left stack — natural height. Clean, no hacks.
3. **C — hybrid**: keep `items-start`, the right `motion.div` + `h-full self-stretch` +
   SalaryCard `h-full`. With `items-start` the grid row = max(left, right), `h-full` on the wrapper
   will not work predictably without an explicit grid row height.

**Strategy choice: Option B.** The cleanest and most predictable CSS. Confirmed by MDN:
with `align-items: stretch` (the default) every grid item stretches to the height of the grid row.
`self-start` on the left div blocks the stretch only for it. The right div `flex flex-col` +
SalaryCard `flex-1` — the card fills all the available height.

---

## 1. Equal-Height: Grid strategy

### Was (round 3)

```tsx
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
  ...
>
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
    {/* left stack — h-fit cards */}
  </motion.div>

  <motion.div variants={card} className="lg:col-span-2">
    <SalarySnapshotCard ... />
  </motion.div>
```

**Problem:** `items-start` → both child divs get `align-self: start` → their height
equals the content. SalaryCard is shorter than the left stack → emptiness.

### Now (round 4)

```tsx
<motion.div
  className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  {/* items-start is REMOVED — we use the default align-items: stretch */}
  ...
>
  {/* Left stack: self-start — does NOT stretch, cards stay h-fit */}
  <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
    <ProjectInfoCard ... />
    <PersonaCard ... />
  </motion.div>

  {/* Right column: flex flex-col — SalaryCard fills the grid row height */}
  <motion.div variants={card} className="lg:col-span-2 flex flex-col">
    <SalarySnapshotCard ... className="flex-1" />
  </motion.div>
```

**Mechanics:**

- Without `items-start` the grid defaults to `align-items: stretch`.
- The left `motion.div` with `self-start` — align-self overridden → height by content (~551px).
- Grid row = 551px (from the left stack as the taller one).
- The right `motion.div` without `self-start` → gets `align-self: stretch` → height = 551px.
- `flex flex-col` on the right div + `flex-1` on SalaryCard → SalaryCard takes 100% of 551px.
- Inside SalaryCard: `flex flex-col` + the bottom section `mt-auto` → content at the top, total at the bottom.

**Responsive:**

- On mobile (`grid-cols-1`): both columns are col-span-1, stretch makes no sense → the behavior
  is correct (stacked vertically, each card h-fit).
- On tablet (`md:grid-cols-2`): left stack col-1, right col-1 → stretch works
  like on desktop (the left `self-start`, the right takes the row height).

---

## 2. SalarySnapshotCard — full redesign

### Round 3 problem (visible on the "before" screenshot)

1. The big "500 USD" + "/ мес" — the only visual accent, the rest is flat.
2. "Последние выплаты" — a small gray caption, then 3 rows without visual structure.
3. The "Все мои выплаты" link — the only interactive element besides the heading.
4. At col-span-2 (928px effective width at 1440px) the content takes only
   ~200px of height out of the ~415px card. With round 4 the card becomes ~551px — without rework
   the emptiness will grow.

### Redesign principles

- **Fill the height meaningfully, not decoratively.** Content sections with a semantic role.
- **Visually richer without AI-slop.** No gradients, no decorative blobs. Richness =
  right sizes, right dividers, right information hierarchy.
- **Remove the "Все мои выплаты" button.** UT requirement. Removed entirely.
- **Card structure — 3 zones:**
  1. **Header zone** — heading "Моя зарплата" + icon (unchanged).
  2. **Rate zone** — large rate + currency/period context + a thin divider.
  3. **Payments zone** — payouts section with a header + rows + neater status badges.
  4. **Summary zone** — "sticks" to the bottom via `mt-auto`: a summary row or an empty
     state.

### Content structure (new)

```
┌─ Card h-full flex flex-col ────────────────────────────────────────────────────┐
│  CardHeader: «Моя зарплата»                             [DollarSign icon]      │
│  ─────────────────────────────────────────────────────────────────────────── │
│  CardContent flex flex-col flex-1:                                             │
│                                                                                │
│  ┌─ Rate zone ──────────────────────────────────────────────────────────────┐ │
│  │  [500]  USD  ·  / месяц                                                  │ │
│  │  text-4xl bold tabular-nums    text-base muted    text-sm muted          │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  Separator opacity-30                                                          │
│                                                                                │
│  ┌─ Payments zone ──────────────────────────────────────────────────────────┐ │
│  │  ПОСЛЕДНИЕ ВЫПЛАТЫ         text-xs uppercase tracking-wider muted        │ │
│  │  ──────────────────────────────────────────────────────────────────────  │ │
│  │  Май 2026           500 USD        [Ожидание]                            │ │
│  │  Апрель 2026        500 USD        [Выплачено]                           │ │
│  │  Март 2026          500 USD        [Выплачено]                           │ │
│  │  (rows: py-2.5, border-b border-border/20, last:border-0)                │ │
│  │                                                                           │ │
│  │  (with 0 payouts: a gray italic row «Выплат ещё не было»)                │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  flex-1 (spacer — takes the remaining height between payouts and the total)   │
│                                                                                │
│  ┌─ Summary zone (mt-auto) ─────────────────────────────────────────────────┐ │
│  │  Separator opacity-20                                                     │ │
│  │  pt-3                                                                     │ │
│  │  «Ставка за месяц»        «500 USD»                                      │ │
│  │  text-xs muted             text-sm font-semibold tabular-nums            │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Component details

```tsx
function SalarySnapshotCard({ salaryMeta, salaryTxs, isLoading, className }: SalarySnapshotCardProps) {
  const baseClass = 'border-border/40 bg-card flex flex-col'  // flex-col for h-full
  const cardClass = className ? `${baseClass} ${className}` : baseClass

  if (isLoading) { ... }

  const hasRate = salaryMeta?.monthlySalary != null
  const currency = salaryMeta?.salaryCurrency ?? 'USD'
  const amount = hasRate ? Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU') : null

  return (
    <Card className={cardClass} data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3 shrink-0">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>

      <CardContent className="flex flex-col flex-1 pt-0 gap-0">

        {/* Rate zone */}
        {hasRate ? (
          <div className="flex items-baseline gap-2 pb-4" data-testid="salary-rate-zone">
            <span className="text-4xl font-bold tabular-nums leading-none" data-testid="salary-rate-amount">
              {amount}
            </span>
            <span className="text-base text-muted-foreground uppercase tracking-wide">
              {currency}
            </span>
            <span className="text-sm text-muted-foreground ml-auto">/ месяц</span>
          </div>
        ) : (
          <div className="pb-4">
            <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
              Ставка не назначена
            </p>
          </div>
        )}

        <Separator className="opacity-30 mb-4 shrink-0" />

        {/* Payments zone */}
        <div className="space-y-0" data-testid="salary-tx-list">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
            Последние выплаты
          </p>
          {salaryTxs.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic py-2">
              Выплат ещё не было
            </p>
          ) : (
            salaryTxs.map((tx) => {
              const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
              const txVariant = isPaid ? ('paid' as const) : ('pending' as const)
              const label = tx.salaryMonth
                ?? new Date(tx.createdAt).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-2.5 border-b border-border/20 last:border-0"
                  data-testid="salary-tx-row"
                >
                  <span className="text-sm text-muted-foreground capitalize">{label}</span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-sm font-medium">
                      {Number(tx.amount).toLocaleString('ru-RU')} {tx.currency}
                    </span>
                    <Badge variant={txVariant} className="text-xs min-w-[72px] justify-center">
                      {isPaid ? 'Выплачено' : 'Ожидание'}
                    </Badge>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Spacer — pushes summary to bottom */}
        <div className="flex-1" />

        {/* Summary zone — anchored to bottom */}
        {hasRate && (
          <div className="mt-auto pt-3 shrink-0" data-testid="salary-summary">
            <Separator className="opacity-20 mb-3" />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Ставка за месяц</span>
              <span className="text-sm font-semibold tabular-nums">
                {amount} {currency}
              </span>
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  )
}
```

**What is removed:**

- The "Все мои выплаты" link with `data-testid="salary-all-link"` — **removed entirely**.
- The `ExternalLink` import — removed if not used elsewhere in the file.

**What is changed:**

- `text-3xl` → `text-4xl` for the amount (a wider card = a larger accent is justified).
- `space-y-4` in CardContent → `flex flex-col flex-1 gap-0` (a structural container for h-full).
- Payments section heading: `text-xs` → added `uppercase tracking-wider` (SaaS style).
- Payout badge: added `min-w-[72px] justify-center` — width alignment.
- Summary zone: a new section at the bottom of the card — a total row with the rate.
- `<Link to="/crm/finance">` — **removed**.
- CardHeader: added `shrink-0` so that it does not shrink when CardContent has flex-1.

---

## 3. HubCards — final template

### Only the changed lines (diff format for the Coder)

```diff
- className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
+ className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
```

```diff
- <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
+ <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
```

```diff
- <motion.div variants={card} className="lg:col-span-2">
-   <SalarySnapshotCard ... />
- </motion.div>
+ <motion.div variants={card} className="lg:col-span-2 flex flex-col">
+   <SalarySnapshotCard ... className="flex-1" />
+ </motion.div>
```

### Full HubCards (for reference)

```tsx
function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)

  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
      variants={container}
      initial="hidden"
      animate="show"
      data-testid="junior-hub-bento"
    >
      {/* Left stack: self-start → h-fit cards, do not stretch */}
      <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4 self-start">
        <ProjectInfoCard project={project} hrContact={hrContact ?? null} hrLoading={hrLoading} />
        <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
      </motion.div>

      {/* Right wide: flex flex-col → SalaryCard flex-1 = grid row height */}
      <motion.div variants={card} className="lg:col-span-2 flex flex-col">
        <SalarySnapshotCard
          salaryMeta={salaryMeta ?? null}
          salaryTxs={salaryTxs ?? []}
          isLoading={salaryLoading}
          className="flex-1"
        />
      </motion.div>

      {/* Bottom full-width: Пароли проекта */}
      <motion.div variants={card} className="col-span-full">
        <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd twoColumn />
      </motion.div>
    </motion.div>
  )
}
```

---

## 4. Imports: what to remove

In `apps/web/app/routes/crm/project.tsx` after the changes remove:

```tsx
// REMOVE if ExternalLink is not used in other components of the file:
import { BookOpen, DollarSign, ExternalLink, Phone, Send, UserCircle } from 'lucide-react'
//                             ^^^^^^^^^^ — remove from the destructure

// REMOVE the «Все мои выплаты» link:
// <Link to="/crm/finance" ... data-testid="salary-all-link">...</Link>
// If Link was imported only for this — remove import { Link } too.
// Check: Link is used in SalarySnapshotCard. If we remove the only place — remove it.
```

Check the file: `import { createFileRoute, Link, useNavigate }` — `Link` is used ONLY
in `SalarySnapshotCard` for "Все мои выплаты". After removing the link → remove `Link` from the import.

---

## 5. data-testid changes (from round 3)

### Removed

| testid            | Reason                                      |
| ----------------- | ------------------------------------------- |
| `salary-all-link` | The "Все мои выплаты" link removed entirely |

### Added

| testid             | What                                                        |
| ------------------ | ----------------------------------------------------------- |
| `salary-rate-zone` | Wrapper of the rate section (rate + currency + period)      |
| `salary-summary`   | Summary zone at the bottom of the card (monthly rate total) |

### Kept (unchanged)

| testid                 | What                                    |
| ---------------------- | --------------------------------------- |
| `salary-snapshot-card` | SalarySnapshotCard                      |
| `salary-rate-amount`   | The rate number (span inside rate-zone) |
| `salary-no-rate`       | Italic «Ставка не назначена»            |
| `salary-tx-list`       | Wrapper of the payouts list             |
| `salary-tx-row`        | Payout row                              |
| `junior-hub-bento`     | Root motion.div                         |
| `project-info-card`    | ProjectInfoCard                         |
| `persona-card`         | PersonaCard                             |

---

## 6. Skeleton loading — update

The skeleton must reflect equal heights. The right skeleton is `flex flex-col` too:

```tsx
{
  /* Right wide skeleton */
}
;<div className="lg:col-span-2 flex flex-col">
  <Skeleton className="flex-1 min-h-[200px] rounded-lg" />
</div>
```

`min-h-[200px]` — the minimum skeleton height with empty content.

---

## 7. Token map

All tokens come from `apps/web/app/styles/globals.css`. No new tokens are added.

| Purpose           | Token                      | Tailwind class                   |
| ----------------- | -------------------------- | -------------------------------- |
| Bento cards       | `--color-card`             | `bg-card`                        |
| Card border       | `--color-border`           | `border-border/40`               |
| Dividers          | `--color-border` × opacity | `border-border/20`, `opacity-30` |
| Primary text      | `--color-foreground`       | `text-foreground`                |
| Secondary text    | `--color-muted-foreground` | `text-muted-foreground`          |
| Amounts (tabular) | CSS `font-variant-numeric` | `tabular-nums`                   |
| Card radius       | `--radius-lg`              | `rounded-lg`                     |
| Rate amount size  | (no token, utility)        | `text-4xl`                       |

---

## 8. A11y (WCAG 2.2 AA)

### 8.1 Removed elements

- The "Все мои выплаты" link (`<Link>`) is removed — it takes one interactive element out of the
  tab order. This simplifies the focus path, does not break it.

### 8.2 New elements

- The summary zone — non-interactive, semantically a `<div>`. No ARIA changes.
- Badge: `min-w-[72px] justify-center` — visual alignment. The Badge content stays
  readable (`text-xs`). The contrast of "Выплачено" / "Ожидание" — unchanged, the same tokens.

### 8.3 Target size (SC 2.5.8)

There are no interactive elements in SalaryCard after the changes (the link is removed, Badge is not interactive).

### 8.4 Focus order after the changes

1. ProjectSwitcher (if > 1 project)
2. ProjectInfoCard → TG/phone links (HrInline)
3. PersonaCard → the "Открыть легенду" button
4. SalarySnapshotCard — no interactive elements (the link is removed)
5. ProjectCredentialsSection → "+ Добавить" → rows → [👁] buttons

### 8.5 Reflow (SC 1.4.10)

`grid-cols-3` → at 400% zoom → `grid-cols-1`, both columns stack vertically.
`self-start` on the left div — does not affect the mobile layout (col-span-1 has no stretch).

---

## 9. Anti-pattern checklist (Mode C)

- No gradients.
- No `rounded-2xl` everywhere — only `rounded-lg` Card.
- No `shadow-xl`.
- No decorative blobs or icons for decoration.
- The summary zone — functional (repeats the rate as an anchor at the bottom), not decorative.
- `text-4xl` for the amount — the only size accent, justified on a 2/3-width card.
- `uppercase tracking-wider` on "ПОСЛЕДНИЕ ВЫПЛАТЫ" — a SaaS pattern (not AI-slop,
  used in shadcn/ui TableHead by default).
- No `transition: all`.

---

## 10. Edge cases

| Case                    | Behavior                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No rate, no payouts     | Rate zone: «Ставка не назначена» italic. Payments zone: «Выплат ещё не было» italic. Summary zone: hidden (only with `hasRate`). The card is h-full of the grid row — empty, but with no hole (grid row = left stack). |
| No rate, has payouts    | Rate zone: «Ставка не назначена». Payments zone: payout rows. Summary zone: hidden.                                                                                                                                    |
| Has rate, no payouts    | Rate zone: «500 USD / месяц». Payments zone: «Выплат ещё не было». Summary zone: «Ставка за месяц 500 USD». The card is filled via the flex-1 spacer.                                                                  |
| 1 payout row            | One row in the payments zone. The spacer compensates. Summary at the bottom.                                                                                                                                           |
| 3 payout rows (nominal) | 3 rows. The spacer shrinks. Summary at the bottom.                                                                                                                                                                     |
| Data loading            | Skeleton: `flex-1 min-h-[200px]` — the skeleton takes the grid row height.                                                                                                                                             |
| Mobile < 768px          | `grid-cols-1` → `self-start` on the left div is inactive (one column). SalaryCard — h-fit (flex-1 on col-span-1 is ineffective without a stretch neighbor). Normal behavior.                                           |

---

## 11. Handoff checklist for the Coder

### apps/web/app/routes/crm/project.tsx

- [ ] `HubCards`: remove `items-start` from the grid className → `"grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"`
- [ ] Left `motion.div`: add `self-start` → `"lg:col-span-1 flex flex-col gap-4 self-start"`
- [ ] Right `motion.div`: add `flex flex-col` → `"lg:col-span-2 flex flex-col"`
- [ ] Pass `className="flex-1"` into `SalarySnapshotCard`
- [ ] `SalarySnapshotCard`: add `flex flex-col` to `baseClass` → `'border-border/40 bg-card flex flex-col'`
- [ ] `SalarySnapshotCard` CardHeader: add `shrink-0`
- [ ] `SalarySnapshotCard` CardContent: `className="space-y-4"` → `className="flex flex-col flex-1 pt-0 gap-0"`
- [ ] Rate zone: `text-3xl` → `text-4xl`; add `pb-4` to the wrapper; `ml-auto` on "/ мес"
- [ ] `<Separator>` after the rate zone: add `mb-4 shrink-0`
- [ ] Payments zone header: add `uppercase tracking-wider`
- [ ] Badge in payout rows: add `min-w-[72px] justify-center`
- [ ] Add a `<div className="flex-1" />` spacer after the payments zone
- [ ] Add the summary zone (`mt-auto pt-3 shrink-0`) with `<Separator>` + the rate row
- [ ] **REMOVE** `<Link to="/crm/finance" ... data-testid="salary-all-link">...</Link>`
- [ ] Remove `Link` from the import `createFileRoute, Link, useNavigate` → leave `createFileRoute, useNavigate`
- [ ] Remove `ExternalLink` from the lucide-react import
- [ ] Update the right column skeleton: `<div className="lg:col-span-2 flex flex-col"><Skeleton className="flex-1 min-h-[200px] rounded-lg" /></div>`

### E2E (AutoTest zone)

- [ ] Remove the test on `salary-all-link` (the element is removed)
- [ ] Add a check that `salary-snapshot-card` contains no link to `/crm/finance`
- [ ] Add a smoke: `salary-summary` visible when `salaryMeta.monthlySalary` is not null

---

## 12. Open questions for the PM

1. **Summary zone with no rate**: the card will be empty at the bottom (the spacer fills). Is this
   acceptable? An alternative — show the summary zone with "—" when there is no rate.

2. **Number of payout rows**: currently the API returns the 3 latest. With 0 rows — only
   "Выплат ещё не было". With a lot of content (3 rows) — the spacer shrinks, the summary
   is pressed to the bottom. If the owner wants to see more rows — raise the limit in
   `useSalaryTransactions()` to 5, the spec does not change because of that.

3. **"Все мои выплаты" removed forever?** Removed entirely (UT requirement). If a way into the payout
   history is needed — it is through the "Финансы" navigation (already in the sidebar).
   Clarify with the owner that the link is gone entirely, not moved elsewhere.
