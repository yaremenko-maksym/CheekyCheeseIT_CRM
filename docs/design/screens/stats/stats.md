# Stats — partner balance and monthly finance (Task 4.1, Wave 4)

> Per-screen artifact (CRM redesign v2). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Direction: `docs/design/foundation.md` · Primitives: `docs/design/screens/_foundation/primitives-v2.md` ·
> Shell: `docs/design/screens/_foundation/shell-v2.md` · Rubric: `docs/design/rubric-calibration.md`.
> Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` · Plan:
> `docs/superpowers/plans/2026-11-11-crm-redesign-v2.md` (Task 4.1).

| Field              | Value                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Screen             | Stats — partner balance, monthly finance chart, company account, KPIs, income compliance   |
| Route / trigger    | `/stats` — `apps/web/app/routes/_authenticated/stats.tsx` (`StatsPage`)                    |
| Roles              | ADMIN, ACCOUNTANT (route access `'/stats'`); every other role is redirected to `/`         |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design has no headless path; HTML prototypes below) |
| Status             | `captured` (mockups drawn; awaiting the owner's rubric review)                             |
| Last synced commit | `11554c08` (origin/main at capture)                                                        |

**Owner brief (verbatim intent).** The owner opens this screen mostly on a phone, for two things: the
balance between the two partners, and the net-profit-by-month chart. Those two are reachable first on
mobile. No new KPI, no removed one: the redesign changes the presentation of exactly today's data, for
every role that can open the screen.

---

## 1. Current (inventory of what ships today)

### 1.1 Blocks, top to bottom

| #   | Block (component)                                    | Data                                          | Notes                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Page header «Статистика»                             | —                                             | testid `stats-page-admin` / `stats-page-accountant`                                                                                                                                                                                                                  |
| 2   | Section «Фінанси» — primary KPI row (4 × `StatCard`) | `['finance-summary']`                         | «Загальний дохід» (+ trend «vs попер. місяць»), «Витрати», «Зарплати», «Чистий баланс». Each card has a hover help tooltip                                                                                                                                           |
| 3   | Secondary KPI row (4 × `StatCard`)                   | `['finance-summary']` → `computeExtraStats`   | «Дохід за останній місяць» (+ month), «Прибуток за останній місяць» (+ «Маржа: X%»), «Середній дохід / міс.» (+ «за N місяців»), «Найкращий місяць» (+ month)                                                                                                        |
| 4   | `FinanceChart` (lazy, `lg:col-span-2`)               | `summary.monthly`                             | «Динаміка за місяцями». Select: Дохід (default) / Прибуток / Витрати / Зарплати. All months as 80 px bars in a horizontal scroll, starts scrolled to the end; wheel / drag / arrow keys scroll. Tooltip: month + value. Zero reference line when a value is negative |
| 5   | `CompanyAndPartnersCard` — «Рахунок компанії · USDT» | `['company-account']`                         | Balance in USDT, short wallet address, or «Гаманець не налаштовано»; help tooltip. testid `stats-company-account-balance`                                                                                                                                            |
| 6   | `CompanyAndPartnersCard` — «Баланси партнерів»       | `summary.adminBalances`                       | Hidden when the list is empty. Sorted by balance, descending. «Разом: …». Share % per partner (negative balance → «—»). A bar per partner. Settlement block (below). testid `stats-partner-balances`                                                                 |
| 7   | `IncomeComplianceSection` — «Контроль доходів»       | `['income-compliance']` (`staleTime: 60_000`) | KPI strip (4): «Усього доходів», «Закриті повністю», «Відстають», «На валідації у бухгалтера». Receiver rows, each expandable to «Проєкти без зарахованого доходу». Footnote about which income counts                                                               |
| 8   | «Інші розділи» (ADMIN only)                          | —                                             | 3 dashed placeholders: «HR — воронка співбесід», «Команда — активність», «Проєкти — завантаженість». testid `stats-placeholders-section`                                                                                                                             |

### 1.2 Settlement rules (today's behaviour — the redesign keeps them exactly)

- Partners are `summary.adminBalances` (every user with role ADMIN, archived ones included — a
  deliberate server decision in `SummaryService`). The settlement uses only the **richest and the
  poorest** entry of the sorted list.
- Settlement exists when the list has ≥ 2 entries with distinct users. `debt = |rich − poor| / 2`.
- `debt <= 0.01` **or** no settlement (0–1 partner) → «Баланси вирівняно» / «Ніхто нікому не винен».
- Otherwise «Для вирівнювання»: the rich partner «надсилає» `debt`, the poor partner «отримує» `debt`,
  shown in USDT (balances are USD-base; USDT is pegged 1:1 server-side).

### 1.3 Actions

| Action                | Where                     | Result                                       |
| --------------------- | ------------------------- | -------------------------------------------- |
| Switch chart series   | `FinanceChart` Select     | Re-renders bars for the chosen series        |
| Scroll months         | `FinanceChart`            | Wheel / drag / arrow keys                    |
| Open a help tooltip   | every `StatCard`, company | Hover / focus tooltip (no tap path on touch) |
| Expand a receiver row | `IncomeComplianceSection` | Shows the projects with no credited income   |
| Retry compliance      | compliance error state    | Refetches `['income-compliance']`            |

There is no write action on the screen; it is read-only.

### 1.4 Per-role variants (today)

| Role       | Sees                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADMIN      | Blocks 1–8                                                                                                                                       |
| ACCOUNTANT | Blocks 1–7 (no placeholders). `adminBalances` is returned to ACCOUNTANT by the server too                                                        |
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
- **Company account card** (stacked, so nothing truncates at 320–375): icon, then «Рахунок компанії»
  (caption), the balance (`6 215,40 USDT`, title size), `USDT · <short wallet>` (caption); info button
  (44 px) → hint sheet. Error: caption, «Не вдалося завантажити баланс», a 44 px «Повторити» under it.
- **«Показники»**: one grouped list, 8 rows (label + sub-line left, value right, info button → hint sheet).
  Order unchanged from today: the 4 primary, then the 4 secondary.
- **«Контроль доходів»**: the 4 compliance KPIs as a 2 × 2 tile grid, then receiver rows (avatar, name,
  `<ROLE> · N активних проєкти`, status pill, `x / y`, chevron), each expandable; footnote below.
- **«Інші розділи»** (ADMIN): 3 dashed rows with «Скоро».
- **First viewport.** At 375 × 812 the partner card and the whole 6-month chart sit above the tab bar
  (`default-375`). At 320 × 568 the partner card is complete and the chart starts below it: one short
  scroll reaches it (`default-320`). Below 360 px the chart controls take two rows: the period
  segmented sizes to its content (it ends left of the FAB, so «Усе» is never covered at rest) and the
  series pill sits on the row under it.

#### Tablet (640–1023) — `default-768`

- Foundation rail (80 px) + one scrolling pane, 20 px gutters.
- **One column across the whole class**, in the mobile order; the chart gets the full pane width (bars
  stay ≥ 44 px bands at 6 months). KPIs become a 2-column tile grid, compliance as on mobile.
- No two-pane split at 900–1023: the foundation's split is list + detail, and Stats has no detail pane.
  (No 900+ tablet frame: the foundation `tablet()` helper always draws a list + detail split from
  900, so it cannot draw this layout; 768 is the reference for the whole class.)

#### Desktop (≥ 1024) — `default-1024`, `default-1280`, `default-1440`

- Foundation sidebar (248 px), header with breadcrumbs «Гроші › Статистика» and the shell CTA.
- **≥ 1280:** top row = left column 380 px (partner card, company card) + chart card filling the rest.
  The chart card has a visible heading «Динаміка за місяцями», series as a segmented control
  «Прибуток · Дохід · Витрати · Зарплати», period segmented «6 міс · 12 міс · Усе», a plot with y-axis
  ticks and value labels, hover tooltip, and under it the **month table** (Місяць | Дохід | Витрати |
  Зарплати | Прибуток, newest first, caption «Ті самі місяці, що й на графіку») for the selected period.
  The chart header wraps when the card is narrow: at 1280 the title and series control share the first
  row and the period control drops to the second (`default-1280`); the title never wraps.
- **1024–1279:** partner card and the stacked company card (as on mobile) side by side, the chart card
  full width below.
- «Показники»: tiles, each with an info button (tooltip on hover and focus) — 4 columns (primary row,
  secondary row) at ≥ 1280, 2 columns at 1024–1279 (a 4-column tile is too narrow for
  `293 040,00 USD` there). «Контроль доходів»: one card — 4 KPI tiles + receiver rows with the progress bar
  (desktop only, decorative) + footnote. «Інші розділи» (ADMIN).

### 2.2 States

| State                   | Frames                                                                                                            | What shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                 | `default-*`, `full-*`                                                                                             | §2.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| loading                 | `loading-375`, `loading-1440`                                                                                     | Skeletons in the final geometry (partner card, chart, company row, KPI list / tiles). One `aria-busy` region labelled «Завантаження статистики». No spinner                                                                                                                                                                                                                                                                                                                                                                                                       |
| empty (no finance data) | `empty-375`, `empty-1440`                                                                                         | Partner card hidden when `adminBalances` is empty (as today); when the partners exist with zero balances (the frame) it shows «Баланси вирівняно», balances `0,00 USD`, share «—» and no bar (today divides by a zero total). Chart card keeps its controls, plot replaced by «Ще немає даних за місяцями» / «Графік з’явиться після першої оплаченої транзакції.». The 4 primary KPIs show `0,00 USD` with no sub-line; the 4 secondary ones are hidden (as today: they need monthly data). Compliance: «Немає активних проєктів-отримувачів доходу за <month>.» |
| error (finance summary) | `error-375`, `error-1440`                                                                                         | One alert card in place of partner + chart + KPIs: «Не вдалося завантажити фінансову статистику» + «Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.» + «Повторити». Company account and compliance still render                                                                                                                                                                                                                                                                                  |
| partial                 | `partial-375`, `partial-1440`                                                                                     | Summary loaded; company account failed → the row reads «Не вдалося завантажити баланс» + «Повторити»; compliance failed → «Не вдалося завантажити дані контролю доходів.» + «Повторити». Each block retries its own query                                                                                                                                                                                                                                                                                                                                         |
| offline                 | `offline-375`                                                                                                     | Foundation offline banner on top; cached data stays visible (TanStack Query cache), no blanking                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| balanced                | `balanced-375`, `balanced-1440`                                                                                   | `debt <= 0.01` → the answer line reads «Баланси вирівняно» / «Ніхто нікому не винен» (today's copy), no direction line; shares and bars stay                                                                                                                                                                                                                                                                                                                                                                                                                      |
| long content            | `long-375`, `long-320`                                                                                            | A long partner name wraps to two lines; a negative balance shows U+2212 and share «—» (today's rule) with no bar                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| no wallet               | `nowallet-375`                                                                                                    | Caption + «USDT · Гаманець не налаштовано», no balance line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| permission              | `accountant-375`, `accountant-1440`                                                                               | §2.3. Other roles never see the screen (route redirect)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| interaction             | `scrub-12m-375`, `series-sheet-375`, `month-sheet-375`, `hint-sheet-375`, `compliance-expanded-375`, `hover-1440` | §2.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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

### 2.5 A11y (WCAG 2.2 AA)

- **Targets:** every touch control ≥ 44 × 44 px (segmented items, series pill, ‹ ›, info buttons,
  compliance rows, sheet rows). Desktop info buttons are 28 px with a 44 px hit area.
- **Headings:** h1 «Статистика»; h2 per block («Баланс партнерів», «Динаміка за місяцями» — `sr-only` on
  mobile/tablet, «Рахунок компанії», «Показники», «Контроль доходів», «Інші розділи»).
- **Partner card:** the answer is one text node a screen reader reads in order: «Для вирівнювання 2 730,25
  USDT, Віктор Кравець надсилає Олені Шевчук» — the arrow icon carries `aria-label` «надсилає»; share bars
  are `aria-hidden` (the % is text).
- **Chart:** the plot is a `role="group"` labelled «Динаміка за місяцями, <series>, <period>»; the
  readout is an `aria-live="polite"` region (updates on ‹ ›, tap, scrub end — not on every scrub frame).
  Bars are not individually focusable; ‹ › and Left/Right keys move the selection. Negative months use
  the hatch pattern **and** the U+2212 sign, never colour alone. Desktop: the month table is the
  accessible equivalent of the plot (real `<table>`, `<th scope>`).
- **Segmented controls:** `radiogroup` / `radio` with `aria-checked`; series sheet rows are radios.
- **Sheets:** focus trapped, Esc and the close button dismiss, focus returns to the trigger.
- **Hints:** info buttons are `<button aria-label="Пояснення: <KPI>">`; the desktop tooltip opens on
  focus as well as hover and is dismissable with Esc (1.4.13).
- **Contrast:** values on `--card` use `--fg`; sub-lines `--muted-fg` (≥ 4.5:1 on `--card` per
  foundation); the hatch fill uses `--chart-1` at full opacity for the stripes (≥ 3:1 against `--card`).
- **Numbers:** `tabular-nums` on every amount; `formatMoney` with uk grouping and U+2212.
- **Inputs:** none on this screen (no 16 px input rule to apply).
- **Reflow:** no horizontal page scroll at 320 (verified in the render: no frame reported overflow).

### 2.6 Strings (`uk` / `en`)

New or changed strings only; every KPI label, sub-line and hint text keeps today's wording (now in the
catalog, `uk` source).

| Key (suggested)              | uk                                                                                                               | en                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `stats.partners.title`       | Баланс партнерів                                                                                                 | Partner balance                                                                                                   |
| `stats.partners.total`       | Разом {amount}                                                                                                   | Total {amount}                                                                                                    |
| `stats.partners.settle`      | Для вирівнювання                                                                                                 | To even out                                                                                                       |
| `stats.partners.sends`       | надсилає                                                                                                         | sends                                                                                                             |
| `stats.partners.receives`    | отримує                                                                                                          | receives                                                                                                          |
| `stats.partners.balanced`    | Баланси вирівняно                                                                                                | Balances are even                                                                                                 |
| `stats.partners.balancedSub` | Ніхто нікому не винен                                                                                            | Nobody owes anyone                                                                                                |
| `stats.chart.title`          | Динаміка за місяцями                                                                                             | Monthly trend                                                                                                     |
| `stats.chart.period.6`       | 6 міс                                                                                                            | 6 mo                                                                                                              |
| `stats.chart.period.12`      | 12 міс                                                                                                           | 12 mo                                                                                                             |
| `stats.chart.period.all`     | Усе                                                                                                              | All                                                                                                               |
| `stats.chart.series.*`       | Прибуток · Дохід · Витрати · Зарплати                                                                            | Profit · Income · Expenses · Salaries                                                                             |
| `stats.chart.seriesLabel`    | Показник графіка                                                                                                 | Chart series                                                                                                      |
| `stats.chart.unit`           | тис. {currency}                                                                                                  | {currency} thousands                                                                                              |
| `stats.chart.loss`           | збиток                                                                                                           | loss                                                                                                              |
| `stats.chart.prev` / `.next` | Попередній місяць · Наступний місяць                                                                             | Previous month · Next month                                                                                       |
| `stats.chart.empty`          | Ще немає даних за місяцями                                                                                       | No monthly data yet                                                                                               |
| `stats.chart.emptySub`       | Графік з’явиться після першої оплаченої транзакції.                                                              | The chart appears after the first paid transaction.                                                               |
| `stats.table.caption`        | Ті самі місяці, що й на графіку                                                                                  | Same months as the chart                                                                                          |
| `stats.table.month`          | Місяць                                                                                                           | Month                                                                                                             |
| `stats.month.transactions`   | Транзакції за {month}                                                                                            | Transactions for {month}                                                                                          |
| `stats.kpi.title`            | Показники                                                                                                        | Key figures                                                                                                       |
| `stats.hint.label`           | Пояснення: {name}                                                                                                | About: {name}                                                                                                     |
| `stats.error.title`          | Не вдалося завантажити фінансову статистику                                                                      | Couldn’t load finance statistics                                                                                  |
| `stats.error.body`           | Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані. | Partner balance, chart and key figures are unavailable. Company account and income control below load separately. |
| `stats.company.error`        | Не вдалося завантажити баланс                                                                                    | Couldn’t load the balance                                                                                         |
| `stats.loading`              | Завантаження статистики                                                                                          | Loading statistics                                                                                                |
| `common.retry`               | Повторити                                                                                                        | Retry                                                                                                             |
| `stats.placeholders.soon`    | Скоро                                                                                                            | Soon                                                                                                              |

`stats.partners.title` changes today's «Баланси партнерів» to «Баланс партнерів»: the card now answers
one question (the settlement), not a list of balances (see `## Assumptions`).

