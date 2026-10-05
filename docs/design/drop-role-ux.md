# Design Spec: DROP role — «Мой роутинг», financial cabinet, 4-item navigation

> Mode A — Design Direction (pre-feature)
> Spec slug: `drop-role-ux`
> Source plan: `docs/architecture/2026-06-10-drop-role-design.md`
> Structure precedent: `docs/design/junior-hub.md`
> Author: ui-ux-designer · 2026-06-12

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

The interface solves three tasks for DROP:

1. **The «Мой роутинг» hub** — a single center for managing the payment flow: current balance/share, the list of incomes requiring action («Платить компании»), active drop projects, quick actions. Replaces the current redirect to `/crm/profile`.
2. **The financial cabinet** — the full feed of incomes (`pending → validated → paid`), the balance/share breakdown, the company debt, the statuses of outgoing payments, actions (register an income, initiate a crypto payment).
3. **Team and Profile** — one's own single drop-team (senior/HR/accountant, real contacts) + a profile with an emphasis on requisites (wallets).

### 1.2 Audience

**Who:** a DROP participant of the payment routing scheme.
**Usage pattern:** 2–5 sessions a week, each 3–10 minutes. Scenarios:

- The client transferred money → the Drop opens the hub, sees «Требует действия» → presses «Зарегистрировать приход».
- The accountant confirmed an income → the Drop gets a signal → sees the CTA «Платить компании» in «Требует действия» → initiates the payment.
- Balance control: once a week — open the hub, check the accumulated amount/debt.
- Coordination: needs the contact of the senior or HR → «Команда».

The Drop **does not manage the team** and does not see others' finances — only their own. The interface must make the payment cycle (`income → validation → payment to the company`) as readable as possible at a glance.

### 1.3 Tone

`dense / quiet / operational`

- **Dense:** the balance card + the «Требует действия» block + the project list — all without scrolling at 1024px+.
- **Quiet:** `border-border/40 bg-card` cards. Not a single decorative gradient. Accents — only via `--primary` (yellow) on CTAs and status indicators.
- **Operational:** Financial amounts — `tabular-nums`. Statuses — a Badge with semantics (pending/validated/paid), not only color.

**Forbidden:** a purple/gradient hero, glass morphism, oversized hero copy, cards inside cards, decorative blobs.

### 1.4 Memorable detail

**The balance card** is the only element with character. A large amount of the accumulated share in `text-3xl font-bold tabular-nums text-foreground`, under it 3 compact metrics in a row (`rate % · in progress N · company debt`). The visual signal: «this is my money, I control it».

The «Требует действия» block uses `--primary` (brand yellow) only for the badge counter and the CTA button — everything else is neutral. This creates a hierarchy: yellow = action required now.

### 1.5 Constraints

- Tailwind v4 CSS-first (`@theme inline` tokens from `globals.css`), no hardcoded hex
- shadcn/ui components as the base (Card, Badge, Button, Avatar, Skeleton, Separator, Tooltip, ScrollArea, Table)
- Framer Motion for enter animations (the stagger pattern, as in `crm/index.tsx`)
- WCAG 2.2 Level AA — target size 24×24px, focus ring, contrast 4.5:1 text / 3:1 UI
- Responsive: 320 / 768 / 1024 / 1440
- Russian UI — all user-facing texts in Russian
- TanStack Router file-based routes (`apps/web/app/routes/crm/`)
- TanStack Query for data fetching (new hooks: `useDropSummary`, `useDropIncomes`, `useDropProjects`)
- Do NOT show the data of other drops, other teams, juniors, legends

---

## 2. DROP navigation (4 items)

### 2.1 Target NAV_ITEMS composition for the `DROP` role

| #   | Item        | Icon (lucide) | Route          |
| --- | ----------- | ------------- | -------------- |
| 1   | Мой роутинг | `Route`       | `/crm/routing` |
| 2   | Финансы     | `DollarSign`  | `/crm/finance` |
| 3   | Команда     | `UsersRound`  | `/crm/team`    |
| 4   | Профиль     | `UserCircle`  | `/crm/profile` |

**Changes in `nav-sidebar.tsx` relative to the current state:**

1. Add the `Мой роутинг` item (icon `Route` from lucide) — first, only for `DROP`.
2. The `Команда` item — already in `roles: ['DROP']`, leave it.
3. The `Финансы` item — already in `roles: ['DROP']`, leave it.
4. The `Профиль` item — already in `roles: ['DROP']`, leave it.

**Redirect:** on DROP login (or navigation to `/crm`) → `/crm/routing` (the hub).
Change in `routes/crm/index.tsx`: `user?.role === 'DROP'` → `navigate({ to: '/crm/routing' })`.

