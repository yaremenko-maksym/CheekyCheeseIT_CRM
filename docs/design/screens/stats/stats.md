# Stats — partner balance and monthly finance (Task 4.1, Wave 4)

> Per-screen artifact (CRM redesign v2). Coder-ready spec on our shadcn/ui + tokens. Headless agents
> rely ONLY on this file + `assets/` (no browser access). Template: `docs/design/screens/_TEMPLATE.md`.
> Direction: `docs/design/foundation.md` · Primitives: `docs/design/screens/_foundation/primitives-v2.md` ·
> Shell: `docs/design/screens/_foundation/shell-v2.md` · Rubric: `docs/design/rubric-calibration.md`.
> Program: `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` · Plan:
> `docs/superpowers/plans/2026-11-11-crm-redesign-v2.md` (Task 4.1).

| Field              | Value                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Screen             | Stats — partner balances, monthly finance chart, company account, KPIs, income compliance                                                |
| Route / trigger    | `/stats` — `apps/web/app/routes/_authenticated/stats.tsx` (`StatsPage`)                                                                  |
| Roles              | ADMIN, ACCOUNTANT (route access `'/stats'`); every other role is redirected to `/`                                                       |
| Claude Design URL  | none — `design-gate: degraded` (Claude Design has no headless path; HTML prototypes below)                                               |
| Status             | `captured` — fix rounds 1–4 applied (R1-01..R1-25, R2-01..R2-26, R3-01..R3-21, R4-01..R4-12); 59 frames; the council re-score is pending |
| Last synced commit | `11554c08` (origin/main at capture)                                                                                                      |

**Owner brief (verbatim intent).** The owner opens this screen mostly on a phone, for two things: the
balance between the two partners, and the net-profit-by-month chart. Those two are reachable first on
mobile. No new KPI, no removed one (the three «Скоро» placeholders are the one removal, decision M3): the
redesign changes the presentation of today's data for every role that can open the screen.

## Assumptions

Master decisions for fix round 1 (M1–M8), fix round 2 (R2-M1–R2-M14), owner decisions, and every remaining
change against today's screen. Each line is an A1 decision recorded on the task; the PR body carries the
same lines. «M<n>» below and elsewhere in the spec means the round 1 decision; round 2 decisions are always
written «R2-M<n>».

**Round 2 decisions (council round 2, contract `R2-M1`–`R2-M14`).**

- **R2-M1 — series control.** Phone: a pill that opens the series sheet. Tablet and desktop: a segmented
  control. The word "popover" is gone for the series control everywhere; hints keep sheet (phone),
  popover (tablet) and tooltip (desktop, fine pointer).
- **R2-M2 — tablet 900–1023 is drawn.** `default-1000` and `select-1000` are single-pane frames at 1000 px,
  built from this screen's own source (the 899 px shell with the width rewritten; foundation files
  untouched). The rule beside them is in §2.1 Tablet. Open point 15 is closed.
- **R2-M3 — staleness stamp has one source and a date.** The stamp is dated when it is not today, in the
  foundation format «10.11 о 14:32» (`stale-yesterday-375`). The page strip shows the OLDEST `dataUpdatedAt`
  among the blocks that show cached data after a failed refetch or while offline. A block with no cached data
  and a failed query shows its own error card; a block with fresh data adds nothing. The mixed cases are rows
  of §2.2.1. On phone and tablet the strip is sticky under the top bar (`stale-scrolled-375`); the stamp is
  `nowrap`, so «станом на 14:32» never wraps apart. The strip uses the card margin on every class.
