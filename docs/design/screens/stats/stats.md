# Stats — partner balance and monthly finance (Task 4.1, Wave 4)

> Per-screen artifact (CRM redesign v2). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Direction: `docs/design/foundation.md` · Primitives: `docs/design/screens/_foundation/primitives-v2.md` ·
> Shell: `docs/design/screens/_foundation/shell-v2.md` · Rubric: `docs/design/rubric-calibration.md`.
> Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` · Plan:
> `docs/superpowers/plans/2026-11-11-crm-redesign-v2.md` (Task 4.1).

| Field              | Value                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Screen             | Stats — partner balance, monthly finance chart, company account, KPIs, income compliance    |
| Route / trigger    | `/stats` — `apps/web/app/routes/_authenticated/stats.tsx` (`StatsPage`)                     |
| Roles              | ADMIN, ACCOUNTANT (route access `'/stats'`); every other role is redirected to `/`          |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design has no headless path; HTML prototypes below)  |
| Status             | `captured` (mockups drawn; awaiting the owner's rubric review)                              |
| Last synced commit | `11554c08` (origin/main at capture)                                                         |

**Owner brief (verbatim intent).** The owner opens this screen mostly on a phone, for two things: the
balance between the two partners, and the net-profit-by-month chart. Those two are reachable first on
mobile. No new KPI, no removed one: the redesign changes the presentation of exactly today's data, for
every role that can open the screen.

---

## 1. Current (inventory of what ships today)

### 1.1 Blocks, top to bottom

| #   | Block (component)                                       | Data                                                                                         | Notes                                                                                                                         |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Page header «Статистика»                                | —                                                                                            | testid `stats-page-admin` / `stats-page-accountant`                                                                          |
| 2   | Section «Фінанси» — primary KPI row (4 × `StatCard`)    | `['finance-summary']`                                                                        | «Загальний дохід» (+ trend «vs попер. місяць»), «Витрати», «Зарплати», «Чистий баланс». Each card has a hover help tooltip |
| 3   | Secondary KPI row (4 × `StatCard`)                      | `['finance-summary']` → `computeExtraStats`                                                  | «Дохід за останній місяць» (+ month), «Прибуток за останній місяць» (+ «Маржа: X%»), «Середній дохід / міс.» (+ «за N місяців»), «Найкращий місяць» (+ month) |
| 4   | `FinanceChart` (lazy, `lg:col-span-2`)                  | `summary.monthly`                                                                            | «Динаміка за місяцями». Select: Дохід (default) / Прибуток / Витрати / Зарплати. All months as 80 px bars in a horizontal scroll, starts scrolled to the end; wheel / drag / arrow keys scroll. Tooltip: month + value. Zero reference line when a value is negative |
| 5   | `CompanyAndPartnersCard` — «Рахунок компанії · USDT»   | `['company-account']`                                                                        | Balance in USDT, short wallet address, or «Гаманець не налаштовано»; help tooltip. testid `stats-company-account-balance`    |
| 6   | `CompanyAndPartnersCard` — «Баланси партнерів»          | `summary.adminBalances`                                                                      | Hidden when the list is empty. Sorted by balance, descending. «Разом: …». Share % per partner (negative balance → «—»). A bar per partner. Settlement block (below). testid `stats-partner-balances` |
| 7   | `IncomeComplianceSection` — «Контроль доходів»          | `['income-compliance']` (`staleTime: 60_000`)                                                | KPI strip (4): «Усього доходів», «Закриті повністю», «Відстають», «На валідації у бухгалтера». Receiver rows, each expandable to «Проєкти без зарахованого доходу». Footnote about which income counts |
| 8   | «Інші розділи» (ADMIN only)                             | —                                                                                            | 3 dashed placeholders: «HR — воронка співбесід», «Команда — активність», «Проєкти — завантаженість». testid `stats-placeholders-section` |

### 1.2 Settlement rules (today's behaviour — the redesign keeps them exactly)

- Partners are `summary.adminBalances` (every user with role ADMIN, archived ones included — a
  deliberate server decision in `SummaryService`). The settlement uses only the **richest and the
  poorest** entry of the sorted list.
- Settlement exists when the list has ≥ 2 entries with distinct users. `debt = |rich − poor| / 2`.
- `debt <= 0.01` **or** no settlement (0–1 partner) → «Баланси вирівняно» / «Ніхто нікому не винен».
- Otherwise «Для вирівнювання»: the rich partner «надсилає» `debt`, the poor partner «отримує» `debt`,
  shown in USDT (balances are USD-base; USDT is pegged 1:1 server-side).

### 1.3 Actions

| Action                                   | Where                      | Result                                         |
| ---------------------------------------- | -------------------------- | ---------------------------------------------- |
| Switch chart series                      | `FinanceChart` Select      | Re-renders bars for the chosen series          |
| Scroll months                            | `FinanceChart`             | Wheel / drag / arrow keys                      |
| Open a help tooltip                      | every `StatCard`, company  | Hover / focus tooltip (no tap path on touch)   |
| Expand a receiver row                    | `IncomeComplianceSection`  | Shows the projects with no credited income     |
| Retry compliance                         | compliance error state     | Refetches `['income-compliance']`              |

There is no write action on the screen; it is read-only.

### 1.4 Per-role variants (today)

| Role       | Sees                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| ADMIN      | Blocks 1–8                                                                                   |
| ACCOUNTANT | Blocks 1–7 (no placeholders). `adminBalances` is returned to ACCOUNTANT by the server too    |
| others     | Redirect to `/` (route access + `StatsPage` guard); the API also rejects `GET /finance/summary`, `GET /company-account`, the compliance endpoint |

### 1.5 Modals / sheets

None. Help text lives in hover tooltips only.

### 1.6 Dual-mount pairs

Grep `hidden (sm|md|lg):…|(sm|md|lg):hidden` over the route and its components: **0 pairs**. The only
hit is the decorative progress bar in `ComplianceReceiverRow` (`hidden sm:block`), which is not the
same data rendered twice.

### 1.7 Known presentation defects (input to the redesign)

- Money uses `$` and en-US grouping in `StatCard`, `FinanceChart` and the partner card; v2 requires
  `formatMoney` (`<amount> <CODE>`, uk grouping, U+2212 minus).
- The partner balance — the thing the owner opens the screen for — is the 6th block on mobile, below
  8 KPI cards and the chart.
- The chart defaults to «Дохід», not to the owner's question (net profit by month).
- Help tooltips are hover-only: unreachable on touch.
- Chart colours are hex values, not `--chart-*` tokens; negative bars rely on colour only.

---

## 2. Design (v2)

_Sections below are filled in the following commits._

### 2.1 Layout per device class

### 2.2 States

### 2.3 Per-role variants

### 2.4 Interaction and motion

### 2.5 A11y

### 2.6 Strings (`uk` / `en`)

### 2.7 Data each layout reads

## 3. Mockups

## 4. Self-score (rubric)

## 5. Open points

## 6. For the coder