The current behavior (a redirect to `/crm/profile`) is a temporary crutch from phase 1 (see `index.tsx:78`).

### 2.2 New route

```
apps/web/app/routes/crm/routing.tsx       → /crm/routing
apps/web/app/routes/crm/routing/          → hub components directory
  components/
    DropBalanceCard.tsx
    DropActionRequiredBlock.tsx
    DropProjectsList.tsx
    DropQuickActions.tsx
```

---

## 3. The «Мой роутинг» hub (`/crm/routing`)

### 3.1 Layout ≥ 1024px (desktop)

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Мой роутинг</h1>  text-muted-foreground: «Платёжный хаб»│
├───────────────────┬──────────────────────────────────────────┤
│  DropBalanceCard  │  DropActionRequiredBlock                  │
│  (баланс·доля·    │  (validated приходы → CTA «Платить»)     │
│   ставка·долг)    │                                          │
├───────────────────┴──────────────────────────────────────────┤
│  DropProjectsList  (drop-проекты: компания · синьор · N пр.)  │
├──────────────────────────────────────────────────────────────┤
│  DropQuickActions  (2 кнопки)                                 │
└──────────────────────────────────────────────────────────────┘
```

CSS: `grid-cols-1 md:grid-cols-2 gap-4`.

- Row 1: `DropBalanceCard` (col 1) + `DropActionRequiredBlock` (col 2).
- Row 2: `DropProjectsList` — `col-span-full`.
- Row 3: `DropQuickActions` — `col-span-full`.

### 3.2 Layout < 768px (mobile, 1 column)

Order: DropActionRequiredBlock → DropBalanceCard → DropProjectsList → DropQuickActions.

On mobile `DropActionRequiredBlock` goes **first** — the drop opens the hub to perform an action, the balance is secondary.

### 3.3 DropBalanceCard — detailed structure

**Data:** `GET /api/finance/drop/me/summary` → `{ balance, dropSharePercent, pendingIncomesCount, debtToCompany }`.

The component is a `Card` with the structure:

```
┌─ Card bg-card border-border/40 ─────────────────────────────┐
│  [Wallet icon h-4 w-4 text-muted-foreground] МОЙ БАЛАНС     │
│  ─────────────────────────────────────────────────────────  │
│  <big> $X,XXX.XX </big>  ← text-3xl font-bold tabular-nums  │
│  Накопленная доля                                           │
│  ─────────────────────────────────────────────────────────  │
│  [Percent] X%     [Clock] N в работе     [ArrowDown] $X.XX  │
│   Ставка           Приходов               Долг компании     │
└─────────────────────────────────────────────────────────────┘
```

**Metric details (bottom row):**

- Each metric: `flex flex-col items-center gap-0.5`, the value text `text-sm font-semibold tabular-nums`, the caption `text-xs text-muted-foreground`.
- Separator between metrics: `<Separator orientation="vertical" className="h-8" />`.
- `debtToCompany` > 0 → the value color `text-destructive`. = 0 → `text-muted-foreground`.
- Icons: `Wallet` for the header, `Percent`, `Clock`, `ArrowDownCircle` (lucide) for the metrics.

**Loading:** `<Skeleton className="h-32 w-full rounded-lg" />`.

**Error:** `text-xs text-destructive` + a retry button.

### 3.4 DropActionRequiredBlock — detailed structure

**Data:** from the same `GET /api/finance/drop/me/summary` (the `pendingIncomesCount` field) + `GET /api/finance/drop/me/incomes?status=validated` → the list of validated incomes.

Two states:

**A. There are validated incomes (requiring payment to the company):**

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [AlertCircle icon text-primary] ТРЕБУЕТ ДЕЙСТВИЯ           │
│  Badge variant="default" (primary жёлтый): "N приходов"     │
│  ─────────────────────────────────────────────────────────  │
│  [список validated приходов — max 3 строки]                  │
│  ┌ $1,500  TechCorp · 12 июн  → Button "Платить" sm ghost   │
│  ├ $800    StartupA · 10 июн  → Button "Платить" sm ghost   │
│  └ +N ещё...                   (link к /crm/finance)        │
│  ─────────────────────────────────────────────────────────  │
│  Button variant="default" w-full: "Платить компании"        │
└─────────────────────────────────────────────────────────────┘
```

The «Платить компании» button (w-full primary) → `/crm/payments/initiate` (a common flow, the backend picks validated incomes automatically). The «Платить» button on a row → `/crm/payments/initiate/:incomeId`.

