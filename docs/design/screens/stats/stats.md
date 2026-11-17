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

**Direction.** Purpose: answer two owner questions in one glance — "who owes whom, how much" and
"did we make money each month". Audience: the two partners on a phone, the accountant on a desktop.
Tone: dense, quiet, numeric (tabular figures everywhere, one accent colour). Memorable detail: the
settlement amount is the largest number on the screen, with the direction («Віктор → Олена») right
under it — the answer before the evidence.

**Block order (all classes).** 1 Partner balance → 2 Monthly chart → 3 Company account → 4 «Показники»
(the 8 KPIs) → 5 «Контроль доходів» → 6 «Інші розділи» (ADMIN). Today's order put the 8 KPI cards first;
the redesign moves the two owner blocks to the top and keeps every block that exists today.

### 2.1 Layout per device class

#### Mobile (< 640) — `default-375`, `default-320`, `full-375`, `full-320`

- Shell: mobile tab screen (large title «Статистика», search + bell in the top bar, tab bar, FAB from the
  foundation shell). Screen margins 16 px (12 px below 360 px).
- **Partner balance card** (first). Over-line «Баланс партнерів» + «Разом <sum> USD» on the right (below
  360 px «Разом» moves to a footer under the rows). Then the answer: «Для вирівнювання» (caption), the
  debt as the large figure (`<amount> USDT`), and the direction line `<rich> → <poor>`. Then one row per
  partner: avatar initials, name (wraps, never truncates), `<share> % · надсилає|отримує`, balance on
  the right, a 4 px share bar (`--chart-1` for the sender, `--chart-2` for the receiver).
- **Chart card** (second). Controls row: segmented «6 міс · 12 міс · Усе» (44 px) + series pill
  «Прибуток ▾» (44 px, opens the series sheet). The selected-month readout: month caption + value
  (`+3 300,00 USD`, «›» opens the month sheet) + ‹ › 44 px month buttons. The plot is 128 px high; each
  bar carries its value label in thousands; the caption row reads «тис. USD» and, when any bar is
  negative, the hatch legend «збиток». The card heading «Динаміка за місяцями» is visually hidden
  (`sr-only` h2) — the controls carry the meaning.
- **Company account row**: icon, «Рахунок компанії», `USDT · <short wallet>` sub-line, balance, info
  button (44 px) → hint sheet.
- **«Показники»**: one grouped list, 8 rows (label + sub-line left, value right, info button → hint sheet).
  Order unchanged from today: the 4 primary, then the 4 secondary.
- **«Контроль доходів»**: the 4 compliance KPIs as a 2 × 2 tile grid, then receiver rows (avatar, name,
  `<ROLE> · N активних проєкти`, status pill, `x / y`, chevron), each expandable; footnote below.
- **«Інші розділи»** (ADMIN): 3 dashed rows with «Скоро».
- **First viewport.** At 375 × 812 the partner card and the whole 6-month chart sit above the tab bar
  (`default-375`). At 320 × 568 the partner card is complete and the chart starts below it: one short
  scroll reaches it (`default-320`). The FAB overlaps the right end of the chart caption at 320 only;
  nothing interactive sits under it.

#### Tablet (640–1023) — `default-768`

- Foundation rail (80 px) + one scrolling pane, 20 px gutters.
- **640–899:** one column in the mobile order; the chart gets the full pane width (bars stay ≥ 44 px
  bands at 6 months). KPIs become a 2-column tile grid, compliance as on mobile.
- **900–1023:** two panes on top — left: partner card + company row; right: the chart card (narrow
  controls: segmented on its own row, series pill below). Everything below as at 640–899.

#### Desktop (≥ 1024) — `default-1024`, `default-1440`

- Foundation sidebar (248 px), header with breadcrumbs «Гроші › Статистика» and the shell CTA.
- **≥ 1280:** top row = left column 380 px (partner card, company card) + chart card filling the rest.
  The chart card has a visible heading «Динаміка за місяцями», series as a segmented control
  «Прибуток · Дохід · Витрати · Зарплати», period segmented «6 міс · 12 міс · Усе», a plot with y-axis
  ticks and value labels, hover tooltip, and under it the **month table** (Місяць | Дохід | Витрати |
  Зарплати | Прибуток, newest first, caption «Ті самі місяці, що й на графіку») for the selected period.
- **1024–1279:** partner card and company card side by side, the chart card full width below.
- «Показники»: 4 × 2 tiles (primary row, secondary row), each with an info button (tooltip on hover
  and focus). «Контроль доходів»: one card — 4 KPI tiles + receiver rows with the progress bar
  (desktop only, decorative) + footnote. «Інші розділи» (ADMIN).

### 2.2 States