**Today's strings, `uk` unchanged.** The `en` column is new; plurals keep today's ICU forms (`en` uses
`one` / `other`). copy-reviewer reviews both languages.

| uk (today)                                                                                                                                          | en                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Загальний дохід                                                                                                                                     | Total income                                                                                                                        |
| Витрати                                                                                                                                             | Expenses                                                                                                                            |
| Зарплати                                                                                                                                            | Salaries                                                                                                                            |
| Чистий баланс                                                                                                                                       | Net balance                                                                                                                         |
| Дохід за останній місяць                                                                                                                            | Income last month                                                                                                                   |
| Прибуток за останній місяць                                                                                                                         | Profit last month                                                                                                                   |
| Середній дохід / міс.                                                                                                                               | Average income / mo                                                                                                                 |
| Найкращий місяць                                                                                                                                    | Best month                                                                                                                          |
| vs попер. місяць                                                                                                                                    | vs previous month                                                                                                                   |
| Маржа: {margin}%                                                                                                                                    | Margin: {margin}%                                                                                                                   |
| за {count, plural, one {# місяць} few {# місяці} many {# місяців} other {# місяця}}                                                                 | over {count, plural, one {# month} other {# months}}                                                                                |
| Сума всіх оплачених надходжень та доходу сеньйорів і адмінів за весь час.                                                                           | All paid receipts plus senior and admin income, all time.                                                                           |
| Сума всіх оплачених операційних витрат компанії.                                                                                                    | All paid operating expenses of the company.                                                                                         |
| Сума всіх виплачених зарплат співробітникам компанії за весь час.                                                                                   | All salaries paid to employees, all time.                                                                                           |
| Чистий залишок: дохід мінус витрати та зарплати. Додатне значення = компанія в плюсі.                                                               | What is left: income minus expenses and salaries. Positive means the company is ahead.                                              |
| Виручка за {month}. Включає доходи всіх сеньйорів і адмінів.                                                                                        | Revenue for {month}, including the income of every senior and admin.                                                                |
| Чистий прибуток за {month}: дохід мінус витрати та зарплати того місяця.                                                                            | Net profit for {month}: that month's income minus its expenses and salaries.                                                        |
| Середньомісячна виручка за весь час роботи компанії.                                                                                                | Average monthly revenue since the company started.                                                                                  |
| Місяць із найбільшою виручкою за весь час.                                                                                                          | The month with the highest revenue, all time.                                                                                       |
| Разом                                                                                                                                               | Total                                                                                                                               |
| Рахунок компанії · USDT                                                                                                                             | Company account · USDT                                                                                                              |
| Гаманець не налаштовано                                                                                                                             | Wallet not set up                                                                                                                   |
| Контроль доходів                                                                                                                                    | Income control                                                                                                                      |
| Усього доходів                                                                                                                                      | All income                                                                                                                          |
| Закриті повністю                                                                                                                                    | Fully closed                                                                                                                        |
| Відстають                                                                                                                                           | Lagging                                                                                                                             |
| На валідації у бухгалтера                                                                                                                           | With the accountant for validation                                                                                                  |
| # активний проєкт · # активні проєкти · # активних проєктів · # активного проєкту                                                                   | # active project · # active projects                                                                                                |
| отримувач · отримувачі · отримувачів · отримувача                                                                                                   | receiver · receivers                                                                                                                |
| дохід · доходи · доходів · доходу                                                                                                                   | income entry · income entries                                                                                                       |
| Усі отримано                                                                                                                                        | All received                                                                                                                        |
| # у процесі                                                                                                                                         | # in progress                                                                                                                       |
| # без доходу                                                                                                                                        | # without income                                                                                                                    |
| # на валідації                                                                                                                                      | # in validation                                                                                                                     |
| # нараховано                                                                                                                                        | # accrued                                                                                                                           |
| Нараховано · очікує розрахунку                                                                                                                      | Accrued · awaiting payout                                                                                                           |
| Нараховано                                                                                                                                          | Accrued                                                                                                                             |
| На валідації                                                                                                                                        | In validation                                                                                                                       |
| Немає доходу                                                                                                                                        | No income                                                                                                                           |
| Немає доходів                                                                                                                                       | No income yet                                                                                                                       |
| Проєкти без зарахованого доходу                                                                                                                     | Projects with no credited income                                                                                                    |
| Не вдалося завантажити дані контролю доходів.                                                                                                       | Couldn’t load income control data.                                                                                                  |
| Немає активних проєктів-отримувачів доходу за {month}.                                                                                              | No active income-receiving projects for {month}.                                                                                    |
| Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць. Згодом: ручні винятки (пауза / відпустка) і автоматичні нагадування. | Counts income marked “validated” or “paid” for the current month. Later: manual exceptions (pause / leave) and automatic reminders. |
| Інші розділи                                                                                                                                        | Other sections                                                                                                                      |
| HR — воронка співбесід                                                                                                                              | HR — interview funnel                                                                                                               |
| Команда — активність                                                                                                                                | Team — activity                                                                                                                     |
| Проєкти — завантаженість                                                                                                                            | Projects — workload                                                                                                                 |

Role labels in receiver rows (`Сеньйор`, `Адмін-сеньйор`, `Дроп`) keep today's text and move to the
catalog with the rest.

### 2.7 Data each layout reads

| Dataset           | Query key               | Endpoint (today)       | Read by                                                   |
| ----------------- | ----------------------- | ---------------------- | --------------------------------------------------------- |
| Finance summary   | `['finance-summary']`   | `GET /finance/summary` | Partner card, chart, month sheet, month table, all 8 KPIs |
| Company account   | `['company-account']`   | company-account GET    | Company row / card                                        |
| Income compliance | `['income-compliance']` | income-compliance GET  | «Контроль доходів»                                        |

- Same three keys on every device class; the three queries run in parallel; each block has its own
  loading / error. Period, series and selected month are client state over `summary.monthly`
  (`select` / `useMemo`), never a new request.
- **No new data, no new KPI, nothing removed.** The month table and month sheet re-present
  `summary.monthly` rows already on the client. `avgMonthlyProfit` and `dropBalances` (in the payload,
  not shown today) stay off the screen.
- Money: amounts arrive in the base currency (USD); the settlement stays labelled USDT (today's rule).

## Assumptions

- A1: the desktop month table (≥ 1024) re-presents `summary.monthly` for the selected period as the
  accessible equivalent of the chart. Not a new KPI; the owner may veto it (Open point 7).
- A1: chart defaults to «Прибуток» and «6 міс» (the owner's question); today it defaults to «Дохід», all
  months.
- A1: the partner card stays visible to ACCOUNTANT, as today.
- A1: KPI hints keep today's text; only the delivery changes (sheet on touch, tooltip on desktop).
- A1: the partner card title becomes «Баланс партнерів» (today «Баланси партнерів»); copy-reviewer may
  revert it.

## 3. Mockups

`design-gate: degraded` — Claude Design has no headless path; these are HTML prototypes on the
foundation tokens, rendered by `assets/src/render.mjs` (`node render.mjs [filter]`) into
`assets/stats/`. Fidelity references: `default-320.png` and `default-1440.png` stand in for the
`design.png` pair that `responsive-design` requires (mobile 320, desktop 1440); `default-375.png` is
the everyday mobile reference.

| Frame                                                   | Width(s)  | Shows                                    |
| ------------------------------------------------------- | --------- | ---------------------------------------- |
| `default-320`, `default-375`                            | 320, 375  | Main state, first viewport               |
| `full-320`, `full-375`                                  | 320, 375  | Main state, whole page                   |
| `default-768`                                           | 768       | Main state, tablet (one column)          |
| `default-1024`, `default-1280`, `default-1440`          | 1024–1440 | Main state, desktop                      |
| `loading-375`, `loading-1440`                           | 375, 1440 | Skeletons                                |
| `empty-375`, `empty-1440`                               | 375, 1440 | No finance data, no compliance receivers |
| `error-375`, `error-1440`                               | 375, 1440 | Finance summary failed                   |
| `partial-375`, `partial-1440`                           | 375, 1440 | Company account and compliance failed    |
| `offline-375`                                           | 375       | Offline banner over cached data          |
| `nowallet-375`                                          | 375       | Company wallet not set up                |
| `balanced-375`, `balanced-1440`                         | 375, 1440 | Settlement ≤ 0,01                        |
| `long-375`, `long-320`                                  | 375, 320  | Long name, negative balance              |
| `accountant-375`, `accountant-1440`                     | 375, 1440 | ACCOUNTANT (no «Інші розділи»)           |
| `scrub-12m-375`                                         | 375       | 12 months, drag-scrub on a loss month    |
| `series-sheet-375`, `month-sheet-375`, `hint-sheet-375` | 375       | Sheets                                   |
| `compliance-expanded-375`                               | 375       | Receiver row expanded                    |
| `hover-1440`                                            | 1440      | Chart hover tooltip                      |

`month-sheet-375` draws the «Транзакції за <month>» row as the future state; it stays hidden until
Task 1.2 adds the month filter (Open point 1).

Baseline captures of today's screen and the network baseline: **pending**.

## 4. Self-score (rubric)

Criterion 4 (Forms) does not apply (no inputs) and is dropped; weights renormalise over 90. Data
visualisation is capped at 9.5 while drill-down to transactions waits for a month filter (Task 1.2).

| Criterion (weight)       | Mobile   | Tablet   | Desktop  | Note                                                                                       |
| ------------------------ | -------- | -------- | -------- | ------------------------------------------------------------------------------------------ |
| 1 Time-to-task (15)      | 9.0      | 9.5      | 9.5      | Both owner answers in the first viewport at 375; at 320 the chart needs one scroll         |
| 2 Never blocks (15)      | 9.5      | 9.5      | 9.5      | Three independent queries; each block fails and retries alone; client-side period/series   |
| 3 Navigation (10)        | 9.0      | 9.0      | 9.0      | Shell nav unchanged; no in-screen navigation needed                                        |
| 5 Lists and tables (10)  | 9.0      | 9.0      | 9.5      | KPI list / tiles; desktop month table                                                      |
| 6 Sheets, gestures (8)   | 9.0      | 9.0      | 9.0      | Series / month / hint sheets; scrub with a button alternative                              |
| 7 System states (10)     | 9.5      | 9.5      | 9.5      | Loading, empty, error, partial, offline, balanced, long — all drawn                        |
| 8 Data visualisation (7) | 9.0      | 9.0      | 9.5      | Value labels, hatch for loss, table equivalent on desktop; no drill-down yet               |
| 9 Platform fit (8)       | 9.5      | 9.0      | 9.0      | Large title, tab bar, sheets on mobile; rail / sidebar per foundation                      |
| 10 Accessibility (7)     | 9.0      | 9.0      | 9.0      | 44 px targets, live readout, non-colour loss marker; chart a11y needs a screen-reader pass |
| **Weighted (÷ 90)**      | **9.18** | **9.22** | **9.32** |                                                                                            |

**Weakest criterion:** Data visualisation on mobile and tablet (9.0) — the month cannot open its
transactions until the finance list gains a month filter. On mobile, Time-to-task at 320 ties it.
On desktop the weakest is Accessibility (9.0): the chart and the month table still need a real
screen-reader pass (Navigation and Platform fit tie at 9.0, but neither has an open defect).

## 5. Open points

1. **Month → transactions link.** The month sheet's «Транзакції за <month>» needs a month filter on the
   finance list (its search accepts only `status` today). _Recommendation:_ hide the row until Task 1.2
   adds the filter, then show it.
2. **«Інші розділи» placeholders.** Three «Скоро» rows with no destination take a screen on mobile.
   _Recommendation:_ remove them (owner's call; kept in the mockups because «nothing removed»).
3. **One partner.** With 0–1 entry today's code says «Баланси вирівняно», which is not true.
   _Recommendation:_ with exactly one partner show the balance row only and no settlement line.
4. **Three or more partners.** The settlement covers only the richest and the poorest.
   _Recommendation:_ keep today's rule (two partners in practice); revisit if a third ADMIN appears.
5. **USDT label on a USD figure.** The debt is computed from USD balances but labelled USDT.
   _Recommendation:_ keep USDT (settlement is paid in USDT, pegged 1:1 server-side).
6. **ACCOUNTANT desktop frame shows the ADMIN sidebar** (foundation helper limitation).
   _Recommendation:_ accept; the real sidebar comes from the role nav.
7. **Desktop month table** (A1 assumption). _Recommendation:_ keep — it is the accessible equivalent of
   the chart and costs no new data; the owner may veto.

## Components (mapping to our stack)

| Visual block                               | Our component (shadcn/ui / composite)                                                | New?                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------- |
| Partner balance card (settlement first)    | `ui/card.tsx` + share bars (plain elements)                                          | restyle of `CompanyAndPartnersCard` |
| Monthly chart                              | the existing chart library (recharts) on `--chart-*` (primitives-v2 §6)              | restyle                             |
| Period control (6 міс · 12 міс · Усе)      | `ui/segmented-toggle.tsx`                                                            | restyle (compact size at 320)       |
| Series picker                              | pill button → PickerSheet on touch, `ui/popover.tsx` on desktop                      | uses foundation PickerSheet         |
| Month sheet                                | Bottom sheet (medium detent) + `ListRow`                                             | uses foundation Sheet               |
| KPI hint                                   | Bottom sheet on touch, `ui/tooltip.tsx` on desktop                                   | uses foundation Sheet               |
| Company account card / row                 | `ui/card.tsx`; inline error with `ui/alert.tsx` semantics and a Retry button         | restyle                             |
| KPI list (mobile, tablet) / tiles (≥ 1024) | `ListSection` + `ListRow`; tiles on `ui/card.tsx`                                    | uses foundation List row            |
| Desktop month table                        | `ui/table.tsx`                                                                       | NEW block (A1), existing component  |
| «Контроль доходів»                         | today's `IncomeComplianceSection`, rows as `ListRow`, status pills on `ui/badge.tsx` | restyle                             |
| «Інші розділи» placeholders                | `ListRow` (disabled) + `ui/badge.tsx` «Скоро»                                        | restyle                             |
| Skeletons                                  | `ui/skeleton.tsx`                                                                    | restyle                             |
| Offline banner                             | foundation shell feedback (primitives-v2 §5)                                         | uses foundation                     |

## Token-map

Only tokens from `apps/web/app/styles/globals.css`, as the foundation mirrors them.

| Use                                        | Token                                            |
| ------------------------------------------ | ------------------------------------------------ |
| Card, sheet background                     | `--card`, `--raised` (sheet), `--surface` (page) |
| Sender share bar, profit bars              | `--chart-1`                                      |
| Receiver share bar                         | `--chart-2`                                      |
| Chart gridlines, zero line                 | `--chart-grid`                                   |
| Positive trend, «Усі отримано»             | `--positive`                                     |
| Loss readout, negative balance, error text | `--destructive`                                  |
| Captions, units, sub-lines                 | `--muted-fg`                                     |
| Card / sheet radius; inner rows and bars   | `--r-xl` / `--r-lg`                              |

## 6. For the coder

- Build with our components (Card, segmented control and sheet primitives from `primitives-v2.md`,
  foundation shell). The PNGs are the fidelity reference; do not copy the generator HTML.
- Tokens only: `--card`, `--surface`, `--raised`, `--chart-1` (sender, bars), `--chart-2` (receiver),
  `--chart-grid`, `--positive`, `--destructive` (loss readout), `--muted-fg`, `--r-xl` / `--r-lg`. No hex
  colours in the chart.
- Money through `formatMoney` everywhere (removes `$` and en-US grouping); bar labels in thousands with
  the «тис. USD» caption.
- Keep `StatsPage` role gating and testids (`stats-page-admin`, `stats-page-accountant`,
  `stats-company-account-balance`, `stats-partner-balances`, `stats-placeholders-section`).
- Settlement logic unchanged (richest vs poorest, `|rich − poor| / 2`, `<= 0.01` → balanced).
- One component per block, rendered once; layout switches through CSS / container width, not
  dual-mount.
- design-fidelity-review (mockup ↔ localhost at 320, 375, 768, 1024, 1440) before merge.