**B. No pending actions:**

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [CheckCircle icon text-green-500] ВСЁ ОПЛАЧЕНО             │
│  ─────────────────────────────────────────────────────────  │
│  Нет приходов, требующих оплаты.      text-muted-foreground  │
└─────────────────────────────────────────────────────────────┘
```

**Loading:** `<Skeleton className="h-28 w-full rounded-lg" />`.

### 3.5 DropProjectsList — detailed structure

**Data:** `GET /api/projects/drop/me` → `DropProjectDto[] { id, companyName, seniorDisplayName, incomesCount, status }`.

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [Briefcase icon] МОИ DROP-ПРОЕКТЫ                          │
│  ─────────────────────────────────────────────────────────  │
│  ┌ [Avatar "ТC"] TechCorp  · Oleksiy Kovalenko  · 12 прих. ┐│
│  ├ [Avatar "SA"] StartupA  · Dmytro Marchenko   · 5 прих.  ││
│  └───────────────────────────────────────────────────────── ┘│
└─────────────────────────────────────────────────────────────┘
```

**Project row:**

- `Avatar` (the company's initials, `bg-secondary text-secondary-foreground`, `h-8 w-8`).
- `companyName` — `text-sm font-medium truncate flex-1`.
- A `·` separator + `seniorDisplayName` — `text-xs text-muted-foreground`.
- A `·` separator + `N прих.` — `text-xs text-muted-foreground tabular-nums`.
- `Badge variant="outline"` for the status: ACTIVE → a green dot + «Активный»; CLOSED → «Закрытый» secondary.

**Empty state:** «Нет активных drop-проектов. Обратитесь к администратору.»

**Loading:** 2× `<Skeleton className="h-10 w-full rounded-md" />`.

### 3.6 DropQuickActions

```
┌─ flex gap-3 ────────────────────────────────────────────────┐
│  [Plus icon] Зарегистрировать приход   Button variant="outline"│
│  [ArrowUpRight icon] Платить компании   Button variant="default"│
└─────────────────────────────────────────────────────────────┘
```

- «Зарегистрировать приход» — opens the existing `CreateTransactionDialog` (the component must support the `DROP_INCOME` type; the Coder checks).
- «Платить компании» — navigation to `/crm/payments/initiate` (or a modal flow, if one exists).
- On mobile: `flex-col w-full` (buttons in a column, full width).

---

## 4. Financial cabinet (`/crm/finance` — drop version)

### 4.1 Strategy

The existing `/crm/finance` is already in the nav for DROP. The task is to make sure it renders a **drop-specific view** when `user.role === 'DROP'`. The Coder must check the current `routes/crm/finance/` (or an equivalent) — it is most likely a SENIOR/ADMIN-oriented UI.

An implementation option: in `finance.tsx` add `if (user.role === 'DROP') return <DropFinancePage />`.

### 4.2 Drop finance layout ≥ 1024px

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Финансы</h1>                                            │
├──────────────────────────────────────────────────────────────┤
│  DropBalanceSummaryCard  (переиспользовать из хаба, col-full) │
├──────────────────────────────────────────────────────────────┤
│  Лента приходов (DropIncomesTable)              [Фильтры ↓]   │
│  фильтры: тип DROP_INCOME · статус · период                   │
├──────────────────────────────────────────────────────────────┤
│  DropPaymentsHistory  (исходящие платежи компании)           │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 DropBalanceSummaryCard (extended version for /crm/finance)

The same balance card from the hub (`DropBalanceCard`) + an additional breakdown:

```
Накоплено: $X,XXX.XX  |  Ставка: X%  |  В работе: N прих.  |  Долг: $X.XX
─────────────────────────────────────────────────────────────
Последний приход: $X,XXX.XX  TechCorp  12 июн  [Валидирован]
```

Reuse the component — just a prop `variant="compact"` (hub) vs `variant="full"` (finance).

### 4.4 DropIncomesTable

**Data:** `GET /api/finance/drop/me/incomes?status=&type=&from=&to=&page=&limit=20`.

**Table columns:**

| Column   | Description                                             |
| -------- | ------------------------------------------------------- |
| Дата     | `text-xs text-muted-foreground tabular-nums`            |
| Компания | The client name from the income                         |
| Сумма    | `font-semibold tabular-nums` + currency                 |
| Тип      | Badge: `DROP_INCOME` → «Приход»                         |
| Статус   | Badge: pending/validated/paid (see §4.5)                |
| Действие | The «Платить» button — only if `status === 'validated'` |

The shadcn/ui `Table` component: `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`.

**Filters:** a `Select` for status + a `Select` for period (current month / previous / 3 months / all). Placement: above the table, `flex gap-2 flex-wrap`.

**Empty state:** «Приходов пока нет».

**Pagination:** if there are > 20 records — «Предыдущая» / «Следующая» buttons under the table.

### 4.5 Status Badges for incomes

| Status      | Badge variant | Icon                  | Text          |
| ----------- | ------------- | --------------------- | ------------- |
| `pending`   | `secondary`   | `Clock h-3 w-3`       | «Ожидает»     |
| `validated` | `default`     | `CheckCircle h-3 w-3` | «Валидирован» |
| `paid`      | `outline`     | `CircleCheck h-3 w-3` | «Оплачен»     |
| `rejected`  | `destructive` | `XCircle h-3 w-3`     | «Отклонён»    |

A Badge with an icon on the left: `<Badge variant="..."><Clock className="mr-1 h-3 w-3" />Ожидает</Badge>`.

Check in `badge.tsx` — if the `destructive` variant does not support text content — add it. Not a hardcoded hex.

### 4.6 DropPaymentsHistory

A simplified feed of outgoing payments (drop → company):

```
┌─ Card border-border/40 ─────────────────────────────────────┐
│  [ArrowUpRight] ПЛАТЕЖИ КОМПАНИИ                            │
│  ─────────────────────────────────────────────────────────  │
│  12 июн  $2,300  txHash: 0xabc...123   [Подтверждён]        │
│  05 июн  $1,100  txHash: 0xdef...456   [Ожидает]            │
└─────────────────────────────────────────────────────────────┘
```

`txHash` — `font-mono text-xs truncate max-w-[120px]`, a Tooltip with the full hash.

---

## 5. Team (`/crm/team` — drop version)

### 5.1 Strategy

The existing `/crm/team` currently shows ALL teams (a bug: `TeamsService.findAll` does not filter for DROP). After the backend fix DROP will get only their own single team.

The front-end changes are minimal: there is no point in building a separate component until the backend is fixed. The spec describes the **target visual result** after the fix.

### 5.2 Target view of the drop team

```
┌──────────────────────────────────────────────────────────────┐
│  <h1>Моя команда</h1>                                        │
│  text-muted-foreground: «Ваша drop-команда для координации»  │
├──────────────────────────────────────────────────────────────┤
│  TeamCard: [название команды]                                 │
│  ─────────────────────────────────────────────────────────  │
│  [Avatar] Oleksiy Kovalenko    Синьор    📧 · 📱 · TG        │
│  [Avatar] Anna Lysenko         HR        📧 · 📱 · TG        │
│  [Avatar] Mykola Savchenko     Бухгалтер 📧 · 📱 · TG        │
└──────────────────────────────────────────────────────────────┘
```

- Contacts: icon links `mailto:`, `tel:`, `https://t.me/` — real ones (the drop coordinates directly).
- Read-only — no edit/add buttons.
- The page caption: `«Ваша drop-команда для координации»` — explicit: the drop understands why this screen exists.

**Empty state** (before the backend fix or if no team is assigned):
«Команда не назначена. Обратитесь к администратору.»

---

## 6. Profile (`/crm/profile` — drop accents)

### 6.1 Changes in the existing Profile

The Profile already works. The spec describes an **emphasis on Requisites** — the «Реквизиты» tab must be active by default when arriving from the hub.

**Redirect from the hub to requisites:** DropQuickActions or DropBalanceCard may contain a link:

```tsx
<Link to="/crm/profile" search={{ tab: 'requisites' }}>
  Мои реквизиты
</Link>
```

The «Реквизиты» tab (`/crm/profile?tab=requisites`) — wallets (USDT ERC-20), bank requisites. Critical for routing — the Coder checks that the USDT requisites are visible and editable under the DROP role.

### 6.2 Tab visibility for DROP

| Tab       | DROP sees? | Note                                                  |
| --------- | ---------- | ----------------------------------------------------- |
| Обзор     | Yes        | Personal data, share                                  |
| Проекты   | No         | A project list in the profile is superfluous for DROP |
| Команда   | No         | There is a separate /crm/team page                    |
| Реквизиты | Yes        | The priority tab                                      |
| Документы | Yes        | Contract/onboarding                                   |
| Финансы   | No         | There is a separate /crm/finance page                 |

If DROP currently has all 6 tabs shown in the Profile — the Coder hides the extra ones via an RBAC prop or a `user.role` check.

---

## 7. Token map

All tokens from `apps/web/app/styles/globals.css` (`@theme inline {}`). **No new tokens are added.**

| Purpose                              | Token                               | Tailwind class                |
| ------------------------------------ | ----------------------------------- | ----------------------------- |
| Page background                      | `--color-background`                | `bg-background`               |
| Cards                                | `--color-card`                      | `bg-card`                     |
| Card border                          | `--color-border`                    | `border-border/40`            |
| Primary text                         | `--color-foreground`                | `text-foreground`             |
| Secondary text                       | `--color-muted-foreground`          | `text-muted-foreground`       |
| CTA, «validated» Badge, Alert icon   | `--color-primary`                   | `text-primary` / `bg-primary` |
| Hover/ghost states                   | `--color-accent`                    | `hover:bg-accent`             |
| Destructive (debt, rejected, errors) | `--color-destructive`               | `text-destructive`            |
| Avatar background (company initials) | `--color-secondary`                 | `bg-secondary`                |
| Avatar text                          | `--color-secondary-foreground`      | `text-secondary-foreground`   |
| Reveal container (secure zone)       | `--color-muted`                     | `bg-muted/40`                 |
| Card radius                          | `--radius-lg` = `var(--radius)`     | `rounded-lg`                  |
| Button radius inside a card          | `--radius-md` = `var(--radius)-2px` | `rounded-md`                  |
| Amounts, hashes, metrics             | CSS `font-variant-numeric`          | `tabular-nums`                |

**Concentric radius:** Card `rounded-lg` → buttons inside `rounded-md`. The card padding `p-4` / `p-5` — the difference is sufficient.

**Status colors:** only through the existing Badge variants. If `badge.tsx` has no `destructive` variant — add it via a CSS var (not hex). Check before implementation.

---

## 8. Motion spec

We use the same Framer Motion stagger pattern as in `routes/crm/index.tsx`:

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

Apply it to the `motion.div` wrappers of the hub cards on first load.

**Motion rules:**

- Enter: opacity + `translateY(12px)`, stagger 60ms.
- Exit: not needed on the hub.
- Skeleton → data: no animation (React conditional render without a transition).
- Buttons: `transition-property: background-color, color, opacity; duration: 150ms`.
- Forbidden: `transition: all`, `will-change: all`, scroll-triggered animations.
- `DropActionRequiredBlock` — when income rows appear/disappear: `<AnimatePresence>` + `motion.li` with `initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}`.

---

## 9. A11y critical paths (WCAG 2.2 AA)

### 9.1 Focus order (`/crm/routing`)

1. `<h1>Мой роутинг</h1>` (no focus, anchor)
2. `DropBalanceCard` (no interactive elements — tabindex not needed)
3. `DropActionRequiredBlock` → income rows → «Платить» buttons (in order) → the «Платить компании» button
4. `DropProjectsList` (rows — no interactive elements, if without drill-down)
5. `DropQuickActions` → «Зарегистрировать приход» → «Платить компании»

The DOM order matches the visual one. On mobile the order changes (DropActionRequiredBlock is first visually) — change the DOM via `order` (CSS order), but make sure that tabindex follows the DOM: apply `order` only on grid items, not through absolute positioning.

### 9.2 Target size (SC 2.5.8, min 24×24px)

| Element                             | Size                | Hit area              |
| ----------------------------------- | ------------------- | --------------------- |
| The «Платить» button (row)          | `h-7` (28px)        | `h-8 min-w-[60px]`    |
| The «Зарегистрировать» button       | `h-9` (36px)        | OK                    |
| The «Платить компании» button (CTA) | `h-9` (36px)        | OK                    |
| Icon buttons in the incomes table   | `h-7 w-7` (28×28px) | OK (> 24px)           |
| Contact icons (Team)                | `h-8 w-8` (32×32px) | `p-1.5` touch padding |

### 9.3 Contrast (SC 1.4.3: 4.5:1 normal; SC 1.4.11: 3:1 UI)

| Element                     | Foreground token                         | Background token     | Ratio  | Status |
| --------------------------- | ---------------------------------------- | -------------------- | ------ | ------ |
| Primary text on a card      | `--foreground` L=0.97                    | `--card` L=0.12      | >10:1  | PASS   |
| Muted text                  | `--muted-foreground` L=0.58              | `--card` L=0.12      | ~5.5:1 | PASS   |
| `text-destructive` (debt)   | `--destructive` L=0.58                   | `--card` L=0.12      | ~4.8:1 | PASS   |
| Badge `validated` (primary) | `--primary-foreground` L=0.08            | `--primary` L=0.84   | >7:1   | PASS   |
| Avatar company initials     | `--secondary-foreground` L=0.2           | `--secondary` L=0.94 | >8:1   | PASS   |
| Green status dot            | `oklch(0.65 0.2 142)` on `--card` L=0.12 | ~4.8:1               | PASS   |

### 9.4 Icon-only buttons (SC 1.1.1)

| Element                              | aria-label requirement                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| «Платить» (income row)               | `aria-label="Оплатить приход от {company}"`                            |
| The «retry» button on a load error   | `aria-label="Повторить загрузку"`                                      |
| Reveal txHash (if there is a toggle) | `aria-label="Показать полный хэш"`                                     |
| Contact icons (email, tel, TG)       | `aria-label="Email {name}"` / `"Телефон {name}"` / `"Telegram {name}"` |

If a button contains visible text — `aria-label` is not needed.

### 9.5 Focus indicators (SC 2.4.11)

We use `outline-ring` from `globals.css` (`--ring`). All `Button variant="ghost"` and `Link` — do not override `outline: none`. The shadcn/ui Button by default has `focus-visible:ring-2 focus-visible:ring-ring`.

### 9.6 Semantics

- Hub: `<main>` → `<h1>Мой роутинг</h1>` (or `sr-only` if the design removes the heading).
- The incomes list: `<ul>` / shadcn `Table` (a semantic table with `<thead>`, `<tbody>`).
- The drop projects list: `<ul>` with `<li>` (not just a div stack).
- DropActionRequiredBlock: `<section aria-label="Требует действия">`.
- DropBalanceCard: `<section aria-label="Мой баланс">`.
- Status metrics in BalanceCard: not only color — Badge + text always (debt = text + color).

### 9.7 Reflow (SC 1.4.10)

CSS grid `grid-cols-1 md:grid-cols-2` → at 400% zoom a correct mobile layout. No horizontal overflow. `tabular-nums` amounts — do not break the layout with large numbers (`max-w-full overflow-hidden text-ellipsis` on the container).

---

## 10. Data contracts (API)

### 10.1 Hub — data

```
GET /api/finance/drop/me/summary
→ DropSummaryDto {
    balance: number           // накопленная доля, USD
    dropSharePercent: number  // процентная ставка дропа (5 по умолчанию)
    pendingIncomesCount: number  // приходов в статусе validated (требуют оплаты)
    debtToCompany: number    // долг компании перед дропом (доля синьора к выплате)
  }

GET /api/finance/drop/me/incomes?status=validated&limit=3
→ DropIncomeDto[] {
    id: string
    companyName: string
    amount: number
    currency: string
    createdAt: string        // ISO date
    status: 'pending' | 'validated' | 'paid' | 'rejected'
  }

GET /api/projects/drop/me
→ DropProjectDto[] {
    id: string
    companyName: string
    seniorDisplayName: string  // displayName синьора (НЕ реальное имя если маска)
    incomesCount: number
    status: 'active' | 'closed'
  }
```

**A note to the Coder:**

- If `GET /api/finance/drop/me/summary` does not exist — create the endpoint. An analogue: `getSummary` for SENIOR. Available only to the drop themselves (RBAC: `DROP` + `userId === req.user.id`).
- If `GET /api/projects/drop/me` does not exist — a filter in `ProjectsService.findAll` for DROP: projects where `drop_id = self`.
- `seniorDisplayName` — the senior's real name (the drop sees it, they coordinate directly per §4 of the plan doc).

### 10.2 Finance — data

```
GET /api/finance/drop/me/incomes?status=&type=&from=&to=&page=1&limit=20
→ PaginatedResult<DropIncomeDto>

GET /api/finance/drop/me/payments
→ DropPaymentDto[] {
    id: string
    amount: number
    currency: string
    txHash?: string          // крипто-хэш если крипто-платёж
    status: 'pending' | 'confirmed' | 'failed'
    createdAt: string
  }
```

### 10.3 Hook structure (new hooks)

```ts
// apps/web/app/hooks/use-drop-summary.ts
export function useDropSummary() // query /api/finance/drop/me/summary

// apps/web/app/hooks/use-drop-incomes.ts
export function useDropIncomes(filters) // query /api/finance/drop/me/incomes
export function useDropProjects() // query /api/projects/drop/me
export function useDropPayments() // query /api/finance/drop/me/payments
```

Models: `use-legend.ts` and the existing finance hooks. All responses via `.parse()` from `@crm/shared` Zod schemas.

---

## 11. Edge cases

### 11.1 The «Мой роутинг» hub

| Case                    | Behavior                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| No drop projects        | DropProjectsList: «Нет активных drop-проектов. Обратитесь к администратору.»                     |
| No validated incomes    | DropActionRequiredBlock: state B (CheckCircle + «Всё оплачено»)                                  |
| `debtToCompany === 0`   | The debt metric: `text-muted-foreground`, the value «$0.00», without destructive                 |
| `debtToCompany > 0`     | The debt metric: `text-destructive`, Tooltip «Долг компании перед вами — доля синьора к выплате» |
| `balance === 0`         | The amount «$0.00», without special styling (neutral)                                            |
| Validated incomes > 3   | In DropActionRequiredBlock show 3 + a link «+N ещё» → `/crm/finance?status=validated`            |
| API error `/me/summary` | A toast + inline retry. The other blocks keep working (independent queries)                      |
| Loading                 | All blocks → a Skeleton of the corresponding height                                              |

### 11.2 Finance

| Case                         | Behavior                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| No incomes                   | DropIncomesTable: «Приходов пока нет»                                                    |
| No company payments          | DropPaymentsHistory: «Нет истории платежей»                                              |
| `txHash` absent              | The txHash column: «—» (dash)                                                            |
| A filter applied, no results | «Нет приходов по выбранным фильтрам. Сбросить фильтры.» with a reset button              |
| Pagination page > 1          | «Предыдущая» / «Следующая» buttons. No pagination with > 3 pages — not needed for a drop |

### 11.3 Team

| Case                                      | Behavior                                             |
| ----------------------------------------- | ---------------------------------------------------- |
| No team assigned (before the backend fix) | «Команда не назначена. Обратитесь к администратору.» |
| No HR in the team                         | The HR row is hidden (do not show an empty row)      |
| No accountant                             | Likewise                                             |
| A contact is empty (no telegram handle)   | The TG icon is hidden (do not render an empty link)  |

---

## 12. data-testid registry (for AutoTest)

Stable selectors — only `data-testid`, not classes:

| testid                       | What                                             |
| ---------------------------- | ------------------------------------------------ |
| `drop-routing-hub`           | Root div of the `/crm/routing` hub               |
| `drop-balance-card`          | `DropBalanceCard`                                |
| `drop-balance-amount`        | The accumulated share amount (tabular-nums)      |
| `drop-balance-share-percent` | The rate % metric                                |
| `drop-balance-pending-count` | The «in progress» metric (number of incomes)     |
| `drop-balance-debt`          | The company debt metric                          |
| `drop-action-block`          | `DropActionRequiredBlock`                        |
| `drop-action-income-item`    | `<li>` row of a validated income                 |
| `drop-action-pay-btn-{id}`   | The «Платить» button on an income row            |
| `drop-action-pay-all-btn`    | The CTA «Платить компании» (general)             |
| `drop-action-more-link`      | The «+N ещё» link to /crm/finance                |
| `drop-projects-list`         | The `DropProjectsList` block                     |
| `drop-project-item-{id}`     | `<li>` row of a drop project                     |
| `drop-quick-register-btn`    | «Зарегистрировать приход»                        |
| `drop-quick-pay-btn`         | «Платить компании» (DropQuickActions)            |
| `drop-finance-page`          | Root div of `/crm/finance` drop-view             |
| `drop-incomes-table`         | `DropIncomesTable`                               |
| `drop-income-row-{id}`       | `<tr>` income row                                |
| `drop-income-status-{id}`    | Income status Badge                              |
| `drop-income-pay-btn-{id}`   | The «Платить» button in the table                |
| `drop-filter-status`         | The status filter Select                         |
| `drop-filter-period`         | The period filter Select                         |
| `drop-payments-history`      | The `DropPaymentsHistory` block                  |
| `drop-payment-row-{id}`      | An outgoing payment row                          |
| `drop-nav`                   | Sidebar nav for DROP (a wrapper for count check) |

---

## 13. Russian texts (user-facing)

### The «Мой роутинг» hub

| Element                      | Text                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| Page heading                 | `«Мой роутинг»`                                              |
| Page subtitle                | `«Платёжный хаб»`                                            |
| BalanceCard heading          | `«МОЙ БАЛАНС»` (uppercase tracking-wider)                    |
| BalanceCard subtitle         | `«Накопленная доля»`                                         |
| Rate metric                  | `«Ставка»`                                                   |
| In-progress metric           | `«В работе»`                                                 |
| Debt metric                  | `«Долг компании»`                                            |
| Debt tooltip                 | `«Доля синьора, которую компания должна выплатить вам»`      |
| ActionBlock heading (active) | `«ТРЕБУЕТ ДЕЙСТВИЯ»`                                         |
| ActionBlock badge            | `«{N} приходов»` / `«{N} приход»` (declension, if needed)    |
| ActionBlock row button       | `«Платить»`                                                  |
| ActionBlock CTA              | `«Платить компании»`                                         |
| ActionBlock extra link       | `«+{N} ещё»`                                                 |
| ActionBlock heading (empty)  | `«ВСЁ ОПЛАЧЕНО»`                                             |
| ActionBlock empty text       | `«Нет приходов, требующих оплаты»`                           |
| ProjectsList heading         | `«МОИ DROP-ПРОЕКТЫ»`                                         |
| ProjectsList empty           | `«Нет активных drop-проектов. Обратитесь к администратору.»` |
| QuickActions button 1        | `«Зарегистрировать приход»`                                  |
| QuickActions button 2        | `«Платить компании»`                                         |

### Finance (drop-view)

| Element                   | Text                                                       |
| ------------------------- | ---------------------------------------------------------- |
| Page heading              | `«Финансы»`                                                |
| IncomesTable heading      | `«МОИ ПРИХОДЫ»`                                            |
| Table columns             | `«Дата»  «Компания»  «Сумма»  «Тип»  «Статус»  «Действие»` |
| Status filter placeholder | `«Все статусы»`                                            |
| Period filter placeholder | `«Все периоды»`                                            |
| Empty table               | `«Приходов пока нет»`                                      |
| Filter without results    | `«Нет приходов по выбранным фильтрам.»`                    |
| Reset button              | `«Сбросить фильтры»`                                       |
| PaymentsHistory heading   | `«ПЛАТЕЖИ КОМПАНИИ»`                                       |
| Empty history             | `«Нет истории платежей»`                                   |
| Income statuses           | `«Ожидает»  «Валидирован»  «Оплачен»  «Отклонён»`          |
| Payment statuses          | `«Ожидает»  «Подтверждён»  «Ошибка»`                       |

### Team (drop-view)

| Element                  | Text                                                   |
| ------------------------ | ------------------------------------------------------ |
| Page heading             | `«Моя команда»`                                        |
| Subtitle                 | `«Ваша drop-команда для координации»`                  |
| Empty state              | `«Команда не назначена. Обратитесь к администратору.»` |
| Senior role              | `«Синьор»`                                             |
| HR role                  | `«HR»`                                                 |
| Accountant role          | `«Бухгалтер»`                                          |
| aria-label email link    | `«Email {name}»`                                       |
| aria-label tel link      | `«Телефон {name}»`                                     |
| aria-label telegram link | `«Telegram {name}»`                                    |

---

## 14. Handoff checklist for Coder

### Pre-implementation

- [ ] Read the plan document `docs/architecture/2026-06-10-drop-role-design.md` (the source of decisions)
- [ ] Check the existing badge.tsx variants — is a `destructive` variant with text needed
- [ ] Find `CreateTransactionDialog` — does it support the `DROP_INCOME` type, or does it need to be extended
- [ ] Check `/crm/payments/initiate/:incomeId` — does the route exist, is it accessible to DROP
- [ ] Confirm the endpoint `/api/finance/drop/me/summary` or create it (Coder task §6 of the plan)
- [ ] Confirm the endpoint `/api/projects/drop/me` or create a filter in `ProjectsService`
- [ ] Check `TeamsService.findAll` — the filter for DROP (Coder task §6 of the plan)
- [ ] `nav-sidebar.tsx` — add the `Route` icon from lucide + the `Мой роутинг` entry for `DROP`
- [ ] `routes/crm/index.tsx` — change the redirect for DROP: `/crm/profile` → `/crm/routing`

### Post-implementation WCAG verify

- [ ] All icon-only buttons have `aria-label` (§9.4)
- [ ] tabular-nums on amounts (CSS `font-variant-numeric: tabular-nums`)
- [ ] `debtToCompany > 0` → `text-destructive` (§3.3)
- [ ] Responsive smoke: 320px / 768px / 1024px / 1440px — no horizontal overflow
- [ ] Playwright screenshot: the hub + finance at 1440px and 375px (in the PR)
- [ ] All `Button variant="ghost"` — the focus ring is visible

### Anti-slop check (Mode C)

- [ ] No purple/gradient backgrounds on cards
- [ ] No `rounded-2xl` everywhere — only `rounded-lg` / `rounded-md`
- [ ] No `shadow-xl` on all cards without a reason
- [ ] No decorative blobs / illustrations
- [ ] No `transition: all`
- [ ] Amounts — `tabular-nums`, not `text-2xl text-center bold` without context

---

## 15. Anti-patterns (check during code review)

- Do not use `transition: all` on buttons — only explicit properties.
- Do not nest Cards inside a Card — DropActionRequiredBlock is not a Card inside a Card (income rows are `<li>`, not nested Cards).
- Do not make the «balance» a large hero element with a gradient background — this is operational SaaS, not a wallet app.
- Do not store financial data in localStorage / IndexedDB — only the TanStack Query memory cache (see the persist query allow-list: finance/PII NEVER).
- Do not show skeleton frames without data inside — only a Skeleton or data, without empty Card shells.
- Do not make «Платить компании» destructive (red) — it is a normal action, not a deletion. Primary yellow.
- Do not hide the debt metric at `debtToCompany === 0` — show «$0.00» (the drop must see that there is no debt).
- Do not add `data-amount` or other attributes with financial data to DOM elements — display only.
- `tabular-nums` is mandatory on all numeric fields (amounts, percentages, counters).
- The real contacts of the senior/HR/accountant in «Команда» — do not mask (the drop coordinates directly). This is the difference from the JUNIOR hub where the persona comes from the legend.