- **R2-M4 — cold offline is named.** A query with no data and `fetchStatus === 'paused'` is the cold-offline
  state, not loading (today's `isLoading` is false there). While offline «Повторити» is `aria-disabled` with
  the reason in the strip, and the paused queries resume by themselves when the network returns. While a
  retry runs the button shows a busy state (spinner icon, `aria-busy`, 70 % opacity) and takes no second tap
  (`retry-busy-375`).
- **R2-M5 — skeletons are the final geometry, measured.** Every `loading-*` frame is the default frame's own
  DOM with its text and leaf elements turned into placeholders, so each block's bounds match the default
  frame (measured: 0 px worst delta, limit 8 px, `assets/src/measure.mjs`). The loading definition in §2.2
  names the compliance block. Per-block loading: summary loaded and company account or compliance still
  pending → that block's skeleton only.
- **R2-M6 — FAB while loading.** The FAB is hidden while the screen is in the loading state (`loading-375`,
  `loading-320`).
- **R2-M7 — three independent queries stay the target.** This is a change against today (item 17 below).
- **R2-M8 — month bucket rule.** Written in §2.4 Drill-down: the month is the Kyiv business month of the
  paid transaction's `txDate`. The finance list filter `month=YYYY-MM` uses the same rule (dependency on
  the finance-list spec, PR #1393, whose M1 points back here).
- **R2-M9 — hover is not selection (fine pointer).** Hover changes the readout and gives the hovered bar a
  light highlight; the outline, the bold axis label and the highlighted table row stay on the selected
  month. One marker rule for all bar counts: outline = selected month; dashed line and dot only where a drag
  scrubs; none in strip mode. A label never sits on the dashed line.
- **R2-M10 — month table fit.** The currency moves into the table caption («суми в USD») so the amount
  columns carry numbers only; measured: no clipped cell, none inside the 12 px card edge at 768, 1000,
  1024, 1280, 1440.
- **R2-M11 — roles are drawn truthfully.** `accountant-1440` shows an accountant in the sidebar chip («Марина
  Савчук», «Бухгалтер»); fixed in this screen's `withRole`, not in the foundation. Open point 20 records the
  foundation's hard-coded chip.
- **R2-M12 — `touch-1024` sidebar density.** The shell's own density rule `.touch .srow` is dead because the
  nav rows carry two `class` attributes (the second is ignored). This screen's source merges them for the
  touch frame (44 px rows, 48 px search) and Open points 18 and 19 ask the foundation to fix both. The
  foundation files are not edited in this PR.
- **R2-M13 — measured claims are reproducible.** `assets/src/measure.mjs` produces the §2.5 target sizes,
  the table-fit numbers and the R2-M5 block bounds; its output is quoted in §2.5.
- **R2-M14 — two partners, invented names.** The company has exactly two partners; every name, account and
  amount in the frames is an invented fixture.
- **R2-25 decision — 320 × 568.** The partner card is compacted under 360 px (name and balance share a row
  when they fit, otherwise the balance wraps onto its own line); the chart still starts below the first
  viewport and one short scroll reaches it. Accepted, not fixed further: at 568 px high the card, the
  answer and two partner rows cannot be made smaller without cutting the answer or the rows (`default-320`).
- **R2-22 decision — long name at 1440.** In `long-1440` the partner name takes the full row width and the
  balance sits on its own line (as at 320). The left column still ends about 50 px below the chart card in
  that one state; accepted, because the left column is sticky (§2.1 Desktop) and the gap is a property of
  the longest fixture name, not of the layout.
- **R2-24 decision — offline wording.** The strip and the cold card use the shell's wording «Немає
  з’єднання». The retry label stays «Повторити» (today's per-block retry label) instead of the shell's
  «Спробувати ще». Reason: the offline strip carries no retry button, so the two labels never sit on one
  screen and the existing block label needs no new string. Open point 9 records the banner position
  (under the top bar, a slot shared with the session banner, which has priority).

**Round 3 decisions (council round 3, contract `R3-M15`–`R3-M24`).**

- **R3-M15 — a skeleton carries no data.** Every `loading-*` frame shows placeholders only: no fixture text,
  no status pill text, no selected-row edge or outline, no loss swatch or «збиток» legend, no negative bar;
  placeholder bars are uniform. `measure.mjs` fails when a loading frame contains a data text node.
- **R3-M16 — the status strip is one 44 px row.** The strip (stale, offline, cold) is 44 px high and
  occupies 48 px with its 4 px gap: two short lines (what happened, then the stamp) and, for stale, a retry
  that is a split button filling the strip's full height, so its hit area is 44 × 44. Below 360 px the retry
  is icon-only (its accessible name stays «Повторити») and the strip is still one row; the stamp never clips
  (`stale-yesterday-320`). The cost is stated, not hidden: the first block starts 52 px lower at 375 (top
  194 against 142 px) and at 320 (160 against 108 px), 64 px lower at 1440 (140 against 76 px). Measured in
  §2.5; the sticky strip is the price of keeping the staleness cue on screen.
- **R3-M17 — no wallet does not hide money.** The company balance is shown as `<balance> USDT` with the
  sub-line «Гаманець не налаштовано» (today's behaviour; `nowallet-375`, `accountant-1440`); the ADMIN
  button «Налаштувати гаманець» stays. The sub-line wraps instead of truncating.
- **R3-M18 — income-control statuses keep today's set.** «Нараховано» / «# нараховано», «На валідації» /
  «# на валідації», «Немає доходів», «Нараховано · очікує розрахунку» and the KPI label «На валідації у
  бухгалтера» are in §2.6 (uk and en) and drawn on one receiver per variant in the expanded compliance frame.
- **R3-M19 — tablet «Усе» is drawn.** `all-768` shows 20 months; on a coarse pointer the month table has no
  inner scroller (all rows sit in the page scroll; measured: no scroller, no clipped cell); a fine pointer
  keeps the capped scroller (`all-1280`). The tablet cell of the matrix points at `all-768`, not at a
  fine-pointer frame.
- **R3-M20 — accessible sentences never inflect a name.** The settlement sentence is «Надсилає: {rich}.
  Отримує: {poor}.» (`stats.partners.settlementSr`).
- **R3-M21 — `measure.mjs` is a gate.** The target-size check increments `failed`; it also measures
  `series-sheet-375`, `month-sheet-375` and `error-375`; the loading-vs-default comparison renders two
  different frames; a per-node text-contrast pass runs over the default frame of each class (§2.5).
- **R3-M22 — hover names the hovered month.** The stepper label stays on the selected month; hovering
  another bar changes only the figures, with the hovered month named in a caption above them («Наведено:
  Серпень 2026»; without hover the caption reads «Вибрано: Листопад 2026»). The caption line is always
  reserved on a fine pointer, so hovering shifts nothing. ‹ › always step from the selected month.
- **R3-M23 — accepted as is.** The ~50 px column offset in `long-1440`; the empty area under the card in
  `empty-1440` and `error-1440`; the month table is chronological and not sortable; widths above 1920 are
  covered by the `max-w-[1280px]` rule without a 2560 frame; R2-24 and R2-25 as recorded above.
- **R3-M24 — new open points** 21–24 in §5, each with a recommendation and no change in this PR.

- **M1 — drill-down ships.** The month sheet row «Транзакції за <month> <year>» and the tablet / desktop
  month-table rows link to the finance list filtered to that month. Dependency: the finance list
  (Task 1.2) accepts a month filter as a URL search param.
- **M2 — URL state.** Period, series and selected month live in URL search params
  `?period=6|12|all&series=profit|income|expenses|salaries&month=YYYY-MM`. Defaults (`6`, `profit`, newest
  month) are omitted from the URL. A shared link reproduces the view; Back leaves the screen, not a month.
- **M3 — «Інші розділи» removed.** The three «Скоро» placeholders are gone on every class. Decided, not
  open; the owner may veto at the owner look.
- **M4 — one partner (defensive data state).** If the server returns one balance, the card shows that
  partner's balance row only: no evening-out amount, no direction line, and never «Баланси вирівняно»
  (that text claims two balances are equal). Own string `stats.partners.single` («Поки що один партнер —
  вирівнювати нічого»), own frame `onepartner-375`. The company has exactly two partners (owner decision
  2026-11-17), so this state is defensive only.
- **Fallback for three or more balances (defensive, not designed, no frame).** If the server ever returns
  three or more balances, the card lists every balance row and keeps today's evening-out line (richest vs
  poorest, `|rich − poor| / 2`).
- **M5 — share and bar keep today's behaviour (`partnerShare`).** Whole percent over the sum of absolute
  balances, `59 %`; a negative balance shows «—» and keeps its bar (width = share of absolute magnitude,
  minimum 2 %). A caption under the rows says how the share is computed (`stats.partners.shareNote`).
- **M6 — cached-data contract.** The full error card shows only when there is no data at all. With cached
  data, a failed refetch or an offline state keeps the data on screen and adds one page status strip
  «Не вдалося оновити · станом на HH:MM» with a «Повторити» button (HH:MM is the cache's `dataUpdatedAt`,
  dated when it is not today, R2-M3).
- **M7 — pointer, not width, decides touch behaviour.** Under `(pointer: coarse)` at any width every
  control is ≥ 44 × 44 px, a tap selects a bar, and hints and the series choice open in containers that
  need no hover. Under `(pointer: fine)` hover and focus show the readout and the tooltip.
- **M8 — foundation files are not edited.** Where a fix needs a shell or primitive change (FAB hiding over
  the chart, offline banner position), the screen states its rule and an open point asks the shell to
  support it (Open points 8 and 9).
- A1: the tablet / desktop month table re-presents `summary.monthly` for the selected period as the
  accessible equivalent of the chart. On a fine pointer it is capped at 12 rows on the column layouts and 8
  on the two-column desktop layout, with an inner scroll beyond that (`all-1280`); on a coarse pointer it has
  no inner scroller and every row sits in the page scroll (R3-M19, `all-768`; open point 26 asks about the
  length). Not a new KPI.
- A1: chart defaults to «Прибуток» and «6 міс» (the owner's question); today it defaults to «Дохід» with all
  months.
- A1: the partner card stays visible to ACCOUNTANT, as today.
- A1: KPI hints keep today's text; only the delivery changes (sheet on phone, popover on tablet, tooltip on
  desktop). The partner-card and company-account hints keep today's meaning; their wording changes are items
  24 and 25 of the list below.
- A1: money sign rule, one for the whole screen: «+» only on profit-type figures (the «Прибуток» series, its
  month table column, «Чистий баланс», «Прибуток за останній місяць», the profit readout); income, expenses
  and salaries are unsigned; every negative value uses U+2212.
- A1: KPI values and the compliance tiles are derived from the same fixture as the chart; a coder reads them
  from `summary.monthly` and the compliance payload, never from separate numbers (see §2.7).
- A1: the evening-out amount is the largest figure on the card (kept from today's data), labelled USDT.
- A1: «Налаштувати гаманець» (ADMIN only, company row without a wallet) opens the existing wallet admin route
  (`/admin/wallet`). ACCOUNTANT sees the text «Гаманець не налаштовано» and no button.
- A1: the empty-chart action «Нова транзакція» runs the same action as the shell CTA, and is hidden when the
  shell CTA is hidden for the role.

**Changes against today's screen (complete list).**

1. Block order: partner card and chart come first, the 8 KPIs after them (today: KPIs first).
2. Chart defaults to «Прибуток» and «6 міс»; today «Дохід» and every month in a scroller.
3. The company account moves out of the combined card into its own row / card; the label «Рахунок
   компанії · USDT» stays (title «Рахунок компанії», sub-line «USDT · <address>»).
4. Money uses `formatMoney` (`<amount> <CODE>`, uk grouping, U+2212) instead of `$` / en-US grouping.
5. Share is shown as `59 %` with a space (today `59%`); same rounding, same «—» rule.
6. Hints are reachable on touch (sheet on phone, popover on tablet); today they are hover-only.
7. A caption explains the share base (new text), and the hint says balances are USD while the company row is
   USDT.
8. «Інші розділи» placeholders removed (M3).
9. Drill-down from a month to the finance list (M1) and URL state (M2) are new.
10. Chart bars use `--chart-*` tokens and a non-colour loss marker (hatch + U+2212); today hex values.
11. The month table (tablet, desktop) and the month sheet (phone) are new re-presentations of existing data.
12. Receiver rows use today's role labels and ICU plurals on every class (the first mockup showed raw role
    codes).
13. Stale, offline and cold-offline states are new screen behaviour (M6); today a failed refetch has no
    inline state.
14. The loss marker, the docked readout and the ‹ › month stepper are new chart behaviour; today's tooltip
    shows month and value only.
15. «Налаштувати гаманець» for ADMIN and the empty-chart action are new; today a missing wallet is a plain
    sentence and an empty chart is a blank plot.
16. «Разом» shows two decimals (`31 380,50 USD`); today it uses `maximumFractionDigits: 0` and rounds to
    whole dollars.
17. Three independent queries (R2-M7). Today `['company-account']` is fetched inside
    `CompanyAndPartnersCard`, which `stats.tsx` mounts only when `summary` exists, so the company balance
    cannot show when the summary fails. The target lifts the company account into its own block with its own
    query, so it renders, fails and retries alone (`partial-*`, `error-*`).
18. Cold offline (no data, `fetchStatus === 'paused'`) is its own state, not loading (R2-M4); today
    `isLoading` is false there and the screen shows nothing useful.
19. The stale stamp is dated when not today and comes from the oldest cached block (R2-M3); today there is
    no stamp.
20. The evening-out «balanced» sub-line changes from «Ніхто нікому не винен» to «Різниці між балансами
    немає» (R2-21): the first reads as a debt claim, which `CONTEXT.md` `_Avoid_` forbids. The share caption
    reads «Частка — від суми балансів без урахування знака» instead of «… модулів балансів».
21. The KPI trend label «vs попер. місяць» becomes «{percent} % за місяць» (`stats.kpi.trend`, R3-12): the
    percent carries the sign and the unit, so the line stays short in a 44 px list row; the comparison base
    (the previous month) is unchanged.
22. The compliance footnote loses its second sentence «Згодом: ручні винятки (пауза / відпустка) і
    автоматичні нагадування.» (R3-12): it announces features that do not exist, and a roadmap line does not
    belong in a status footnote. The first sentence stays as `stats.compliance.footnote`.
23. A complete receiver row keeps today's behaviour (R3-12): a check icon and no expansion; only rows with
    missing projects draw the chevron and expand. It is not a button either (R4-01): today it is a
    `<button>` without `aria-expanded`; the redesign draws it as a plain row (§6 testids).
24. The partner hint (`stats.partners.hint`, R4-12). Today: «Накопичений баланс кожного партнера: усі
    оплачені надходження та дохід адмінів мінус перекази між адмінами.» The redesign says «партнерів» in
    both places instead of «адмінів» (the card is about the two partners, `CONTEXT.md`), and adds two
    sentences: «Баланси рахуються в USD, рахунок компанії — в USDT (1 USDT = 1 USD).» and «Для вирівнювання
    один партнер надсилає іншому половину різниці балансів.»
25. The company-account hint (`stats.company.hint`, R4-11). Today it ends «… і зменшується виведенням
    дивідендів.»; the redesign ends «… і зменшується на суму дивідендів.» («reduced by dividends»), because
    «виведення» / "withdrawal" is the payout-request term that `CONTEXT.md` lists under `_Avoid_`, and a
    dividend is a distribution, not a withdrawal.

---

## 1. Current (inventory of what ships today)

### 1.1 Blocks, top to bottom

| #   | Block (component)                                    | Data                                          | Notes                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Page header «Статистика»                             | —                                             | testid `stats-page-admin` / `stats-page-accountant`                                                                                                                                                                                                                  |
| 2   | Section «Фінанси» — primary KPI row (4 × `StatCard`) | `['finance-summary']`                         | «Загальний дохід» (+ trend vs the previous month), «Витрати», «Зарплати», «Чистий баланс». Each card has a hover help tooltip                                                                                                                                        |
| 3   | Secondary KPI row (4 × `StatCard`)                   | `['finance-summary']` → `computeExtraStats`   | «Дохід за останній місяць» (+ month), «Прибуток за останній місяць» (+ «Маржа: X%»), «Середній дохід / міс.» (+ «за N місяців»), «Найкращий місяць» (+ month)                                                                                                        |
| 4   | `FinanceChart` (lazy, `lg:col-span-2`)               | `summary.monthly`                             | «Динаміка за місяцями». Select: Дохід (default) / Прибуток / Витрати / Зарплати. All months as 80 px bars in a horizontal scroll, starts scrolled to the end; wheel / drag / arrow keys scroll. Tooltip: month + value. Zero reference line when a value is negative |
| 5   | `CompanyAndPartnersCard` — «Рахунок компанії · USDT» | `['company-account']`                         | Balance in USDT, short wallet address, or «Гаманець не налаштовано»; help tooltip. testid `stats-company-account-balance`                                                                                                                                            |
| 6   | `CompanyAndPartnersCard` — «Баланси партнерів»       | `summary.adminBalances`                       | Hidden when the list is empty. Sorted by balance, descending. «Разом: …». Share % per partner (negative balance → «—»). A bar per partner. Evening-out block (below). testid `stats-partner-balances`                                                                |
| 7   | `IncomeComplianceSection` — «Контроль доходів»       | `['income-compliance']` (`staleTime: 60_000`) | KPI strip (4): «Усього доходів», «Закриті повністю», «Відстають», «На валідації у бухгалтера». Receiver rows, each expandable to «Проєкти без зарахованого доходу». Footnote about which income counts                                                               |
| 8   | «Інші розділи» (ADMIN only)                          | —                                             | 3 dashed placeholders: «HR — воронка співбесід», «Команда — активність», «Проєкти — завантаженість». testid `stats-placeholders-section`. Removed by M3                                                                                                              |

### 1.2 Evening-out rules (today's behaviour — the redesign keeps them exactly)

- Partners are `summary.adminBalances` (every user with role ADMIN, archived ones included — a
  deliberate server decision in `SummaryService`). The evening-out line uses only the **richest and the
  poorest** entry of the sorted list.
- An evening-out line exists when the list has ≥ 2 entries with distinct users. The amount is
  `|rich − poor| / 2`.
- Amount `<= 0.01` **or** no pair (0–1 partner) → «Баланси вирівняно» / «Ніхто нікому не винен» today (the
  redesign's sub-line is «Різниці між балансами немає», change 20). The
  redesign changes the one-partner case (M4): it no longer claims two balances are equal.
- Otherwise «Для вирівнювання»: the rich partner «надсилає» the amount, the poor partner «отримує» it,
  shown in USDT (balances are USD-base; USDT is pegged 1:1 server-side).
- Share per partner is the whole percent of the sum of absolute balances; a negative balance shows «—»
  and keeps its bar (minimum 2 %). With all balances at zero the shares show «—» and the bars sit at the
  2 % minimum (frame `empty-375`).

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
- The chart's 80 px bars in a scroller hide most months behind horizontal scrolling and expose no table
  or keyboard equivalent beyond arrow-key scrolling.
- A failed refetch of cached data has no inline state (only a full error card when nothing is cached).

---

## 2. Design (v2)

**Direction.** Purpose: answer two owner questions in one glance — "how much one partner sends the other to even out the balances" and
"did we make money each month". Audience: the two partners on a phone, the accountant on a desktop.
Tone: dense, quiet, numeric (tabular figures everywhere, one accent colour). Memorable detail: the
evening-out amount is the largest number on the screen, with the direction («Віктор Кравець → Олена
Шевчук») right under it — the answer before the evidence.

**Block order (all classes).** 1 Partner balances → 2 Monthly chart → 3 Company account → 4 «Показники»
(the 8 KPIs) → 5 «Контроль доходів». Today's order put the 8 KPI cards first; the redesign moves the two
owner blocks to the top and keeps every block that exists today, except the removed «Інші розділи» (M3).
On the two-column desktop layout (≥ 1280) blocks 1, 3 and 4 stack in the left column beside block 2; block
5 is full width below.

**Chart plot rules (all classes, one model).**

- **Fit mode.** Every month gets an equal band across the plot width. Used when every band is ≥ 24 px.
- **Strip mode.** Otherwise (e.g. «Усе» with 20 months at 375 or 320) the plot is a horizontally scrolling
  strip of 28 px bands with the newest month at the right edge; the caption adds «Гортайте, щоб побачити
  раніші місяці». The visible window is snapped to whole bands (no half bar or half label at the left
  edge). The hint sits in the legend line above the plot, so it is inside the first viewport (`all-375`).
- **Value labels** (thousands, one decimal, e.g. `+4,2`) are drawn above or below a bar only when its band
  is ≥ 34 px; otherwise the readout and the table carry the numbers.
- **Marker rule (R2-M9, one rule for every bar count).** The selected month is always the bar with the 2 px
  `--fg` outline, the bold axis label and (on wide classes) the highlighted table row. A dashed scrub line
  and a dot at the top of the plot appear only while a finger drags across a fit-mode plot
  (`scrub-12m-375`); strip mode never draws a dot (a drag there scrolls). On a fine pointer, hover changes
  the readout and gives the hovered bar a light highlight only; it never moves the outline, the label or the
  row (`hover-1440`). A value label never sits on the dashed line: the scrubbed bar's own label is dropped
  while the line is drawn.
- **X labels.** Month abbreviations are thinned to every `k`-th band, `k = ceil(40 / band px)`. The
  selected month is always labelled (bold); when it is not on a tick its two neighbouring labels are
  hidden so nothing overlaps (`scrub-12m-375`, selected August). The year is added to January labels
  (`січ ’26`).
- **Loss marker.** A negative month is drawn below the zero line with a diagonal hatch fill **and** the
  U+2212 sign on its label and in every readout; colour is never the only signal.
- **Y axis.** Axis labels at 0 and at nice ticks, units in the caption «тис. USD»; zero line and gridlines
  use `--chart-grid`. The axis minimum comes from the data: one nice step below the lowest value (a −1,4
  loss gives −2, not −5), so a loss does not leave a third of the plot empty (R2-18).

### 2.1 Layout per device class

#### Phone (< 640) — `default-320`, `default-375`, `full-320`, `full-375`, `all-320`, `all-375`, `scrub-12m-375`

- Shell: mobile tab screen (large title «Статистика», search + bell in the top bar, tab bar, FAB from the
  foundation shell). Screen margins 16 px (12 px below 360 px).
- **Partner card** (first). Over-line «Баланси партнерів» with the info button (44 px) on the right. Then the
  answer: «Для вирівнювання» (caption), the evening-out amount as the large figure (`<amount> USDT`), and
  the direction line `<rich> → <poor>`. Then one row per partner: avatar initials, name (wraps, never
  truncates), `<share> % · надсилає|отримує`, balance on the right, a 4 px share bar (`--chart-1` for the
  sender, `--chart-2` for the receiver). Footer: «Разом <sum> USD» right-aligned, then the share caption
  «Частка — від суми балансів без урахування знака». Under 360 px the card is compact (R3-21): the name (15 px) and the
  balance (14 px) share one row and the share caption with its bar sits on the row below, so a partner is two
  lines, as at 375 (`default-320`); a name too long for the row wraps and the balance goes to its own line
  (`long-320`). A hyphenated name breaks after the hyphen only («Вишневецька-» / «Коваленко», R3-16).
- **Chart card** (second). Controls: segmented «6 міс · 12 міс · Усе» (44 px) and the series pill
  «Прибуток ▾» (44 px, `aria-haspopup="listbox"`, opens the series sheet). Below 360 px the two controls take two rows
  (the period segmented sizes to its content and ends left of the FAB zone). The readout shows the month
  caption, the value (`+3 300,00 USD`) with a «›» that opens the month sheet, and the ‹ › month stepper
  (44 px each). The plot is 120 px high (132 px below 360 px); the caption row reads «тис. USD», the loss
  legend «збиток» when any bar is negative, and the strip hint when applicable. The card heading
  «Динаміка за місяцями» is a visually hidden h2.
- **Company account card** (stacked, so nothing truncates at 320–375): icon, caption «Рахунок компанії», the
  balance (`6 215,40 USDT`), `USDT · <short wallet>`; info button (44 px) opens the hint sheet. No wallet:
  the balance stays and the sub-line reads «Гаманець не налаштовано» (R3-M17), and ADMIN gets a 44 px
  «Налаштувати гаманець» button (`nowallet-375`). Error: «Не вдалося завантажити баланс» + a 44 px «Повторити».
- **«Показники»**: one grouped list, 8 rows (label + sub-line left, value right, info button → hint sheet).
  Order unchanged from today: the 4 primary, then the 4 secondary. «Загальний дохід» carries the trend line
  «−16,3 % за місяць» (derived: the latest month against the previous one).
- **«Контроль доходів»**: the 4 compliance tiles as a 2 × 2 grid, then receiver rows (avatar, name,
  `<role> · <N активні проєкти>`, status pill, `x / y`, then a chevron or a check). Only a receiver with open
  projects is a disclosure button (`aria-expanded`, chevron) that expands its project rows; a complete
  receiver («Усі отримано», `x = y`) shows a `--positive` check icon and is not interactive: no
  `role="button"`, no `aria-expanded`, no expansion (today's `CheckCircle2` row, R4-01). Footnote below.
  The tile «На валідації у бухгалтера» counts the PROJECTS on validation (today's `totals.pendingProjects`),
  not receivers; accrued projects are booked and are not with the accountant, so they are not counted
  (R4-02; `compliance-variants-*`: 4).
- **FAB rule (M8).** The shell FAB must not cover the newest bar, the ‹ › stepper or «Разом». While the chart
  card intersects the FAB zone the FAB fades out (150 ms) and returns when it leaves. The first-viewport
  frames (`default-*`, `all-*`, `scrub-*`, the sheets, `stale-375`, `offline-375`) are drawn with the FAB
  hidden for that reason; the `full-*` and the fit-height frames draw it in the clearance below the last
  block, where it covers nothing. The FAB is also hidden for the whole loading state (R2-M6: `loading-375`,
  `loading-320`), so it never floats over a skeleton bar.
- **First viewport.** At 375 × 812 the partner card and the whole 6-month chart sit above the tab bar
  (`default-375`). At 320 × 568 the partner card is complete and the chart starts below it: one short
  scroll reaches it (`default-320`). This scroll is accepted (R2-25 decision in `## Assumptions`).
- **Status strip (R2-M3, R3-M16).** Sticky at the top of the scroll area, in the content column with the card
  margin (16 px, 12 px below 360 px). One 44 px box: an icon, two lines (what happened in bold, then the muted
  stamp, «станом на 14:32» or «станом на 10.11 о 14:32» when the data is not from today, `white-space:
nowrap`) and, for stale, a retry split button that fills the strip's height (hit area 44 × 44; icon-only
  below 360 px, `stale-yesterday-320`). The strip stays visible while the page scrolls
  (`stale-scrolled-375`, same fixture as `stale-375`, R3-18), so scrolled figures keep their staleness cue.
  **First-viewport cost, measured:** the strip occupies 48 px and the first block starts 52 px lower at 375
  (top 194 against 142 px) and at 320 (160 against 108 px). With a strip at 375 the partner card, the chart
  controls and the readout stay in the first viewport but the plot is cut by the tab bar (only the bar tops
  show, `stale-375`); one short scroll reaches it. Accepted: the strip exists only while a failure or the
  offline state lasts, and the default frame (`default-375`, no strip) keeps the whole plot in view.
- **12 months and «Усе».** At 375, 12 months fit (bands ≈ 24–27 px, no value labels, scrub line on,
  `scrub-12m-375`); «Усе» (20 months) switches to the strip (`all-375`, `all-320`). Below 360 px 12 months
  use the strip too.

#### Tablet (640–1023) — `default-768`, `select-768`, `all-768`, `error-768`, `long-768`, `loading-768`, `stale-768`, `hint-popover-768`, `default-1000`, `select-1000`

- Foundation rail (80 px) + one scrolling pane, 20 px gutters. The reference width is 768; **900–1023 is
  drawn at 1000 px** (`default-1000`, `select-1000`, R2-M2). Stats has no detail pane, so the same single
  pane just gets wider (rail unchanged). The foundation `tablet()` helper draws a list + detail split from
  900, so the 1000 px frames are built from this screen's own source: the foundation 899 px shell with the
  width rewritten (`tabletFrame` in `assets/src/wide.mjs`); no foundation file is edited.
- **The rule for a ~900 px pane (content 820–880 px; measured at 1000 px: 880 px).** Four KPI columns from
  900 px (two below, `default-768`: 648 px content). The compliance progress bar shows from 860 px of
  content width and is dropped below it, so role and project text never truncate (it shows in
  `default-1000`, it is absent in `default-768`). The plot fills the card width in fit mode (12 months at
  1000 px: twelve bands, each wider than the 48 px of `select-768`, with value labels). The month table sits below the plot, full card width (no side-by-side
  split on a tablet), 52 px rows. The partner card keeps the wide arrangement.
- **One column across the whole class**, in the same block order. The partner card uses the wide
  arrangement (evening-out answer on the left, partner rows on the right). The chart card has a visible h2
  «Динаміка за місяцями», period and series segmented controls (44 px), a docked readout (month stepper
  ‹ ›, then Дохід · Витрати · Зарплати · Прибуток), the plot (220 px high, y axis), the caption, and the
  month table (52 px rows, rows are links to the month's transactions, M1). Bands are ≥ 44 px at 6 months
  (95.7 px at 768) and ≈ 48 px at 12 months (`select-768`); «Усе» fits at 28.7 px bands (measured, `all-768`; under a coarse pointer a tap picks the band, and the 44 px ‹ › step by one month; R3-M19:
  the 20-row month table has no inner scroller on a coarse pointer, the rows sit in the page scroll). The series
  control is a segmented control (R2-M1), not a popover: four radios in one row.
- Company account is a full-width row; «Показники» is a 2-column tile grid; «Контроль доходів» is the phone
  composition at 4 tiles across.
- **Error** (`error-768`): the alert card spans the column; the company row and compliance stay.
  **Long content** (`long-768`): a long name wraps inside its row, the negative balance keeps U+2212 and «—».
  **Loading** (`loading-768`): skeletons in the final column geometry.
  **Stale** (`stale-768`, R4-03): the 44 px strip sits under the title row, inside the pane's 20 px gutters
  (728 px wide at 768), sticky while the pane scrolls, with the «Повторити» split button at its right edge;
  the partner card, the chart controls and the readout stay in the first viewport below it. Open point 27
  asks whether a sticky strip should collapse once the 6-month plot is scrolled under it.
- **Other states on tablet** (offline, cold-offline, partial, empty, balanced, one partner, no wallet,
  ACCOUNTANT): the same blocks as the phone and desktop frames of that state, composed in this column. Their
  block-level rendering is identical to the frame named in the §2.2 matrix; the tablet only changes the
  arrangement, not the state treatment. The offline and cold strips span the pane width as in `stale-768`.

#### Desktop (≥ 1024) — `default-1024`, `default-1280`, `default-1440`, `default-1920`, `touch-1024`, `all-1280`, `hover-1440`

- Foundation sidebar (248 px), header with breadcrumbs «Гроші › Статистика» and the shell CTA «Нова
  транзакція». The content column is capped at 1280 px and centred (`default-1920`); the coder uses
  `mx-auto max-w-[1280px]`.
- **≥ 1280, fine pointer — two columns.** Left column 380 px: partner card (compact: answer on top, rows
  below), company row, «Показники» as 2-column tiles. Right: the chart card, plot 330 px high so the two
  columns end together (no empty area under the company card in `default-1280` / `default-1440`). The chart
  card has a visible h2, period and series segmented controls (26 px items), the docked readout, the plot with y
  axis, the caption and the month table (40 px rows; the amount columns carry numbers only and the caption
  names the currency, so the table fits the 588 px card at 1280 without a clipped cell, R2-M10). In the left
  column a long partner name takes the full row width and the balance goes on its own line below it, as at
  320 (`long-1440`); the column may then end below the chart card, and the sticky rule below covers it. The table shows at most 8 rows with inner scroll and a
  bottom fade, plus «Показано N з M» when more months exist (`all-1280`). The left column is `position:
sticky; top: 16px`, so with a long table it follows instead of leaving a gap. «Контроль доходів» is one
  full-width card below: 4 tiles and receiver rows with the decorative progress bar.
- **1024–1279, fine pointer — one column.** Partner wide card, chart (plot 220 px), company row, «Показники»
  as 4-column tiles (values 17 px so `464 300,00 USD` fits), compliance (the progress bar is dropped below 860
  px of content width so role and project text never truncate; names truncate with the full name in the
  tooltip).
- **Coarse pointer at any desktop width (M7) — `touch-1024`.** The one-column layout, never the split;
  controls are 44 px (segmented, ‹ ›, info buttons), table rows 52 px, compliance in the list composition.
  The sidebar rows are 44 px and the search field 48 px (R2-M12; measured, §2.5).
- **Hover (fine pointer) — `hover-1440`.** Hover is not selection (R2-M9). Hovering the plot gives the
  hovered bar a light highlight and the docked readout above the plot shows the hovered month's figures with
  the caption «Наведено: <month>» (R3-M22); the stepper label, the outline, the bold axis label and the table
  row stay on the selected month, and ‹ › step from it. No dashed line, no dot. Nothing floats
  over a neighbouring bar (R1-14). Click selects the month (URL `month=`), and the table scrolls the selected
  row into view (nearest, 150 ms; instant with reduced motion). Leaving the plot returns the readout to the
  selected month.
- «Показники» tiles each have an info button: tooltip on hover and focus (fine pointer), popover on tap
  (coarse pointer, see §2.4).

### 2.2 States

States are listed once; §2.2.1 is the State × class matrix that says which frame (or which rule) covers
each cell.

| State                       | What shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default                     | §2.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| loading                     | The default frame of the class with every text and leaf element turned into a placeholder, so every block keeps the bounds of the default frame (partner card with its «Разом» and caption footer, chart card with its controls, plot and table rows, company row, KPI list or tiles, and the whole «Контроль доходів» block: tiles, receiver rows, footnote). Measured: worst block delta 0 px, limit 8 px (§2.5). Placeholders only (R3-M15): no fixture text, no pill text, no selected edge, no loss swatch or «збиток» legend, no negative bar, uniform bars; `measure.mjs` fails when a loading frame carries a data text node or a chromatic fill. One region `role="status"` labelled «Завантаження статистики». No spinner, no FAB (R2-M6). **Per-block rule (R2-M5):** summary loaded while the company account or the compliance query is still pending shows only that block's skeleton; a block never waits for another. |
| empty (no finance data)     | Partner card hidden when `adminBalances` is empty (as today); with partners at zero balance (the frame) it shows «Баланси вирівняно», balances `0,00 USD`, shares «—» and the 2 % minimum bars. Chart card keeps its controls; the plot is replaced by «Ще немає даних за місяцями», «Графік з’явиться після першої оплаченої транзакції.» and a «Нова транзакція» button. The 4 primary KPIs show `0,00 USD`; the 4 secondary ones are hidden (they need monthly data). Compliance: «Немає активних проєктів-отримувачів доходу за <month>.»                                                                                                                                                                                                                                                                                                                                                                                         |
| error (finance summary)     | One alert card in place of partner + chart + KPIs: «Не вдалося завантажити фінансову статистику» + «Баланси партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.» + «Повторити». Company account and compliance still render. Shown only when there is no cached summary (M6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| partial                     | Summary loaded; company account failed → «Не вдалося завантажити баланс» + «Повторити»; compliance failed → «Не вдалося завантажити дані контролю доходів.» + «Повторити». Each block retries its own query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| stale (refetch failed)      | Cached data stays; one status strip, sticky under the top bar on phone and tablet and above the first block on desktop: «Не вдалося оновити» / «станом на 14:32» («станом на 10.11 о 14:32» when the data is not from today, `stale-yesterday-375`) with a «Повторити» split button at the strip's right edge (44 px high on every class; icon-only below 360 px, `stale-yesterday-320`). The stamp is the OLDEST `dataUpdatedAt` among the blocks that show cached data after a failed refetch (R2-M3). While the retry runs the button is busy and takes no second tap (`retry-busy-375`). The strip clears on a successful refetch                                                                                                                                                                                                                                                                                                 |
| offline, cached data        | Cached data stays. A strip under the top bar (sticky on phone and tablet): «Немає з’єднання» / «показано дані станом на 14:32» (dated when not today; the oldest cached block). There is no «Повторити» in it (the strip replaces the stale line); the paused queries resume by themselves when the network returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| cold offline (no cache)     | A query with no data and `fetchStatus === 'paused'` (R2-M4). The strip reads «Немає з’єднання» / «Повторити можна, коли з’явиться мережа»; the error card shows «Немає з’єднання» + «Збережених даних ще немає. Підключіться до інтернету й повторіть.» + a disabled «Повторити» (`aria-disabled`); the company row and compliance name the cause too (R3-11): «Баланс недоступний без з’єднання» and «Контроль доходів недоступний без з’єднання.», each with its own disabled «Повторити». Everything resumes by itself on reconnect                                                                                                                                                                                                                                                                                                                                                                                                |
| balanced                    | Amount `<= 0.01` → the answer reads «Баланси вирівняно» / «Різниці між балансами немає», no direction line; shares and bars stay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| one partner (defensive, M4) | «Поки що один партнер — вирівнювати нічого» in place of the answer, one balance row at 100 %, «Разом» and the share caption; no direction line, never «Баланси вирівняно»                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| long content                | A long partner name wraps (2–3 lines, never truncated on touch classes); a negative balance shows U+2212 and share «—» (today's rule) with its bar kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| no wallet                   | The balance stays (`<balance> USDT`, today's behaviour, R3-M17) with the sub-line «Гаманець не налаштовано». ADMIN: «Налаштувати гаманець» button; ACCOUNTANT: text only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| permission                  | §2.3. Other roles never see the screen (route redirect)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| interaction                 | §2.4 (series sheet, month sheet, hint sheets, scrub, hover, expanded receiver)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### 2.2.1 State × class matrix

A cell names the frame that draws the state in that class, or `rule: <frame>` when the class uses the same
block treatment as the named frame and only the arrangement differs.

| State                                                       | Phone (< 640)                                                                                                                              | Tablet (640–1023)                                                                                     | Desktop (≥ 1024)                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| default                                                     | `default-320`, `default-375`, `full-320`, `full-375`                                                                                       | `default-768`, `default-1000`                                                                         | `default-1024`, `default-1280`, `default-1440`, `default-1920`  |
| 12 months / «Усе»                                           | `scrub-12m-375`, `all-320`, `all-375`                                                                                                      | `select-768`, `select-1000` (12 mo); `all-768` («Усе», 20 bands of 28.7 px, coarse pointer, measured) | `all-1280`                                                      |
| loading                                                     | `loading-320`, `loading-375`                                                                                                               | `loading-768`                                                                                         | `loading-1440`                                                  |
| empty                                                       | `empty-375`                                                                                                                                | rule: `empty-375` blocks in the column                                                                | `empty-1440`                                                    |
| error (summary)                                             | `error-320`, `error-375`                                                                                                                   | `error-768`                                                                                           | `error-1440`                                                    |
| partial                                                     | `partial-375`                                                                                                                              | rule: `partial-375` blocks in the column                                                              | `partial-1440`                                                  |
| stale                                                       | `stale-375`, `stale-yesterday-375` (dated stamp), `stale-yesterday-320` (icon-only retry), `stale-scrolled-375` (sticky), `retry-busy-375` | `stale-768` (strip across the pane, sticky)                                                           | `stale-1440`                                                    |
| offline, cached                                             | `offline-375`                                                                                                                              | rule: `offline-375` strip across the pane                                                             | `offline-1440`                                                  |
| cold offline                                                | `cold-375`                                                                                                                                 | rule: `cold-375` card + strip (retry disabled)                                                        | rule: `cold-375` card + strip, `error-1440` geometry            |
| balanced                                                    | `balanced-375`                                                                                                                             | rule: `balanced-375` answer in the wide partner card                                                  | `balanced-1440`                                                 |
| one partner                                                 | `onepartner-375`                                                                                                                           | rule: `onepartner-375` text in the wide partner card                                                  | rule: `onepartner-375` text in the compact partner card         |
| long content                                                | `long-320`, `long-375`                                                                                                                     | `long-768`                                                                                            | `long-1440`                                                     |
| no wallet                                                   | `nowallet-375`                                                                                                                             | rule: `nowallet-375` company row                                                                      | rule: `accountant-1440` (text only) and `nowallet-375` (button) |
| ACCOUNTANT                                                  | `accountant-375`                                                                                                                           | rule: `accountant-375` blocks, rail without «Адмін»                                                   | `accountant-1440`                                               |
| series choice                                               | `series-sheet-375`                                                                                                                         | segmented control (`default-768`, `select-768`)                                                       | segmented control (every desktop frame)                         |
| month detail                                                | `month-sheet-375`                                                                                                                          | rule: the table row; the readout carries the values                                                   | `hover-1440`, table row                                         |
| hint                                                        | `hint-sheet-375`, `hint-partner-375`                                                                                                       | `hint-popover-768` (44 px info buttons)                                                               | tooltip on hover / focus                                        |
| receiver expanded                                           | `compliance-expanded-375`, `compliance-variants-375` (every status variant)                                                                | rule: `compliance-expanded-375`                                                                       | `compliance-variants-1440` (rows expand in place)               |
| coarse pointer, wide                                        | —                                                                                                                                          | —                                                                                                     | `touch-1024`                                                    |
| mixed: summary cached, company account failed with no cache | rule: `partial-375` company block + `stale-375` strip (stamp = summary)                                                                    | rule: same                                                                                            | rule: `partial-1440` company block + `stale-1440` strip         |
| mixed: summary stale, compliance fresh                      | rule: `stale-375` strip (stamp = summary); compliance shows nothing extra                                                                  | rule: same                                                                                            | rule: same (`stale-1440`)                                       |
| mixed: only compliance failed, summary and company fresh    | `partial-375` compliance block with its own «Повторити»; no strip                                                                          | rule: same                                                                                            | `partial-1440`; no strip                                        |
| retry running                                               | `retry-busy-375`                                                                                                                           | rule: `retry-busy-375` button                                                                         | rule: `retry-busy-375` button (44 px)                           |

Baseline captures of today's screen and the network baseline: **pending** (no running stack in this
pass; manual-qa captures them before the coder starts).

### 2.3 Per-role variants

| Role       | Phone / tablet / desktop                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN      | Blocks 1–5. The company row shows «Налаштувати гаманець» (44 px on touch, 32 px on a fine pointer) when no wallet exists (`nowallet-375`); the button opens `/admin/wallet`. The shell nav includes the «Адмін» group                                                                                                  |
| ACCOUNTANT | Blocks 1–5, identical data (the server returns `adminBalances` to ACCOUNTANT and today's screen shows it). The company row without a wallet is text only, no button (`accountant-375`, `accountant-1440`). The nav has no «Адмін» group and no admin-only entries; `accountant-1440` draws that sidebar at full height |
| others     | No change: the route redirects to `/`                                                                                                                                                                                                                                                                                  |

The ACCOUNTANT frames draw the role's navigation inside this screen's own source (`withRole` in
`assets/src/wide.mjs` swaps the nav arrays around the foundation call and restores them); the foundation
files are untouched (M8). The same wrapper puts the drawn role in the sidebar user chip (R2-M11):
`accountant-1440` shows «Марина Савчук · Бухгалтер», the ADMIN frames «Віктор Кравець · Адміністратор»
(invented names). The coder takes the real sidebar and the real signed-in user from the role's nav and the
session.

### 2.4 Interaction and motion

- **Period** (segmented, all classes): «6 міс» default, «12 міс», «Усе». Client-side slice of
  `summary.monthly`; no refetch. Written to the URL as `period` (M2); the default is omitted.
- **Series (R2-M1)**: phone → the pill «Прибуток ▾» opens a bottom sheet with 4 radio rows
  (`series-sheet-375`); tablet and desktop → a segmented control with the same 4 radios (`default-768`,
  `default-1000`, every desktop frame); there is no popover for the series. Written to the URL as `series`.
  Default «Прибуток» (today: «Дохід»).
- **Gestures, one per axis (R1-07).** The plot has exactly one gesture on each axis, and none competes with
  page scroll:
  - _Vertical:_ page scroll only. The plot never captures a vertical drag (`touch-action: pan-y` on the plot).
  - _Horizontal:_ in fit mode a horizontal drag across the plot scrubs the selection (the dot and the
    readout follow the finger, the URL updates on release). In strip mode the same horizontal drag scrolls
    the strip (native overflow scroll, the newest month at the right edge) and does not scrub; the selection
    is changed by a tap on a band or by ‹ ›.
  - _Tap:_ selects the band under the finger (any mode). A tap on the already selected band opens the month
    sheet (phone) or follows the table row (wide).
  - ‹ › and the Left / Right keys are the single-pointer path for every gesture (WCAG 2.5.7).
- **Selected month** defaults to the newest month, written to the URL as `month=YYYY-MM` (omitted for the
  newest). At 6 months every band is ≥ 44 px; at 12 months at 375 bands are ≈ 24 px (the 44 px ‹ › buttons
  compensate, 2.5.8); «Усе» uses the strip (28 px bands).
- **Month sheet (phone):** the readout's «›», or a second tap on the selected bar, opens a sheet titled with
  the month («Листопад 2026») and a ‹ › pair in the header that moves to the previous / next month without
  closing it. On the newest month › is `aria-disabled` at 40 % opacity (`month-sheet-375` shows it). The
  sheet lists Дохід / Витрати / Зарплати / Прибуток for the month, the drill-down row «Транзакції за
  <month> <year>» (M1; opens the finance list filtered to that month) and a 44 px «Закрити». Detent: medium
  (content height); drag down or Esc dismisses; focus returns to the readout.
- **Hints:** every info button opens that block's existing hint text. Phone: a bottom sheet
  (`hint-sheet-375`, `hint-partner-375`). Tablet: a popover anchored to the partner card (side bottom), as wide as the card (648 px at 768), hint text at 13 / 18 px, on the shell's own popover surface, non-modal, no scrim (`hint-popover-768`, R3-15, R4-04). It leaves the partner rows it explains in view; while open it covers only the chart card's heading row (the h2 and the period control) and ends above the series control, so the series control, the readout with «Зарплати» and the plot stay visible (measured, §2.5). The card's width keeps the text to four lines; a narrower popover would be taller and reach the readout. Desktop, fine pointer:
  a tooltip on hover **and** focus, dismissable with Esc, hoverable (WCAG 1.4.13). Coarse pointer at any
  width: the phone / tablet container, never a tooltip (M7).
- **Hint-sheet detents (R1-23).** A hint sheet is sized to its content, not to a fixed share of the screen:
  one short paragraph gives a ≈ 196 px sheet (KPI), the partner hint 266 px (it carries the formula and the
  rate sentence, R2-11), the company hint ≈ 232 px.
  The sheet has one detent (content height). It grows to the medium detent only when the text is taller
  than that, and then scrolls inside. A drag handle, Esc and the close button dismiss it.
- **Compliance row:** tap or Enter toggles «Проєкти без зарахованого доходу» (`compliance-expanded-375`);
  `aria-expanded` mirrors it. Desktop expands in place.
- **Drill-down (M1):** the month sheet row and the month-table rows (`role="link"`) go to the finance list
  with a `month=YYYY-MM` filter. Back returns to this screen with the same URL state.
- **Month bucket rule (R2-M8).** `summary.monthly` is built from PAID transactions, bucketed by the month of
  the transaction's `txDate`: a Kyiv business day stored as a date at UTC midnight, so
  `txDate.toISOString().slice(0, 7)` is the Kyiv business month (`transactionBusinessMonth` in
  `apps/api/src/finance/transaction-date.util.ts`, used by `SummaryService.getSummary`). There is no
  `createdAt` fallback. The finance list filter `month=YYYY-MM` must use the same rule, so the list and the
  bar agree (dependency on the finance-list spec, PR #1393, whose M1 points back here). The API already
  buckets in Kyiv, so no zone discrepancy exists and no open point is raised for it.
- **Selected row in view (R2-23).** When the selected month changes (tap, ‹ ›, key or click) and its table
  row is outside the table's visible rows, the table scrolls the row into view (`block: 'nearest'`). In
  `all-1280` the selected September 2026 is already inside the 8-row window, so nothing scrolls; the
  mockup source applies the same rule to a month beyond the eighth row.
- **Retry:** every «Повторити» refetches only its own query key (§2.7).
- **FAB:** fades out (150 ms) while the chart card is in the FAB zone and back when it leaves (M8, Open
  point 8); hidden for the whole loading state (R2-M6).
- **Status strip (R2-M3, R2-M4):** one strip per page, never one per block. Its stamp is the oldest
  `dataUpdatedAt` of the blocks showing cached data. «Повторити» in the strip refetches every failed query
  with cached data; while it runs the button is busy and ignores taps (`retry-busy-375`). Offline it is
  `aria-disabled` and the strip says why; reconnect resumes the paused queries by itself.
- **Motion:** bars grow from the zero line on first data (200 ms, `ease-out`) and crossfade on series or
  period change (150 ms). The readout number does not count up. Sheets use the foundation sheet motion.
  `prefers-reduced-motion`: no grow, instant swaps.

### 2.5 A11y (WCAG 2.2 AA)

**Measured from the mockup source (R2-M13).** `assets/src/measure.mjs` loads the rendered frame HTML in
Chromium at the frame's width and reads computed bounds. Run it with the render environment
(`PLAYWRIGHT_MODULE`, `LUCIDE_ICONS_DIR`); it is a gate (R3-M21) and exits non-zero when a measured claim fails. Output of the
final run (58 frames rendered first, no overflow warning from `render.mjs`); its last line reads
`measure.mjs: 59 checks, 0 failed — all measured claims hold`:

| Check                                                                                  | Result                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading frame against its default frame: block tops and heights (limit 8 px, R2-M5)    | `loading-375`, `loading-320` 11 blocks each, `loading-768` 18, `loading-1440` 12; worst delta **0 px** in all four                                                                                                                                                                                                                               |
| Targets below the minimum in the content pane, coarse pointer (44 px)                  | `default-375` 30 checked, `default-320` 30, `error-375` 7, `stale-375` 31, `stale-yesterday-375` 31, `offline-375` 30, `cold-375` 4, `series-sheet-375` 35, `month-sheet-375` 38, `hint-sheet-375` 31, `default-768` 31, `default-1000` 31, `touch-1024` 32 (content area): **0 below**                                                          |
| Targets below the minimum in the content pane, fine pointer (24 px, WCAG 2.2 SC 2.5.8) | `default-1440` 32 checked: **0 below**                                                                                                                                                                                                                                                                                                           |
| `touch-1024` sidebar (R2-M12)                                                          | 12 nav rows, all 44 px; search field 48 px. The shell rule `.touch .srow` is dead in the foundation source (two `class` attributes), so this screen's source merges them; Open points 18 and 19 are the foundation follow-up                                                                                                                     |
| Month table against its card, cells clipped or inside the 12 px edge (R2-M10)          | `default-768` card 648 / table 606 px, `default-1000` 880 / 838, `default-1024` 728 / 686, `default-1280` 588 / 546, `all-1280` 588 / 546, `default-1440` 748 / 706, `all-768` 648 / 606 (R3-M19: no inner scroller on a coarse pointer, as in `default-768` and `default-1000`): **0 clipped**                                                  |
| Status strip (R3-M16)                                                                  | `stale-375`, `stale-yesterday-375`, `offline-375`, `cold-375`: 343 px wide, box **44 px**, occupies 48 px; `stale-yesterday-320`: 296 px wide, box 44 px; `stale-1440`, `offline-1440`: 1144 px wide, box 44 px. First block top with and without the strip: 194 / 142 px at 375, 160 / 108 px at 320, 140 / 76 px at 1440                       |
| Sheet close controls (R3-17)                                                           | `series-sheet-375`, `month-sheet-375`, `hint-sheet-375`: the foundation close button is a **44 × 44 px** box; the drawn chip inside it is smaller, the box is the hit area                                                                                                                                                                       |
| Loading frames carry placeholders only (R3-M15)                                        | `loading-375`, `loading-320`, `loading-768`, `loading-1440`: no data text node, no chromatic fill or border, uniform bars                                                                                                                                                                                                                        |
| Text contrast per node (R3-M21)                                                        | `default-375` 103 nodes (lowest 134 % of the required ratio), `default-320` 104 (134 %), `default-768` 165 (122 %), `default-1000` 165 (122 %), `default-1440` 179 (122 %), `stale-375` 106 (128 %), `offline-375` 106 (128 %), `cold-375` 17 (128 %; 3 disabled controls exempt), `error-375` 49 (134 %): **0 below the minimum**, 0 unmeasured |

Scope of the target claim: the content pane of the frames named in the two target rows above. The segmented controls, ‹ ›, info
buttons, receiver rows and table rows are all counted there; chart bands are not buttons and are listed
below. The sidebar rows of the desktop shell on a fine pointer follow the shell catalog and are not measured
here.

| Not a script result (stated by construction)                                      | Value                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plot bands under a coarse pointer                                                 | 51.8 px wide at 375 and 45.3 px at 320 (6 months), 47.8 px at 768 (12 months); 24.1 px at 375 with 12 months, 28 px in the 20-month strip — ≥ 24 px (2.5.8), with 44 px ‹ › as the single-pointer path          |
| Token pairs on `--card` (computed from the token values, not from rendered nodes) | `--fg` 18.61 · `--muted-fg` 6.03 (5.77 on `--surface`, 5.49 on `--raised`) · `--destructive` 5.67 · `--positive` 10.03 · `--chart-1` 12.26 · `--chart-2` 7.63; all above the 4.5 : 1 text and 3 : 1 mark limits |
| Chart marks (non-text, 3 : 1 needed)                                              | bars `--chart-1` 12.26 : 1 and `--chart-2` 7.63 : 1 on `--card`; the selected bar's 2 px `--fg` outline sits outside the bar edge, against `--card` (18.61 : 1)                                                 |
| Gridlines and zero line (`--chart-grid`, 1.17 : 1)                                | Decorative: every value is also text (readout, table, labels), so 1.4.11 does not apply                                                                                                                         |

The earlier per-node figures («5 429 text nodes, min 5.18 : 1», «1 500 interactive elements») came from an
ad-hoc script that was not committed and stay withdrawn. The per-node contrast row above comes from
`measure.mjs` (R3-M21): it resolves each text node's colour against the first opaque background above it,
uses 4.5 : 1 (3 : 1 for large text) and exempts disabled controls. It covers the default frame of each class
and the five state frames named in the row, not every frame; non-text contrast stays the token-pair
statement above.

- **Chart equivalent (R1-05).** Every class carries a real `<table>` of the plotted months: `<caption>`
  «Ті самі місяці, що й на графіку», `<th scope="col">` headers, `<th scope="row">` for the month, one column
  per series (Дохід, Витрати, Зарплати, Прибуток), rows `role="link"` for the drill-down. Tablet and desktop
  show it (52 px / 40 px rows). The phone renders it visually hidden (`sr-only`) for screen readers, and the
  month sheet is the visible equivalent.
- **Keyboard on the plot.** The plot is a `role="group"` labelled «Динаміка за місяцями, <series>, <period>»
  (the `aria-label` carries the summary sentence: best month and loss month). Bars are not individual tab
  stops. The group has one tab stop with **roving focus**: Left / Right move the selection by one month,
  Home / End jump to the first / last, Enter opens the month sheet (phone) or follows the row (wide). The
  recorded deviation from primitives §6: no per-bar tab stops, because 20 stops would trap keyboard users;
  the table gives direct access to each month.
- **Readout** is an `aria-live="polite"` region and updates on ‹ ›, tap, key and scrub end, not on every
  scrub frame.
- **Loss marker:** hatch fill **and** the U+2212 sign in the label, readout, table and `aria-label`
  («Вересень 2026: −1,4 тис. USD»); never colour alone.
- **Headings:** h1 «Статистика»; h2 per block («Баланси партнерів», «Динаміка за місяцями» — `sr-only` on
  phone, visible from tablet — «Рахунок компанії», «Показники», «Контроль доходів»).
- **Partner card:** the answer is read in order as «Для вирівнювання 2 730,25 USDT. Надсилає: Віктор
  Кравець. Отримує: Олена Шевчук.» (`stats.partners.settlementSr`). The sentence names the two partners in
  the nominative and never inflects a name (R3-M20); the arrow icon is `aria-hidden`; share bars are
  `aria-hidden` because the % is text.
- **Segmented controls:** `radiogroup` / `radio` with `aria-checked`; the series sheet is a `listbox` with
  `option` rows and `aria-selected`.
- **Sheets:** focus trapped, Esc and the close button dismiss, focus returns to the trigger.
- **Hints:** info buttons are `<button aria-label="Пояснення: <block>">`.
- **Status regions:** loading is one `role="status"` («Завантаження статистики»); the status strip (stale,
  offline, cold) is `role="status"`; error cards are `role="alert"`.
- **Numbers:** `tabular-nums` on every amount; `formatMoney` with uk grouping and U+2212.
- **Inputs:** none on this screen (no 16 px input rule to apply).
- **Reflow:** no horizontal page scroll at 320; the renderer checks every frame for overflow outside
  sr-only content and sheets, and none was reported in the final render of 58 frames.

### 2.6 Strings (`uk` / `en`)

Complete list: every visible string and every `aria-label` that appears in any of the 58 frames, in `uk`
(source) and `en`. Keys are suggestions. Four groups are not repeated per frame: fixture data (partner and
project names, amounts, wallet address — see the end of this section), the shell chrome owned by the shell
catalog (last table), month names, and the generated chart labels. A string that appears in a frame with
values filled in (a month and year, an amount, a percentage, initials, «Пояснення: <block>», «Разом
<amount>») is covered by its templated row. A script check of round 2 against every visible string and `aria-label`
extracted from the 54 frames rendered then (`strcheck`, a throwaway script outside the repo, not re-run for the 58) reported 22 strings with no literal row; all 22 are instances of the templated rows `stats.chart.summary`, `stats.month.transactions` and the month names, which differ only in the month, year or series value. The strings added in round 3 (offline causes, hover caption, income statuses, strip wording) were added to the tables below by hand against the frames that draw them.

#### Partner balances

| Key                           | uk                                                                                                                                                                                                                                                            | en                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats.partners.title`        | Баланси партнерів                                                                                                                                                                                                                                             | Partner balances                                                                                                                                                                                                                                                        |
| `stats.partners.hint`         | Накопичений баланс кожного партнера: усі оплачені надходження та дохід партнерів мінус перекази між партнерами. Баланси рахуються в USD, рахунок компанії — в USDT (1 USDT = 1 USD). Для вирівнювання один партнер надсилає іншому половину різниці балансів. | Each partner's running balance: all paid receipts and partner income minus transfers between partners. Balances are counted in USD, the company account in USDT (1 USDT = 1 USD). To even out, one partner sends the other half of the difference between the balances. |
| `stats.partners.hintLabel`    | Пояснення: Баланси партнерів                                                                                                                                                                                                                                  | About: Partner balances                                                                                                                                                                                                                                                 |
| `stats.partners.evenOut`      | Для вирівнювання                                                                                                                                                                                                                                              | To even out                                                                                                                                                                                                                                                             |
| `stats.partners.settlementSr` | Надсилає: {rich}. Отримує: {poor}. (screen-reader sentence after «Для вирівнювання {amount}»; names stay nominative)                                                                                                                                          | Sends: {rich}. Receives: {poor}.                                                                                                                                                                                                                                        |
| `stats.partners.sends`        | надсилає                                                                                                                                                                                                                                                      | sends                                                                                                                                                                                                                                                                   |
| `stats.partners.receives`     | отримує                                                                                                                                                                                                                                                       | receives                                                                                                                                                                                                                                                                |
| `stats.partners.shareRow`     | {share} % · надсилає / {share} % · отримує / — · отримує (share `—` when the balance is negative)                                                                                                                                                             | {share}% · sends / {share}% · receives / — · receives                                                                                                                                                                                                                   |
| `stats.partners.total`        | Разом {amount}                                                                                                                                                                                                                                                | Total {amount}                                                                                                                                                                                                                                                          |
| `stats.partners.shareNote`    | Частка — від суми балансів без урахування знака                                                                                                                                                                                                               | Share is of the sum of balances, ignoring the sign                                                                                                                                                                                                                      |
| `stats.partners.balanced`     | Баланси вирівняно                                                                                                                                                                                                                                             | Balances are even                                                                                                                                                                                                                                                       |
| `stats.partners.balancedSub`  | Різниці між балансами немає                                                                                                                                                                                                                                   | There is no difference between the balances                                                                                                                                                                                                                             |
| `stats.partners.single`       | Поки що один партнер — вирівнювати нічого                                                                                                                                                                                                                     | Only one partner so far — nothing to even out                                                                                                                                                                                                                           |

#### Chart

| Key                          | uk                                                                                                                                      | en                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats.chart.title`          | Динаміка за місяцями                                                                                                                    | Monthly trend                                                                                                                                      |
| `stats.chart.period.6`       | 6 міс                                                                                                                                   | 6 mo                                                                                                                                               |
| `stats.chart.period.12`      | 12 міс                                                                                                                                  | 12 mo                                                                                                                                              |
| `stats.chart.period.all`     | Усе                                                                                                                                     | All                                                                                                                                                |
| `stats.chart.series.profit`  | Прибуток                                                                                                                                | Profit                                                                                                                                             |
| `stats.chart.series.income`  | Дохід                                                                                                                                   | Income                                                                                                                                             |
| `stats.chart.series.expense` | Витрати                                                                                                                                 | Expenses                                                                                                                                           |
| `stats.chart.series.salary`  | Зарплати                                                                                                                                | Salaries                                                                                                                                           |
| `stats.chart.seriesLabel`    | Показник графіка                                                                                                                        | Chart series                                                                                                                                       |
| `stats.chart.seriesAria`     | Показник графіка: {series}                                                                                                              | Chart series: {series}                                                                                                                             |
| `stats.chart.unit`           | тис. {currency}                                                                                                                         | {currency} thousands                                                                                                                               |
| `stats.chart.loss`           | збиток                                                                                                                                  | loss                                                                                                                                               |
| `stats.chart.stripHint`      | Гортайте, щоб побачити раніші місяці                                                                                                    | Scroll to see earlier months                                                                                                                       |
| `stats.chart.prev`           | Попередній місяць                                                                                                                       | Previous month                                                                                                                                     |
| `stats.chart.next`           | Наступний місяць                                                                                                                        | Next month                                                                                                                                         |
| `stats.readout.selected`     | Вибрано: {month} (docked readout caption, R3-M22)                                                                                       | Selected: {month}                                                                                                                                  |
| `stats.readout.hovered`      | Наведено: {month} (fine pointer, while a bar is hovered)                                                                                | Hovering: {month}                                                                                                                                  |
| `stats.chart.summary`        | {series} за {n} міс., тис. {currency}: найбільше — {bestMonth}, {best}; збиток — {lossMonth}, {loss}. Ті самі місяці є в таблиці нижче. | {series} over {n} months, {currency} thousands: highest — {bestMonth}, {best}; loss — {lossMonth}, {loss}. The same months are in the table below. |
| `stats.chart.barAria`        | {month} {year}: {value} тис. USD                                                                                                        | {month} {year}: {value} thousand USD                                                                                                               |
| `stats.chart.tickJan`        | січ ’26 (month abbreviation, year added to January)                                                                                     | Jan ’26                                                                                                                                            |
| `stats.chart.empty`          | Ще немає даних за місяцями                                                                                                              | No monthly data yet                                                                                                                                |
| `stats.chart.emptySub`       | Графік з’явиться після першої оплаченої транзакції.                                                                                     | The chart appears after the first paid transaction.                                                                                                |
| `stats.chart.emptyAction`    | Нова транзакція                                                                                                                         | New transaction                                                                                                                                    |
| `stats.table.caption`        | Ті самі місяці, що й на графіку · суми в {currency}                                                                                     | Same months as the chart · amounts in {currency}                                                                                                   |
| `stats.table.month`          | Місяць                                                                                                                                  | Month                                                                                                                                              |
| `stats.table.shown`          | Показано {shown} з {total}                                                                                                              | Showing {shown} of {total}                                                                                                                         |
| `stats.month.transactions`   | Транзакції за {month} {year}                                                                                                            | Transactions for {month} {year}                                                                                                                    |
| `stats.month.close`          | Закрити                                                                                                                                 | Close                                                                                                                                              |

Month names (uk / en): Квітень, Травень, Червень, Липень, Серпень, Вересень, Жовтень, Листопад, Грудень,
Січень, Лютий, Березень / April, May, June, July, August, September, October, November, December, January,
February, March. Abbreviations (axis): квіт, трав, черв, лип, серп, вер, жовт, лист, груд, січ, лют, бер /
Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec, Jan, Feb, Mar. The table and the sheet title use «<month>
<year>» («Листопад 2026»); the drill-down row and the table row label carry the year too («Транзакції за
листопад 2026», `stats.month.transactions`).

#### Company account, KPIs, states

| Key                          | uk                                                                                                                                                 | en                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `stats.company.title`        | Рахунок компанії                                                                                                                                   | Company account                                                                                                                           |
| `stats.company.sub`          | USDT · {address}                                                                                                                                   | USDT · {address}                                                                                                                          |
| `stats.company.hint`         | Накопичений USDT-баланс на рахунку компанії — поповнюється через підтверджені виплати (метод «Рахунок компанії») і зменшується на суму дивідендів. | Accumulated USDT balance of the company account — topped up by confirmed payouts (the “Company account” method) and reduced by dividends. |
| `stats.company.noWallet`     | Гаманець не налаштовано                                                                                                                            | Wallet is not set up                                                                                                                      |
| `stats.company.setup`        | Налаштувати гаманець                                                                                                                               | Set up wallet                                                                                                                             |
| `stats.company.error`        | Не вдалося завантажити баланс                                                                                                                      | Couldn’t load the balance                                                                                                                 |
| `stats.company.offline`      | Баланс недоступний без з’єднання (cold offline, R3-11)                                                                                             | Balance unavailable without a connection                                                                                                  |
| `stats.kpi.title`            | Показники                                                                                                                                          | Key figures                                                                                                                               |
| `stats.hint.label`           | Пояснення: {name}                                                                                                                                  | About: {name}                                                                                                                             |
| `stats.kpi.totalIncome`      | Загальний дохід                                                                                                                                    | Total income                                                                                                                              |
| `stats.kpi.totalIncome.hint` | Сума всіх оплачених надходжень та доходу сеньйорів і адмінів за весь час.                                                                          | Sum of all paid receipts and senior and admin income over all time.                                                                       |
| `stats.kpi.trend`            | {percent} % за місяць (U+2212 when negative)                                                                                                       | {percent}% vs last month                                                                                                                  |
| `stats.kpi.expenses`         | Витрати                                                                                                                                            | Expenses                                                                                                                                  |
| `stats.kpi.expenses.hint`    | Сума всіх оплачених операційних витрат компанії.                                                                                                   | Sum of all paid operating expenses of the company.                                                                                        |
| `stats.kpi.salaries`         | Зарплати                                                                                                                                           | Salaries                                                                                                                                  |
| `stats.kpi.salaries.hint`    | Сума всіх виплачених зарплат співробітникам компанії за весь час.                                                                                  | Sum of all salaries paid to company staff over all time.                                                                                  |
| `stats.kpi.net`              | Чистий баланс                                                                                                                                      | Net balance                                                                                                                               |
| `stats.kpi.net.hint`         | Чистий залишок: дохід мінус витрати та зарплати. Додатне значення = компанія в плюсі.                                                              | Net remainder: income minus expenses and salaries. A positive value means the company is in the black.                                    |
| `stats.kpi.lastIncome`       | Дохід за останній місяць                                                                                                                           | Income for the latest month                                                                                                               |
| `stats.kpi.lastIncome.hint`  | Виручка за {month} {year}. Включає доходи всіх сеньйорів і адмінів.                                                                                | Revenue for {month} {year}. Includes the income of all seniors and admins.                                                                |
| `stats.kpi.lastProfit`       | Прибуток за останній місяць                                                                                                                        | Profit for the latest month                                                                                                               |
| `stats.kpi.lastProfit.hint`  | Чистий прибуток за {month} {year}: дохід мінус витрати та зарплати того місяця.                                                                    | Net profit for {month} {year}: income minus that month's expenses and salaries.                                                           |
| `stats.kpi.margin`           | Маржа: {percent} %                                                                                                                                 | Margin: {percent}%                                                                                                                        |
| `stats.kpi.average`          | Середній дохід / міс.                                                                                                                              | Average income / month                                                                                                                    |
| `stats.kpi.average.hint`     | Середньомісячна виручка за весь час роботи компанії.                                                                                               | Average monthly revenue over the company's whole history.                                                                                 |
| `stats.kpi.average.sub`      | за {n} місяців (ICU plural: місяць / місяці / місяців / місяця)                                                                                    | over {n} months                                                                                                                           |
| `stats.kpi.best`             | Найкращий місяць                                                                                                                                   | Best month                                                                                                                                |
| `stats.kpi.best.hint`        | Місяць із найбільшою виручкою за весь час.                                                                                                         | The month with the highest revenue of all time.                                                                                           |
| `stats.error.title`          | Не вдалося завантажити фінансову статистику                                                                                                        | Couldn’t load finance statistics                                                                                                          |
| `stats.error.body`           | Баланси партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.                                  | Partner balances, the chart and key figures are unavailable. The company account and income control below load separately.                |
| `stats.stale`                | Не вдалося оновити (line 1) · станом на {when} (line 2; {when} = «14:32», or «10.11 о 14:32» when not today, `nowrap`)                             | Couldn’t refresh (line 1) · as of {when} (line 2)                                                                                         |
| `stats.offline`              | Немає з’єднання (line 1) · показано дані станом на {when} (line 2)                                                                                 | No connection (line 1) · showing data as of {when} (line 2)                                                                               |
| `stats.offlineCold`          | Немає з’єднання (strip, line 1) · Повторити можна, коли з’явиться мережа (strip, line 2) · the error card title repeats «Немає з’єднання»          | No connection (strip and card title) · You can retry when the network returns                                                             |
| `stats.offlineCold.body`     | Збережених даних ще немає. Підключіться до інтернету й повторіть.                                                                                  | There is no saved data yet. Connect to the internet and retry.                                                                            |
| `stats.loading`              | Завантаження статистики                                                                                                                            | Loading statistics                                                                                                                        |
| `common.retry`               | Повторити                                                                                                                                          | Retry                                                                                                                                     |
| `common.close`               | Закрити                                                                                                                                            | Close                                                                                                                                     |

#### Income control

| Key                                  | uk                                                                                                                                                                                | en                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `stats.compliance.title`             | Контроль доходів                                                                                                                                                                  | Income control                                                                |
| `stats.compliance.total`             | Усього доходів                                                                                                                                                                    | Income entries                                                                |
| `stats.compliance.coverage`          | покриття {percent} % · {month}                                                                                                                                                    | coverage {percent}% · {month}                                                 |
| `stats.compliance.complete`          | Закриті повністю                                                                                                                                                                  | Fully closed                                                                  |
| `stats.compliance.lagging`           | Відстають                                                                                                                                                                         | Lagging                                                                       |
| `stats.compliance.pending`           | На валідації у бухгалтера                                                                                                                                                         | With the accountant for validation                                            |
| `stats.compliance.receivers`         | отримувач / отримувачі / отримувачів / отримувача (ICU plural)                                                                                                                    | receiver / receivers                                                          |
| `stats.compliance.incomes`           | дохід / доходи / доходів / доходу (ICU plural)                                                                                                                                    | income / incomes                                                              |
| `stats.compliance.projects`          | {n} активний проєкт / активні проєкти / активних проєктів / активного проєкту (ICU plural; the receiver row reads «<role> · <this string>», e.g. «Сеньйор · 5 активних проєктів») | {n} active project / projects                                                 |
| `stats.compliance.role.admin`        | Адмін-сеньйор                                                                                                                                                                     | Admin-senior                                                                  |
| `stats.compliance.role.senior`       | Сеньйор                                                                                                                                                                           | Senior                                                                        |
| `stats.compliance.role.drop`         | Дроп                                                                                                                                                                              | Drop                                                                          |
| `stats.compliance.allReceived`       | Усі отримано                                                                                                                                                                      | All received                                                                  |
| `stats.compliance.inProgress`        | {n} у процесі                                                                                                                                                                     | {n} in progress                                                               |
| `stats.compliance.noIncome`          | {n} без доходу (ICU plural on the count)                                                                                                                                          | {n} without income                                                            |
| `stats.compliance.projectsOpen`      | Проєкти без зарахованого доходу                                                                                                                                                   | Projects without credited income                                              |
| `stats.compliance.projectNone`       | Немає доходу                                                                                                                                                                      | No income                                                                     |
| `stats.compliance.footnote`          | Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць.                                                                                                    | Income counts when its status is “validated” or “paid” for the current month. |
| `stats.compliance.empty`             | Немає активних проєктів-отримувачів доходу за {month}.                                                                                                                            | No active income-receiving projects for {month}.                              |
| `stats.compliance.error`             | Не вдалося завантажити дані контролю доходів.                                                                                                                                     | Couldn’t load the income control data.                                        |
| `stats.compliance.offline`           | Контроль доходів недоступний без з’єднання. (cold offline, R3-11)                                                                                                                 | Income control is unavailable without a connection.                           |
| `stats.compliance.noIncomes`         | Немає доходів (receiver badge)                                                                                                                                                    | No incomes                                                                    |
| `stats.compliance.accrued`           | Нараховано / {n} нараховано (ICU plural; receiver badge, R3-M18)                                                                                                                  | Accrued / {n} accrued                                                         |
| `stats.compliance.pendingValidation` | На валідації / {n} на валідації (ICU plural; receiver badge)                                                                                                                      | In validation / {n} in validation                                             |
| `stats.compliance.projectPending`    | На валідації (open project row)                                                                                                                                                   | In validation                                                                 |
| `stats.compliance.projectAccrued`    | Нараховано · очікує розрахунку (open project row)                                                                                                                                 | Accrued · awaiting settlement                                                 |

Role labels and ICU plural forms are today's (`apps/web` catalog); the redesign reuses them.

#### Shell chrome that appears in the frames (owned by the shell catalog, not this screen)

| uk                                                                                                                                                                                             | en                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Статистика (screen title, nav entry) · Дашборд · Огляд · Фінанси · Чекають рішення · Транзакції · Проєкти · Вакансії · Співбесіди · Команда                                                    | Statistics · Dashboard · Overview · Finance · Pending · Transactions · Projects · Vacancies · Interviews · Team                                                   |
| Документи · Користувачі · Люди · Найм · Робота · Система · Гроші · Адмін · Адміністратор · Бухгалтер · Черга зовнішніх вакансій                                                                | Documents · Users · People · Hiring · Work · System · Money · Admin · Administrator · Accountant · External vacancy queue                                         |
| Пошук · Пошук або команда · ⌘K · Сповіщення, 2 нові · Створити · Нова транзакція · Основна навігація · Згорнути бічну панель · Ще · 9:41 вт 11 лист. · Cheeky Cheese · CRM · Cheeky Cheese CRM | Search · Search or command · Notifications, 2 new · Create · New transaction · Main navigation · Collapse sidebar · More · Tue 11 Nov, 9:41 · Cheeky Cheese · CRM |

Which shell items show depends on the role's nav; the labels are the shell's.

#### Fixture data (not product strings)

Partner and receiver names (Віктор Кравець, Олена Шевчук, Дмитро Бондар, Олександра Вишневецька-Коваленко,
Ірина Мельник, Софія Лисенко, Андрій Ткачук; in the variant frames Олег Гнатюк, Марта Кравчук, Тарас
Білик, Оксана Лук’яненко, Богдан Мороз, Назар Гриценко), the accountant in `accountant-1440` (Марина
Савчук), their initials, the project names «Orbita CRM», «Lumen Retail», «Nimbus Portal», «Verde
Market», «Helio Studio», «Quartz Media», «Atlas Billing», «Fjord Logistics», «Pixel Forge» and «Aster
Bank», the wallet address `TQx7…9fK2` and every amount in the frames are invented fixtures; they carry no
real person or account. Amounts follow `formatMoney` (`<amount> <CODE>`, NBSP grouping, decimal comma,
U+2212 minus) and the sign rule in `## Assumptions`.

### 2.7 Data and cache contract (R1-02)

Three independent queries; each block renders and fails alone.

| Block                 | Query key               | `staleTime`                  | `retry` | Refetch triggers                                                 | Notes                                                                   |
| --------------------- | ----------------------- | ---------------------------- | ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Partners, chart, KPIs | `['finance-summary']`   | 60 s (client default)        | 1       | mount after stale, manual «Повторити», reconnect                 | One payload feeds the partner card, the chart, the table and all 8 KPIs |
| Company account       | `['company-account']`   | 60 s (client default)        | 1       | mount after stale, manual «Повторити», wallet change invalidates | A wallet change in the admin area invalidates it                        |
| Income control        | `['income-compliance']` | 60 s (explicit in the query) | 1       | mount after stale, manual «Повторити», reconnect                 | Explicit `staleTime: 60_000` today                                      |

- Client defaults (`apps/web/app/lib/query-client.ts`): `staleTime` 60 s, `gcTime` 24 h with the persisted
  cache, `retry: 1`, `refetchOnWindowFocus: false`. Returning to the tab does **not** refetch.
- **Period, series and month are client-side** over `summary.monthly`: no request, no loading state, no
  skeleton. The E2E test `breakpoint change does not refetch` asserts 0 new requests across 375 → 1440 (§6). They live in the URL (`period`, `series`, `month`, M2).
- **States by cache** (M6):
  - _No data and loading_ → skeletons (`loading-*`).
  - _No data and failed (online)_ → the error card (`error-*`), block-level for company and compliance
    (`partial-*`).
  - _No data and offline_ (`fetchStatus === 'paused'`, R2-M4) → the cold-offline card (`cold-375`): strip
    «Немає з’єднання», card «Немає з’єднання» with «Збережених даних ще немає…», each block with its own
    disabled «Повторити»; the paused queries resume by themselves on reconnect.
  - _Data and a refetch is running_ → data stays; no skeleton, no spinner over the data.
  - _Data and the refetch failed (online)_ → data stays; the status strip «Не вдалося оновити · станом на
    HH:MM» with «Повторити» (`stale-375`, `stale-1440`).
  - _Data and offline_ → data stays; the strip «Немає з’єднання · показано дані станом на HH:MM» under the top
    bar (`offline-375`, `offline-1440`); no inline line (the strip replaces it); the queries retry on
    reconnect.
  - HH:MM is the local time of the query's `dataUpdatedAt`.
- The date `11 лист.` in the status bar and «листопад 2026» in compliance come from the fixture "now"
  (2026-11-11 for the status bar, November 2026 for the month under review).

## 3. Mockups

`design-gate: degraded` — Claude Design has no headless path; these are HTML prototypes on the foundation
tokens, rendered by `assets/src/render.mjs` (`node render.mjs [filter]`, the filter is a substring) into
`assets/stats/`. Fidelity references: `default-320.png` and `default-1440.png` stand in for the `design.png`
pair that `responsive-design` requires (phone 320, desktop 1440); `default-375.png` is the everyday phone
reference. Phone and tablet frames render at 2×; desktop frames at 1×. Frames that show a whole page are
cropped to the content bottom (`fit`), the others are fixed viewports.

59 frames (phone 32, tablet 10, desktop 17):

| Frame                                                          | Width(s)  | Shows                                                                                                                                            |
| -------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default-320`, `default-375`                                   | 320, 375  | Main state, first viewport (FAB hidden by the screen rule)                                                                                       |
| `full-320`, `full-375`                                         | 320, 375  | Main state, the whole scroll (FAB in the clearance below the last block)                                                                         |
| `all-320`, `all-375`                                           | 320, 375  | «Усе»: 20 months in the strip, newest at the right edge                                                                                          |
| `scrub-12m-375`                                                | 375       | 12 months in fit mode, selected August (a non-tick month), scrub line and dot at plot top                                                        |
| `loading-320`, `loading-375`                                   | 320, 375  | Placeholders only in final phone geometry: no data text, no chromatic fill (R3-M15)                                                              |
| `empty-375`                                                    | 375       | No finance data (zero balances, empty chart with «Нова транзакція», no compliance receivers)                                                     |
| `error-320`, `error-375`                                       | 320, 375  | Finance summary failed, no cache                                                                                                                 |
| `partial-375`                                                  | 375       | Company account and compliance failed, summary fine                                                                                              |
| `stale-375`                                                    | 375       | Cached data, refetch failed: sticky status strip «Не вдалося оновити · станом на 14:32»                                                          |
| `stale-yesterday-375`                                          | 375       | Same strip, oldest cached block from an earlier day: dated stamp «10.11 о 14:32»                                                                 |
| `stale-yesterday-320`                                          | 320       | Same dated strip below 360 px: one 44 px row, icon-only retry, stamp unclipped (R3-02)                                                           |
| `stale-scrolled-375`                                           | 375       | Page scrolled 520 px: the strip stays under the top bar                                                                                          |
| `retry-busy-375`                                               | 375       | «Повторити» pressed: spinner, `aria-busy`, 70 % opacity                                                                                          |
| `offline-375`                                                  | 375       | Cached data, offline: strip under the top bar                                                                                                    |
| `cold-375`                                                     | 375       | Cold offline: no cache, strip «Немає з’єднання», card «Немає з’єднання», disabled «Повторити»; company row and compliance name the cause (R3-11) |
| `nowallet-375`                                                 | 375       | Company wallet not set up: balance kept, ADMIN button «Налаштувати гаманець» (R3-M17)                                                            |
| `balanced-375`                                                 | 375       | Evening-out amount `<= 0.01`                                                                                                                     |
| `onepartner-375`                                               | 375       | Defensive data state: one balance (M4)                                                                                                           |
| `long-320`, `long-375`                                         | 320, 375  | Long partner name, negative balance                                                                                                              |
| `accountant-375`                                               | 375       | ACCOUNTANT, no wallet: balance kept, text only                                                                                                   |
| `series-sheet-375`, `month-sheet-375`                          | 375       | Series sheet; month sheet with ‹ › (› disabled on the newest month) and drill-down row                                                           |
| `hint-sheet-375`, `hint-partner-375`                           | 375       | Hint sheets at content height                                                                                                                    |
| `compliance-expanded-375`                                      | 375       | Receiver row expanded                                                                                                                            |
| `compliance-variants-375`                                      | 375       | Every income-control status: accrued, pending, in progress, no incomes, open project rows (R3-06)                                                |
| `hint-popover-768`                                             | 768       | Tablet hint popover anchored to the partner card, card-wide, ends above the series control (non-modal, no scrim, R3-15, R4-04)                   |
| `all-768`                                                      | 768       | «Усе» on a tablet: 20 months, month table with no inner scroller (R3-M19)                                                                        |
| `default-768`, `default-1000`                                  | 768, 1000 | Tablet, main state; 1000 is the widest tablet width before the desktop shell (4 KPI columns)                                                     |
| `select-768`, `select-1000`                                    | 768, 1000 | Tablet interaction: 12 months, a month selected, docked readout and month table                                                                  |
| `error-768`, `long-768`, `loading-768`                         | 768       | Tablet states                                                                                                                                    |
| `stale-768`                                                    | 768       | Tablet stale strip: sticky under the title row, inside the 20 px pane gutters, split «Повторити» (R4-03)                                         |
| `default-1024`, `default-1280`, `default-1440`, `default-1920` | 1024–1920 | Desktop main state; 1920 shows the 1280 content cap                                                                                              |
| `touch-1024`                                                   | 1024      | Coarse pointer at a wide width: one column, 44 px controls (M7)                                                                                  |
| `all-1280`                                                     | 1280      | «Усе», month table capped at 8 rows with inner scroll (fine pointer)                                                                             |
| `hover-1440`                                                   | 1440      | Fine pointer hover: light highlight, readout and «Наведено: <month>» caption (R2-M9, R3-M22)                                                     |
| `compliance-variants-1440`                                     | 1440      | Every income-control status on desktop (R3-06)                                                                                                   |
| `loading-1440`, `empty-1440`, `error-1440`, `partial-1440`     | 1440      | Desktop states                                                                                                                                   |
| `stale-1440`, `offline-1440`                                   | 1440      | Stale strip; offline strip over cached data (above the first block)                                                                              |
| `balanced-1440`, `long-1440`                                   | 1440      | Balanced; long name and negative balance                                                                                                         |
| `accountant-1440`                                              | 1440      | ACCOUNTANT navigation at full sidebar height, no wallet                                                                                          |

There is no `threepartners-375` frame: the owner decided on 2026-11-17 that the company has exactly two
partners. `month-sheet-375` draws the drill-down row «Транзакції за листопад 2026» as the shipped state (M1); the
destination depends on Task 1.2 (Open point 1).

Baseline captures of today's screen and the network baseline: **pending** (no running stack in this pass).

## 4. Self-score (rubric)

Criterion 4 (Forms) does not apply (no inputs) and is dropped; weights renormalise over 90. Scores are my
own reading of `docs/design/rubric-calibration.md` against the frames; the council scores independently.
A 9.5 means "as 10, with one named gap", so each 9.5 below names the gap. Nothing is scored 10.

| Criterion (weight)       | Phone    | Tablet   | Desktop  | The one gap that keeps it at 9.5                                                                                                                                                                                                                                                                           |
| ------------------------ | -------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Time-to-task (15)      | 9.5      | 9.5      | 9.5      | At 320 × 568 the chart is one short scroll below the first viewport (R2-25 decision); with a strip showing, the 44 px strip pushes the first block 52 px lower and the 6-month plot is cut by the tab bar at 375 (one short scroll, R3-03); on tablet and desktop both owner answers are in the first view |
| 2 Never blocks (15)      | 9.5      | 9.5      | 9.5      | Cold offline cannot show data that does not exist; it shows the named state and resumes by itself (`cold-375`). Everything else keeps cached data on screen                                                                                                                                                |
| 3 Navigation (10)        | 9.5      | 9.5      | 9.5      | The drill-down row needs the finance-list month filter (Task 1.2, Open point 1); until then it stays hidden in the build                                                                                                                                                                                   |
| 5 Lists and tables (10)  | 9.5      | 9.5      | 9.5      | The month table is not sortable. On a fine pointer it is capped with an inner scroll (`all-1280`); on a coarse pointer it has no inner scroller and «Усе» lists 20 rows in the page scroll (R3-M19, `all-768`; open point 26). `measure.mjs` finds no clipped cell at 768, 1000, 1024, 1280 and 1440       |
| 6 Sheets, gestures (8)   | 9.5      | 9.5      | 9.5      | Tablet: the card-wide hint popover leaves the partner rows, the series control, the readout and the plot in view (measured), but while open it covers the chart card's heading row with the period control (`hint-popover-768`); nearest anchor «one … panel width is slightly off for its content»        |
| 7 System states (10)     | 9.5      | 9.5      | 9.5      | Mixed cache cases are ruled in §2.2.1 rather than each drawn; the strip (also at 320, `stale-yesterday-320`), busy retry, cold offline and per-block errors are drawn                                                                                                                                      |
| 8 Data visualisation (7) | 9.5      | 9.5      | 9.5      | No period swipe on the phone (the segmented control is the only way; open point 25); the 12-month phone plot has 24.1 px bands, relieved by 44 px ‹ › (measured, §2.5)                                                                                                                                     |
| 9 Platform fit (8)       | 9.5      | 9.5      | 9.5      | Tablet: rotation from 768 to 1024 changes the shell (rail to sidebar); the foundation sidebar defects are Open points 18 to 20                                                                                                                                                                             |
| 10 Accessibility (7)     | 9.5      | 9.5      | 9.5      | Target sizes, per-node text contrast and non-text contrast (3 : 1) are measured by `measure.mjs` over every frame (§2.5); no real screen-reader run                                                                                                                                                        |
| **Weighted (÷ 90)**      | **9.50** | **9.50** | **9.50** |                                                                                                                                                                                                                                                                                                            |

**Rubric anchors quoted for the two criteria the council held at 9.0 on tablet.**

- _Criterion 9, Platform fit, tablet (9.5):_ the anchor row reads «9.5 — As 10; one minor fit issue (a scroll
  bounce reveals the canvas colour, one frame jumps on rotation).» The evidence is `default-768`,
  `default-1000` and `select-1000` (the 900–1023 range is drawn, R2-M2) plus `touch-1024` for the width above.
  The one remaining issue is the shell change on rotation from 768 to 1024. The anchor for 10 also asks
  «D: works 1024–2560 px, no stretched line length»; `default-1920` shows the 1280 cap and no frame shows
  2560, which is why this is not 10.
- _Criterion 6, Sheets, panels, gestures, tablet (9.5):_ the anchor row reads «9.5 — As 10; one detent
  height or panel width is slightly off for its content.» The 9 row is «Containers right; drag-to-dismiss
  missing on one sheet, or one sheet lacks a button alternative to the drag.» Every tablet container is now
  drawn or is a segmented control: the series control is segmented (R2-M1), the hint is the popover in
  `hint-popover-768` (closes with Esc and the info button), the month readout is docked with ‹ ›. The
  popover's reach is the one thing that is slightly off: it covers the period control while open.

- _Anchors for the 9.5 rows in this table (rubric text, quoted)._ Criterion 1: «As 10, but one avoidable step
  remains (one default the user must still set, or one extra confirm)» — the remaining step is the short
  scroll to the plot at 320 and with a strip. Criterion 5: «As 10; one secondary affordance missing (no bulk
  select where it would help, or one column not sortable)» — the month table has no sort. Criterion 7: «As 10;
  one state is plain (an empty state without its action, or a success toast without its next step)» — the
  mixed cache cases are rules, not frames. Criterion 8: «As 10; one drill-down path is weaker (tooltip but no
  keyboard access, or no period swipe)» — no period swipe on the phone. Criterion 10: «As 10; one decorative
  icon with a redundant label, or one reduced-motion variant is a crossfade where a cut would be calmer» — no
  screen-reader run.

**Weakest criteria (honest):** criterion 10, because no static mockup proves screen-reader behaviour; the
text and non-text contrast passes in `measure.mjs` cover every frame (R4-06), the screen reader does not.
Next: criterion 1 at 320 × 568 and under a status strip (the strip's 52 px is the
price of the staleness cue), and criterion 8 on the 12-month phone plot.

## 5. Open points

1. **Month → transactions link — closed, ship (M1).** Depends on Task 1.2: the finance list accepts a month
   filter as a URL search param. Until it lands the row stays hidden in the build, not in the design.
2. **«Інші розділи» placeholders — closed, removed (M3).** The owner may veto at the owner look.
3. **One partner — closed (M4).** One balance: that balance row only, no evening-out amount, never
   «Баланси вирівняно». A defensive data state (`onepartner-375`).
4. **Three or more partners — closed, owner decision 2026-11-17: exactly two partners.** The defensive
   fallback line is in `## Assumptions`; no frame, no scalable N-partner list.
5. **USDT label on a USD figure — closed, keep USDT.** The evening-out amount is computed from USD
   balances and paid in USDT (pegged 1:1 server-side). The partner hint says so in one sentence.
6. **ACCOUNTANT desktop frame — closed.** `accountant-1440` draws the ACCOUNTANT navigation (no «Адмін»
   group) from this screen's source; the foundation helper is untouched.
7. **Month table on tablet and desktop — closed, keep (A1).** It is the accessible equivalent of the chart;
   the owner may veto. On a fine pointer it is capped at 12 rows (8 on the two-column layout) with an inner
   scroll; on a coarse pointer (tablet, phone) there is no inner scroller and the rows sit in the page scroll
   (`all-768`, R3-M19).
8. **FAB over the chart (shell, M8).** While the chart card intersects the FAB zone the FAB should fade out
   (150 ms) and return after. The first-viewport frames draw it hidden; the foundation shell needs a
   per-screen "avoid" hook. _Recommendation:_ add it to the shell (primitives-v2 already hides the FAB in
   its 320 chart frame).
9. **Offline strip position and copy (shell, M8, R2-24).** The foundation's offline banner (shell-v2) also
   sits under the top bar, in a slot shared with the session banner; the session banner has priority, so
   the offline strip and the session banner never stack. This screen's strip uses the same position but
   carries its own copy («Немає з’єднання» / «показано дані станом на …», the shell wording) and the cache
   stamp, and is sticky on phone and tablet. The retry label «Повторити» differs from the shell's «Спробувати
   ще» on purpose (R2-24 decision). _Recommendation:_ the shell takes a per-screen message and a stamp.
10. **Chart library feasibility.** Hatch needs a custom bar shape with an SVG `<pattern>`; scrub and roving
    focus need pointer and key handling on the plot group. recharts `^3.10.1` supports the hatch via a
    `shape` prop; the other two need a small overlay. _Recommendation:_ prototype in Task 4.1 before the
    coder commits; the fallback is a hand-written SVG plot (the mockup is already one).
11. **Docked readout instead of a floating tooltip (deviation).** The selected or hovered month is shown in a
    readout above the plot, so nothing covers a neighbouring bar (R1-14). It replaces the primitives §6
    "tooltip beside the bar". _Recommendation:_ accept; record it in primitives-v2 if the owner agrees.
12. **`Partner` term in `CONTEXT.md`.** The screen says "partner" for an ADMIN user's balance; `CONTEXT.md`
    has no such term, and the first mockup's word for the evening-out amount was an `_Avoid_` candidate.
    _Recommendation:_ add "Partner" and "Evening-out amount" to `CONTEXT.md` in a docs PR (not this one).
13. **Content width cap.** The desktop content column is capped at 1280 px and centred; the foundation
    helper left-aligns it. `default-1920` shows the centred cap. _Recommendation:_ the coder uses
    `mx-auto max-w-[1280px]`.
14. **Roving focus on the plot (deviation from primitives §6).** One tab stop with Left / Right / Home / End
    instead of per-bar tab stops; the month table gives direct access to every month. _Recommendation:_
    accept; verify with a real screen reader during the build.
15. **Tablet width range 900–1023 — closed (R2-M2).** `default-1000` and `select-1000` draw the single-pane
    range from this screen's source (the 899 px shell with the width rewritten); the rule beside them is in
    §2.1 Tablet. _Recommendation:_ the shell `tablet()` helper gains a "single pane" option, so the rewrite
    is not needed.
16. **Left column sticky on two-column desktop.** With a long month table the left column follows with
    `position: sticky; top: 16px`; the mockup shows the 8-row state, where about 120 px of the left column
    is empty. _Recommendation:_ accept; the coder implements sticky.
17. **Baseline captures pending.** Today's screen and the network baseline are not captured (no running
    stack). _Recommendation:_ manual-qa captures them before the coder starts.
18. **Foundation sidebar rows lose their coarse-pointer density (shell, R2-M12).** The nav rows carry two
    `class` attributes, so the second (`srow`) is ignored and `.touch .srow` never applies: the rows stay on a
    36 px pitch. This screen's `touch-1024` merges the attributes in its own source to show the shell's 44 px
    rule. _Recommendation:_ fix the markup in the shell; no per-screen change is then needed. Round 4 adds
    one symptom of the same shell density: at 44 px rows and 14 px text the label «Черга зовнішніх
    вакансій» is truncated in `touch-1024` («Черга зовнішніх вакан…»). A foundation defect; the shell
    decides wrap or a shorter label with 18, 19 and 23. No change in this screen (R4, S5).
19. **Sidebar search is a fixed 36 px (shell, R2-M12).** The shell's own coarse-pointer rule gives the search
    field 48 px, but the sidebar markup hard-codes 36 px. `touch-1024` draws 48 px at 14 px text.
    _Recommendation:_ the shell applies its density rule to the sidebar search. The truncated nav label in
    `touch-1024` (open point 18, round 4) belongs to the same fix.
20. **Sidebar chip is hard-coded to the ADMIN person (shell, R2-12).** The chip always reads the ADMIN name
    and role. This screen's `withRole` swaps it for the drawn role (`accountant-1440` shows an accountant).
    _Recommendation:_ the shell chip takes the signed-in user.
21. **Project rows and KPI cards have no drill-down (R3-M24).** The compliance project rows and the KPI cards
    do not open the finance list; only the month drill-down (M1) does. Which list a KPI should open is a
    product decision. _Recommendation:_ decide with the finance-list spec (PR #1393); no change here.
22. **The 44 px ‹ › stepper as the sanctioned alternative to drag-scrub (foundation, R3-M24).** For strip
    bands under 44 px the stepper and the month table are the single-pointer alternative to scrubbing.
    _Recommendation:_ the foundation names this explicitly in `primitives-v2.md`.
23. **Sidebar search text size (foundation, R3-M24).** The sidebar search text is 13 px, 14 px in this
    screen's `touch-1024`. _Recommendation:_ the shell uses 16 px with open points 18 and 19, and sizes the
    nav labels so «Черга зовнішніх вакансій» is not truncated at a coarse pointer (round 4, S5).
24. **The RBAC matrix has no Stats row (R3-M24).** `.claude/agents/project-state.md` lists no row for
    `/stats` (ADMIN and ACCOUNTANT). _Recommendation:_ Master opens a docs PR; this PR does not touch it.
25. **Period swipe on the readout row (OP-25, round 4).** A horizontal swipe on the phone readout row could
    step the period or the month. It is a new gesture with no precedent in the foundation, and it competes
    with the page scroll and the plot scrub. _Recommendation:_ a product decision, outside this redesign;
    the segmented control and the 44 px ‹ › stay the paths.
26. **Month table length on tablet (OP-26, round 4).** On a coarse pointer «Усе» lists 20 rows in the page
    scroll (R3-M19 stands: no inner scroller). _Recommendation (fable):_ show 12 rows and an in-flow
    «Показати всі N» row that expands the table in place; an owner or product decision, no change here.
27. **Sticky stale strip and the 6-month plot (OP-27, round 4).** With the strip showing, the sticky 44 px
    strip and the tab bar cut the 6-month plot at 375 (`stale-375`; the cost accepted in R2-25 and R3-M16).
    _Options:_ the strip collapses to its icon once the page scrolls, or it stops being sticky. A product
    decision; no change here.

## Components (mapping to our stack)

| Visual block                               | Our component (shadcn/ui / composite)                                                                                                                                | New?                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Partner balance card (evening-out first)   | `ui/card.tsx` + share bars (plain elements)                                                                                                                          | restyle of `CompanyAndPartnersCard` |
| Monthly chart                              | the existing chart library (recharts) on `--chart-*` (primitives-v2 §6)                                                                                              | restyle                             |
| Period control (6 міс · 12 міс · Усе)      | `ui/segmented-toggle.tsx` (44 px on touch, 26 px items on a fine pointer)                                                                                            | restyle                             |
| Series picker                              | pill button → PickerSheet on phone; segmented control (`ui/segmented-toggle.tsx`) on tablet and desktop, no popover (R2-M1)                                          | uses foundation PickerSheet         |
| Readout and ‹ › stepper                    | plain elements, `aria-live="polite"`                                                                                                                                 | NEW (small)                         |
| Month sheet                                | bottom sheet (content-height detent) + `ListRow`                                                                                                                     | uses foundation Sheet               |
| Hint (KPI, partners, company)              | bottom sheet on phone, `ui/popover.tsx` on tablet, `ui/tooltip.tsx` on desktop (fine)                                                                                | uses foundation Sheet               |
| Company account card / row                 | `ui/card.tsx`; inline error with `ui/alert.tsx` semantics and a Retry button                                                                                         | restyle                             |
| KPI list (phone) / tiles (tablet, desktop) | `ListSection` + `ListRow`; tiles on `ui/card.tsx`                                                                                                                    | uses foundation List row            |
| Month table                                | `ui/table.tsx` (real `<table>`, rows `role="link"`)                                                                                                                  | NEW block (A1), existing component  |
| «Контроль доходів»                         | today's `IncomeComplianceSection`; rows as `ListRow`; status pills on `ui/badge.tsx`                                                                                 | restyle                             |
| Status strip (stale / offline / cold)      | one `ui/alert.tsx`-based strip per page (`role="status"`), sticky on phone and tablet, oldest cache stamp, Retry button with busy and disabled states (R2-M3, R2-M4) | NEW (small)                         |
| Skeletons                                  | `ui/skeleton.tsx` in final geometry per class                                                                                                                        | restyle                             |

## Token-map

Only tokens from `apps/web/app/styles/globals.css`, as the foundation mirrors them.

| Use                                          | Token                                                   |
| -------------------------------------------- | ------------------------------------------------------- |
| Card, sheet background                       | `--card`, `--raised` (sheet), `--surface` (page, tiles) |
| Sender share bar, profit bars, selected mark | `--chart-1`                                             |
| Receiver share bar                           | `--chart-2`                                             |
| Chart gridlines, zero line                   | `--chart-grid`                                          |
| Selected-bar outline, scrub line             | `--fg`                                                  |
| Positive trend, «Усі отримано»               | `--positive`                                            |
| Loss readout, negative balance, error text   | `--destructive`                                         |
| Offline strip icon                           | `--warning`                                             |
| Captions, units, sub-lines                   | `--muted-fg`                                            |
| Card / sheet radius; inner rows and bars     | `--r-xl` / `--r-lg`                                     |

## 6. For the coder

- Build with our components (Card, segmented control and sheet primitives from `primitives-v2.md`,
  foundation shell). The PNGs are the fidelity reference; do not copy the generator HTML.
- Tokens only (table above). No hex colours in the chart.
- Money through `formatMoney` everywhere (removes `$` and en-US grouping); bar labels in thousands with
  the «тис. USD» caption; the sign rule in `## Assumptions`.
- Keep `StatsPage` role gating. Every testid on today's screen, kept or removed (R4-10):
  - **Kept:** `stats-page-admin`, `stats-page-accountant`, `stats-company-account-balance`,
    `stats-partner-balances`, `income-compliance-section`, `income-compliance-error`,
    `income-compliance-retry`, `compliance-list`, `compliance-row-${userId}`, `compliance-detail-${userId}`,
    `compliance-project-status-${projectId}` (now on the status pill of the open project row).
  - **Kept, narrower:** `compliance-toggle-${userId}` sits only on a row with open projects, the one
    disclosure. A complete row is not a button (R4-01), so it carries `compliance-row-${userId}` and no
    toggle; a test that clicked the toggle of a complete row asserts the absence of the toggle instead.
  - **Removed, with the replacement:** `stats-finance-section` (today's wrapper of the summary blocks; the
    blocks are independent now, R2-M7) is replaced by `stats-partner-balances` (kept), `stats-chart` and
    `stats-kpis` (new, on the chart block and the KPI block). `stats-company-partners-card` (today's combined
    card; the company account is its own block, R2-M7) is replaced by `stats-company-account` (new, on the
    company account block) next to `stats-partner-balances`; the E2E `phase8-payout-company.spec.ts`, which
    asserts the card for ADMIN and its absence for JUNIOR, moves to `stats-company-account`.
    `compliance-project-dot-${projectId}` (the coloured dot) goes away with the dot: the status pill
    `compliance-project-status-${projectId}` carries the status as text. `finance-chart-swatch` (the legend
    swatch of `FinanceChart`) goes away with the legend: the series control replaces it, and the colour
    is the `--chart-1` token, so the swatch colour unit test is deleted, not ported.
    `stats-placeholders-section` goes away with the «Інші розділи» block (M3).
  - **Test-only, unaffected:** `chart-month-count` and `finance-chart-stub` live in `stats.test.tsx` stubs.
- Evening-out logic unchanged (richest vs poorest, `|rich − poor| / 2`, `<= 0.01` → balanced); the one-partner
  and three-or-more rules are in `## Assumptions` (M4 and the fallback line).
- KPIs and the compliance tiles are derived from `summary.monthly` and the compliance payload (§2.7); do
  not hard-code figures.
- One component per block, rendered once; the layout switches through CSS and container queries, not
  dual-mount. The pointer media query, not the width, decides touch behaviour (M7).
- URL search params `period`, `series`, `month` (M2) via TanStack Router's validated search.
- **Lift `['company-account']` into its own block (R2-M7).** Today it is fetched inside
  `CompanyAndPartnersCard`, which `stats.tsx` mounts only after `summary` exists; the three queries must be
  independent, so the company balance can show when the summary fails.
- **One status strip per page (R2-M3, R2-M4).** Its stamp is the oldest `dataUpdatedAt` of the blocks that
  show cached data, dated when it is not today («10.11 о 14:32»). A block with no cache shows its own error
  card; a query with no data and `fetchStatus === 'paused'` is cold offline, not loading. Retry shows a busy
  state (`aria-busy`, no second tap) and is `aria-disabled` while offline.
- **Month bucket rule (R2-M8).** `month=YYYY-MM` buckets by the Kyiv business month of the paid
  transaction's `txDate`, the same rule as `summary.monthly` (`transactionBusinessMonth`); the finance list
  (PR #1393) must use the same function.
- **Marker rules (R2-M9) and units.** Outline = selected month; hover only highlights and updates the
  readout; the dashed line and dot appear only while a drag scrubs in fit mode, never in strip mode. The
  y axis starts one nice step below the lowest value. Percent values read `{percent} %` with a space.
- **Selected row in view (R2-23).** When the month table scrolls inside a card, selecting a month scrolls its
  row into view.
- **Reproduce the measurements.** `assets/src/measure.mjs` is a gate that exits non-zero: it regenerates the
  loading block bounds, the target sizes, the status strip and sheet close controls, the month table fit, the
  loading no-data check, the per-node text and non-text contrast over every frame, the receiver-row and
  pending-tile checks, the tablet popover position, the plot band widths (§2.5) and the string gate (§2.6);
  run it again after any layout or string change.
- **E2E, from the program plan (R3-20).** The stats E2E spec carries the two plan-required tests beyond its
  flows: `no duplicate requests on load and primary action` (`expectNoDuplicates`) and `breakpoint change
does not refetch` (375 → 1440, 0 new API requests); the second also covers period, series and month
  changes, which are client-side (§2.7).
- design-fidelity-review (mockup ↔ localhost at 320, 375, 768, 1024, 1440) before merge.

## Round 1 findings

Council round 1 scored phone / tablet / desktop 9.2 / 9.2 / 9.1, 9.3 / 9.3 / 9.4 and 8.9 / 8.8 / 9.0 (three
members). Each finding below is mapped to the spec section and the frames that carry the fix. Master
decisions M1–M8 and the owner decision of 2026-11-17 are in `## Assumptions`.

| Finding | What changed                                                                                                                                                                                                                                        | Where                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| R1-01   | Real tablet design instead of a stretched phone: wide partner card, chart with controls, docked readout and month table, 2-column KPI tiles. Added `error-768`, `long-768`, `select-768`, `loading-768`; a rule line covers the other tablet states | §2.1 Tablet, §2.2.1; `default-768`, `select-768`, `error-768`, `long-768`, `loading-768` |
| R1-02   | Stale, refetch-failed, offline-with-cache and cold-offline separated; `staleTime` / `retry` / refetch triggers listed per query key                                                                                                                 | §2.2, §2.7, M6; `stale-375`, `stale-1440`, `offline-375`, `offline-1440`, `cold-375`     |
| R1-03   | Drill-down from the month sheet and the month-table rows to the finance list filtered by month                                                                                                                                                      | M1, §2.4; `month-sheet-375`, `select-768`, `default-1440`                                |
| R1-04   | Receiver rows use today's role labels (Адмін-сеньйор, Сеньйор, Дроп) and ICU plurals on every class                                                                                                                                                 | §2.6 Income control; every compliance block, `compliance-expanded-375`                   |
| R1-05   | The chart has an accessible equivalent on every class: a real `<table>` (phone: sr-only, wide: visible), a summary sentence in the group label, roving focus with arrow keys, Home / End; deviation recorded                                        | §2.5, Open point 14; `select-768`, `default-1440`                                        |
| R1-06   | Satisfied by the M4 rule, the `onepartner-375` frame and the three-or-more fallback line. The `threepartners-375` frame was dropped by owner decision (exactly two partners, 2026-11-17)                                                            | `## Assumptions` (M4, fallback), Open points 3–4; `onepartner-375`                       |
| R1-07   | One gesture per axis: vertical is page scroll, horizontal scrubs in fit mode and scrolls in strip mode; tap selects; ‹ › and keys are the alternative                                                                                               | §2.4 Gestures; `all-375`, `scrub-12m-375`                                                |
| R1-08   | Coarse pointer at ≥ 1024 gets the one-column layout with 44 px controls                                                                                                                                                                             | M7, §2.1 Desktop; `touch-1024`                                                           |
| R1-09   | FAB never covers the newest bar, ‹ › or «Разом»: first-viewport frames draw it hidden by the screen rule; the full-scroll frames draw it in the clearance                                                                                           | §2.1 FAB rule, Open point 8; `default-*`, `full-*`                                       |
| R1-10   | Complete `uk` + `en` strings table for every visible string and `aria-label` in every frame, grouped by block                                                                                                                                       | §2.6                                                                                     |
| R1-11   | Period, series and month in URL search params                                                                                                                                                                                                       | M2, §2.4, §6                                                                             |
| R1-12   | Full list of changes against today; the false claim that today divides by a zero total is deleted (today's behaviour is "share —, bars at 2 %")                                                                                                     | `## Assumptions` "Changes against today", §1.2                                           |
| R1-13   | `accountant-1440` draws the ACCOUNTANT navigation at full sidebar height                                                                                                                                                                            | §2.3; `accountant-1440`                                                                  |
| R1-14   | Docked readout above the plot; no tooltip over neighbouring bars                                                                                                                                                                                    | §2.1 Desktop, Open point 11; `hover-1440`, `default-1440`                                |
| R1-15   | 12-month phone plot: labels thinned so none overlap, scrub dot at the plot top, the frame shows a non-tick month (August)                                                                                                                           | §2 plot rules; `scrub-12m-375`                                                           |
| R1-16   | Offline stamp «показано дані станом на 14:32», screen-specific copy, strip directly under the top bar                                                                                                                                               | §2.2, §2.7, Open point 9; `offline-375`, `offline-1440`, `cold-375`                      |
| R1-17   | Skeletons in the final geometry of each class                                                                                                                                                                                                       | §2.2; `loading-320`, `loading-375`, `loading-768`, `loading-1440`                        |
| R1-18   | Matrix gaps filled and a State × class matrix added                                                                                                                                                                                                 | §2.2.1                                                                                   |
| R1-19   | Components table contradictions resolved (one control per class; «Інші розділи» row removed)                                                                                                                                                        | Components                                                                               |
| R1-20   | No empty area under the company card at 1280 / 1440: chart 330 px tall, month table capped at 8 rows with inner scroll, sticky left column, content capped at 1280 px                                                                               | §2.1 Desktop, Open points 13 and 16; `default-1280`, `all-1280`, `default-1920`          |
| R1-21   | KPIs derived from the series; one sign rule for the whole screen                                                                                                                                                                                    | `## Assumptions` (A1 sign and derived lines), §2.7                                       |
| R1-22   | Phone 320 details: 12 px margins, stacked controls, taller plot, compact readout, name wrapping                                                                                                                                                     | §2.1 Phone; `default-320`, `full-320`, `all-320`, `error-320`, `loading-320`, `long-320` |
| R1-23   | Month sheet ‹ › with a disabled › on the newest month; hint sheets at content-height detent                                                                                                                                                         | §2.4; `month-sheet-375`, `hint-sheet-375`, `hint-partner-375`                            |
| R1-24   | ADMIN «Налаштувати гаманець»; the empty chart points to «Нова транзакція»                                                                                                                                                                           | §2.3, §2.2; `nowallet-375`, `empty-375`, `empty-1440`                                    |
| R1-25   | Prose says "evening-out amount" everywhere; the earlier wording that implied a loan between partners is gone. Open point 12 proposes adding "Partner" and "Evening-out amount" to `CONTEXT.md`                                                      | whole spec, Open point 12                                                                |

## Round 2 findings

Council round 2 scored phone / tablet / desktop 9.4 / 9.4 / 9.4 (sonnet), 9.4 / 9.4 / 9.4 (opus) and
9.5 / 9.4 / 9.4 (fable) against a gate of 9.5. Each finding below is mapped to what changed and the proof
frame or section. Master decisions R2-M1..R2-M14 are in `## Assumptions`. One new frame was added beyond
the findings, `hint-popover-768`, to draw the tablet hint container instead of leaving it as a rule.

| Finding | What changed                                                                                                                                                                                                                                   | Proof                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R2-01   | Tablet 900–1023 drawn: single-pane frames at 1000 px built from this screen's source; the rule states KPI columns (4), progress bar and plot width, table placement. Open point 15 closed.                                                     | `default-1000`, `select-1000`; §2.1 Tablet                                    |
| R2-02   | The series control is segmented on tablet and desktop in the state matrix, §2.4 and the Components table; the pill is phone only.                                                                                                              | §2.2.1, §2.4, Components; `default-768`                                       |
| R2-03   | Every `loading-*` frame is the default frame's own DOM as placeholders, so every block is present (partner footer, compliance on all classes). Measured block delta 0 px at 375, 320, 768 and 1440 (limit 8 px); per-block loading rule added. | `loading-320`, `-375`, `-768`, `-1440`; §2.2, §2.5 (`measure.mjs`)            |
| R2-04   | The FAB is hidden while the screen is loading; the FAB rule says so.                                                                                                                                                                           | `loading-375`, `loading-320`; §2.1 Phone                                      |
| R2-05   | One status strip with the oldest stamp, dated when not today («10.11 о 14:32»); stamp `nowrap`; the strip uses the card margin on every class; mixed cases added to the matrix.                                                                | `stale-375`, `stale-yesterday-375`, `offline-375`, `stale-1440`; §2.2.1, §2.7 |
| R2-06   | The strip is sticky under the top bar on phone and tablet; scrolled figures keep the staleness cue.                                                                                                                                            | `stale-scrolled-375`; §2.1 Phone                                              |
| R2-07   | Cold offline is its own state (`fetchStatus === 'paused'`); retry is disabled with the reason in the strip, resumes on reconnect; the busy state is drawn once.                                                                                | `cold-375`, `retry-busy-375`; §2.2.1, §2.7                                    |
| R2-08   | Three independent queries recorded as a change against today, with a coder note to lift `['company-account']` into its own block.                                                                                                              | Changes against today, item 17 (`## Assumptions`); §6                         |
| R2-09   | One rule line for per-block loading (summary loaded, company or compliance still loading).                                                                                                                                                     | §2.2.1                                                                        |
| R2-10   | The month is the Kyiv business month of the paid transaction's `txDate`; the finance list filter `month=YYYY-MM` uses the same rule (dependency on PR #1393).                                                                                  | §2.4 Drill-down; §6                                                           |
| R2-11   | The partner hint gives the half-difference formula and 1 USDT = 1 USD, with one term for the partners (uk and en); Open point 5 matches.                                                                                                       | `hint-partner-375`, `hint-popover-768`; §2.6                                  |
| R2-12   | `withRole` swaps the sidebar chip for the drawn role (name and «Бухгалтер»); foundation untouched; the shell defect is Open point 20.                                                                                                          | `accountant-1440`; Open point 20                                              |
| R2-13   | The expanded receiver lists as many project rows as the counts say (derived from the fixture).                                                                                                                                                 | `compliance-expanded-375`                                                     |
| R2-14   | Hover is not selection: light highlight and readout only; outline, bold label and table highlight stay on the selected month; no label sits on the dashed line.                                                                                | `hover-1440`; §2.4                                                            |
| R2-15   | One marker rule for every bar count; the dashed line and dot appear only while a drag scrubs in fit mode; no dot in strip mode.                                                                                                                | `scrub-12m-375`, `all-375`, `all-1280`; §2.1, §2.4                            |
| R2-16   | The currency moved into the table caption («суми в USD»); no clipped cell at 768, 1000, 1024, 1280, 1440 (measured).                                                                                                                           | `default-1280`, `all-1280`; §2.5 (`measure.mjs`)                              |
| R2-17   | `touch-1024` renders the sidebar rows at the shell's 44 px and the search at 48 px by merging the duplicate `class` attribute in this screen's source; the shell defects are Open points 18 and 19.                                            | `touch-1024`; §2.5; Open points 18, 19                                        |
| R2-18   | The y axis minimum is one nice step below the lowest value (a −1,4 loss gives −2, not −5).                                                                                                                                                     | frames with a y axis, e.g. `default-375`, `hint-popover-768`; §2.1            |
| R2-19   | The strip snaps to a whole band; the leftmost label is complete; the strip hint sits inside the first viewport.                                                                                                                                | `all-375`, `all-320`                                                          |
| R2-20   | «Маржа: {percent} %» with the space, as every other percent.                                                                                                                                                                                   | §2.6 `stats.kpi.margin`; `default-375`                                        |
| R2-21   | Strings: plural «Баланси партнерів», «Разом» with two decimals (listed in "Changes against today"), «Різниці між балансами немає» instead of the debt wording, share note reworded.                                                            | §2.6; Changes against today, items 16 and 20; `balanced-375`                  |
| R2-22   | The name takes the full row width and the balance its own line. The left column ends about 50 px below the chart card in `long-1440`; accepted with a reason (sticky column).                                                                  | `long-1440`; `## Assumptions` (R2-22 decision)                                |
| R2-23   | Selecting a month scrolls its table row into view inside the capped table; one rule line.                                                                                                                                                      | `all-1280`; §2.4; §6                                                          |
| R2-24   | Open point 9 corrected (banner under the top bar, shared slot, session banner has priority). Shell wording «Немає з’єднання» used; the retry label «Повторити» kept, deviation recorded with its reason.                                       | Open point 9; `## Assumptions` (R2-24 decision); `offline-375`, `cold-375`    |
| R2-25   | Not fixed further, by decision: at 320 × 568 the card was compacted (name and balance share a row) and the chart is one short scroll away. Reason: the answer and two partner rows cannot shrink more without cutting content.                 | `default-320`; `## Assumptions` (R2-25 decision)                              |
| R2-26   | `assets/src/measure.mjs` is committed and named in §2.5; it reproduces the block bounds, target sizes and table fit. The earlier node-count and contrast figures that no script reproduced were withdrawn, not repeated.                       | §2.5; `assets/src/measure.mjs`                                                |

## Round 3 findings

Council round 3 (sonnet 9.4 / 9.5 / 9.5, opus 9.5 / 9.5 / 9.4, fable 9.6 / 9.6 / 9.7 on phone / tablet / desktop). Every
finding has a row; the proof column names a frame or a section. No figure changed in this round.

| Finding | What changed                                                                                                                                                                                                                                                                                                                              | Proof                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| R3-01   | The loading frames carry placeholders only: no fixture text, pill text, selected edge, loss legend or negative bar; bars are uniform (R3-M15).                                                                                                                                                                                            | `loading-375`, `loading-320`, `loading-768`, `loading-1440`; §2.5 loading row   |
| R3-02   | The 320 stale strip is drawn with a dated stamp and an icon-only retry that keeps its accessible name and a 44 px hit area.                                                                                                                                                                                                               | `stale-yesterday-320`; §2.1 Phone                                               |
| R3-03   | The strip is one 44 px row (48 px with its gap); the first-viewport cost is stated and measured (52 px lower at 375 and 320, 64 px at 1440) and accepted, with the plot cut by the tab bar at 375 and one short scroll to reach it.                                                                                                       | §2.1 Phone, §2.5 strip row, §4 criterion 1                                      |
| R3-04   | No wallet still shows the company balance, with the sub-line «Гаманець не налаштовано» (R3-M17); the ACCOUNTANT frames match.                                                                                                                                                                                                             | `nowallet-375`, `accountant-375`, `accountant-1440`; §2.2                       |
| R3-05   | The settlement sentence is «Надсилає: {rich}. Отримує: {poor}.» with no inflected name (R3-M20); key `stats.partners.settlementSr`.                                                                                                                                                                                                       | §2.5 Partner card, §2.6                                                         |
| R3-06   | The income-control statuses are kept and every variant is drawn (accrued, pending, in progress, no incomes, open project rows); strings and keys added.                                                                                                                                                                                   | `compliance-variants-375`, `compliance-variants-1440`; §2.6 Income control      |
| R3-07   | Tablet «Усе» is drawn: 20 months, no inner scroller on a coarse pointer, nothing clipped.                                                                                                                                                                                                                                                 | `all-768`; §2.5 month table row; Open point 7                                   |
| R3-08   | The stale lines are corrected: the `hover-1440` row, the month-sheet row and the frame count now match the frames and keys («Транзакції за листопад 2026», 58 frames), and the inline stale line is the strip.                                                                                                                            | §3; §2.4; §2.6                                                                  |
| R3-09   | The `error-*` frames are re-rendered from `stats.error.body` («Баланси партнерів, графік і показники зараз недоступні…»).                                                                                                                                                                                                                 | `error-320`, `error-375`, `error-768`, `error-1440`; §2.6                       |
| R3-10   | The KPI hints `stats.kpi.lastIncome.hint` and `stats.kpi.lastProfit.hint` use `{month} {year}` placeholders instead of a hard-coded month.                                                                                                                                                                                                | §2.6 Company account, KPIs, states                                              |
| R3-11   | Cold offline names the cause on the strip, the company row and compliance; key `stats.offlineCold` corrected, new keys `stats.company.offline` and `stats.compliance.offline` (uk and en).                                                                                                                                                | `cold-375`; §2.2, §2.6                                                          |
| R3-12   | The Changes list names the trend label «{percent} % за місяць», the dropped «Згодом: …» footnote sentence and the chevron on a complete receiver row, each with its reason (items 21 to 23).                                                                                                                                              | Changes list items 21–23                                                        |
| R3-13   | `measure.mjs` is a gate that exits non-zero and now covers the strip, sheet close controls, loading no-data and per-node contrast. Its loading-bounds check found a 16 px delta (the legend row collapsed); fixed in `flatBars` (a blank spacer keeps the row). Last line: `measure.mjs: 59 checks, 0 failed — all measured claims hold`. | §2.5; `assets/src/measure.mjs`                                                  |
| R3-14   | Hover names the hovered month in a caption («Наведено: <month>»); the stepper label, outline and table row stay on the selected month.                                                                                                                                                                                                    | `hover-1440`; §2.1 Desktop, §2.6 `stats.readout.*`                              |
| R3-15   | The tablet hint popover is anchored to the partner card instead of floating under the info button. It opens over the chart card's header and leaves the partner rows in view; the width is the named gap.                                                                                                                                 | `hint-popover-768`; §2.4, §4 criterion 6                                        |
| R3-16   | A hyphenated name breaks after the hyphen only.                                                                                                                                                                                                                                                                                           | `long-320`, `long-375`; §2.1 Phone                                              |
| R3-17   | The sheet close controls are 44 × 44 px boxes, measured.                                                                                                                                                                                                                                                                                  | `series-sheet-375`, `month-sheet-375`, `hint-sheet-375`; §2.5 close-control row |
| R3-18   | The scrolled stale frame uses the same fixture as `stale-375`.                                                                                                                                                                                                                                                                            | `stale-scrolled-375`; §2.1 Phone                                                |
| R3-19   | The en strings use “ ” quotes and the total reads «Income entries».                                                                                                                                                                                                                                                                       | §2.6 (`stats.compliance.total`, `stats.offlineCold`)                            |
| R3-20   | Both plan-required E2E tests are already named in the spec: `expectNoDuplicates` and the breakpoint-change zero-refetch test. No change beyond stating it.                                                                                                                                                                                | §6 E2E bullet, §2.7                                                             |
| R3-21   | At 320 the partner row is two lines (name and balance on one row, share caption and bar below), as at 375, without regressing the long-name case.                                                                                                                                                                                         | `default-320`, `long-320`; §2.1 Phone                                           |

## Round 4 findings

Council round 4 (sonnet 9.5 / 9.5 / 9.6, opus 9.4 / 9.4 / 9.4, fable 9.7 / 9.6 / 9.7 on phone / tablet / desktop). Every
finding has a row; the proof names a frame, a section or a `measure.mjs` check. Round 3's rejected items stand.

| Finding   | What changed                                                                                                                                                                                                                                                                 | Proof                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-01     | A complete receiver row draws a `--positive` check icon, no chevron, no `role="button"`, no `aria-expanded`, and does not expand; only a row with open projects is a disclosure. Fixed once in `blocks.mjs` (phone and desktop rows); §2.1 Phone and Changes item 23 say so. | `measure.mjs` (8): 52 complete rows, none a disclosure, 168 open rows, each a button; red on the PR-head source (51 defects)                          |
| R4-02     | The tile «На валідації у бухгалтера» counts projects on validation (`totals.pendingProjects`), excluding accrued: 1 in the default fixture, 4 in the variants.                                                                                                               | `compliance-variants-375`, `compliance-variants-1440`; `measure.mjs` (9): tile = drawn project pills in both, red on the PR-head source (5 against 4) |
| R4-03     | `stale-768` is drawn: the strip sticky under the title row inside the 20 px pane gutters, split «Повторити»; the matrix cell points at it.                                                                                                                                   | `stale-768`; §2.1 Tablet; §2.2.1; `measure.mjs` (2) and (5)                                                                                           |
| R4-04     | The tablet hint popover is card-wide (648 px) at 13 / 18 px, so it ends above the series control: the series control, the readout with «Зарплати» and the plot stay visible; it covers only the chart heading row while open.                                                | `hint-popover-768`; §2.4 Hints; `measure.mjs` (11), red on the PR-head popover (bottom 560 against series top 385)                                    |
| R4-05     | Stale lines fixed: the header Status; the A1 month-table line (inner scroll on a fine pointer only, R3-M19); §4 criterion 5; §2.1 «each expandable» (with R4-01).                                                                                                            | Header; `## Assumptions`; §4                                                                                                                          |
| R4-06     | Text contrast runs over every frame, and a non-text pass (3 : 1) measures every data bar, loss bar outline and hatch line, selected outline and progress fill against what is next to it.                                                                                    | §2.5 table; `measure.mjs` (7)                                                                                                                         |
| R4-07     | The string check is a gate in `measure.mjs`: every visible string and accessible name of every frame must match §2.6.                                                                                                                                                        | §2.6 summary line; `measure.mjs` (10)                                                                                                                 |
| R4-08     | The loading placeholders are neutral (`oklch(… 0 0)`), and the gate's tolerance is stated: a fill or border fails above a chroma of 12 of 255. The compliance footnote placeholder covers the text only, so it no longer runs past the right gutter.                         | `loading-768`, `loading-1440`; §2.5; `measure.mjs` (6)                                                                                                |
| R4-09     | The plot band widths are measured, including «Усе» on a tablet at a coarse pointer (28.7 px at `all-768`).                                                                                                                                                                   | §2.5 band row; §2.2.1 matrix; `measure.mjs` (12)                                                                                                      |
| R4-10     | §6 names every testid on today's screen as kept, kept narrower, or removed with its replacement.                                                                                                                                                                             | §6                                                                                                                                                    |
| R4-11     | `stats.company.hint` no longer says "withdrawal" / «виведення» (the `_Avoid_` term of a payout request): en «… and reduced by dividends.», uk «… і зменшується на суму дивідендів.»                                                                                          | §2.6; Changes item 25                                                                                                                                 |
| R4-12     | The partner hint change («адмінів» → «партнерів», plus the USD / USDT and the evening-out sentences) is in the Changes list and in the PR body.                                                                                                                              | Changes item 24; PR body                                                                                                                              |
| OP-25..27 | Period swipe, tablet month table length, sticky strip against the plot: open points 25–27, no change in this PR. The `touch-1024` nav label truncation (S5) extends open points 18, 19 and 23.                                                                               | §5                                                                                                                                                    |