| State                    | Frames                                     | What shows                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                  | `default-*`, `full-*`                      | §2.1                                                                                                                                                                                                                             |
| loading                  | `loading-375`, `loading-1440`              | Skeletons in the final geometry (partner card, chart, company row, KPI list / tiles). One `aria-busy` region labelled «Завантаження статистики». No spinner                                                                    |
| empty (no finance data)  | `empty-375`, `empty-1440`                  | No partner card when `adminBalances` is empty (as today). Chart card keeps its controls, plot replaced by «Ще немає даних за місяцями» / «Графік з’явиться після першої оплаченої транзакції.». The 4 primary KPIs show zeros; the 4 secondary ones are hidden (as today: they need monthly data). Compliance: «Немає активних проєктів-отримувачів доходу за <month>.» |
| error (finance summary)  | `error-375`, `error-1440`                  | One alert card in place of partner + chart + KPIs: «Не вдалося завантажити фінансову статистику» + «Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів — окремі дані.» + «Повторити». Company account and compliance still render |
| partial                  | `partial-375`, `partial-1440`              | Summary loaded; company account failed → the row reads «Не вдалося завантажити баланс» + «Повторити»; compliance failed → «Не вдалося завантажити дані контролю доходів.» + «Повторити». Each block retries its own query      |
| offline                  | `offline-375`                              | Foundation offline banner on top; cached data stays visible (TanStack Query cache), no blanking                                                                                                                                  |
| balanced                 | `balanced-375`, `balanced-1440`            | `debt <= 0.01` → the answer line reads «Баланси вирівняно» / «Ніхто нікому не винен» (today's copy), no direction line; shares and bars stay                                                                                      |
| long content             | `long-375`, `long-320`                     | A long partner name wraps to two lines; a negative balance shows U+2212 and share «—» (today's rule) with no bar                                                                                                                  |
| no wallet                | (row variant, see generator `companyRow`)  | Sub-line «USDT · Гаманець не налаштовано», balance hidden                                                                                                                                                                         |
| permission               | `accountant-375`, `accountant-1440`        | §2.3. Other roles never see the screen (route redirect)                                                                                                                                                                          |
| interaction              | `scrub-12m-375`, `series-sheet-375`, `month-sheet-375`, `hint-sheet-375`, `compliance-expanded-375`, `hover-1440` | §2.4                                                                                                                         |

Baseline captures of today's screen and the network baseline: **pending** (no running stack in this
pass; manual-qa captures them before the coder starts).

### 2.3 Per-role variants

| Role       | Mobile / tablet / desktop                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN      | All six blocks                                                                                                                                    |
| ACCOUNTANT | Blocks 1–5 (no «Інші розділи», as today). The partner card is shown: the server returns `adminBalances` to ACCOUNTANT and today's screen shows it |
| others     | No change: redirect to `/`                                                                                                                        |

The `accountant-1440` frame shows the ADMIN sidebar because the foundation desktop helper hard-codes the
ADMIN nav (a mockup limitation, not a design decision; the real sidebar comes from the role's nav).

### 2.4 Interaction and motion

- **Period** (segmented, all classes): «6 міс» default, «12 міс», «Усе». Client-side slice of
  `summary.monthly`; no refetch. Persist nothing (the default answers the owner's question).
- **Series**: mobile/tablet pill → bottom sheet with 4 radio rows (`series-sheet-375`); desktop
  segmented control. Default «Прибуток» (today: «Дохід»).
- **Selected month**: defaults to the newest month. At 6 months every bar band is ≥ 44 px and a tap on
  a band selects it. At 12 months / «Усе» bands get narrow, so the plot supports **drag-scrub**: a dashed
  value line follows the finger and the readout updates (`scrub-12m-375`). The ‹ › buttons are the
  single-pointer alternative (WCAG 2.5.7) and also the keyboard path (Left / Right on the focused plot).
  With «Усе» and more months than fit, the plot scrolls horizontally and starts at the newest month.
- **Month sheet**: the readout's «›» (and a tap on the selected bar) opens a sheet with the month's
  Дохід / Витрати / Зарплати / Прибуток (`month-sheet-375`). Its row «Транзакції за <month>» needs a
  month filter on the finance list that does not exist yet — hidden until then (Open point 1).
- **Hints**: every info button opens the KPI's existing hint text — a bottom sheet on touch
  (`hint-sheet-375`), a tooltip on hover/focus on desktop (`hover-1440` shows the chart tooltip).
- **Compliance row**: tap toggles «Проєкти без зарахованого доходу» (`compliance-expanded-375`).
- **Motion**: bars grow from the zero line on first data (200 ms, `ease-out`), crossfade on series or
  period change (150 ms); readout number does not count up. Sheets use the foundation sheet motion.
  `prefers-reduced-motion`: no grow, instant swaps.

### 2.5 A11y

### 2.6 Strings (`uk` / `en`)

### 2.7 Data each layout reads

## 3. Mockups

## 4. Self-score (rubric)

## 5. Open points

## 6. For the coder
