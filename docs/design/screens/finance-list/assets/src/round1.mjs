// Finance list (Task 1.2), council rounds 1 and 2: the frames the rounds added (month filter, row
// writes, cached refetch failure, tablet two panes and side panels, coarse pointer, end of list,
// desktop detail) and `assertFixtures()`, which fails the render when a fixture stops adding up (M17, P3, P7).
import { icon, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import {
  sheet,
  closeBtn,
  stateBlock,
  skeletonList,
} from '../../../_foundation/assets/src/mobile-overlays.mjs'
import {
  ROWS,
  PAGE,
  PENDING_N,
  VALIDATE_N,
  canValidateRow,
  dayKey,
  M,
  D,
  row,
  dayList,
  searchAndFilters,
  tabletFrame,
  desktopFrame,
  toolbar,
  table,
  pager,
  COMPANY,
} from './finance-list.mjs'
import {
  phoneTab,
  notice,
  ERROR,
  retry,
  filterBody,
  SHOW_N,
  LONG,
  WITH_DELETED,
  PENDING_ROWS,
  END,
  draftsUnknownT,
} from './states.mjs'
import {
  DETAIL,
  detailBody,
  detailFooter,
  detailM,
  rowMenuD,
  PEND,
  SEN,
  SEN_ME,
  SEN_SHARE,
  SAL,
  JUN,
  HR_ME,
  JUN_ME,
  mapDropIncomeStatus,
  detailTrailing,
  DROP_SHARE,
  DINC,
  DPAY,
  PAYOUT_DROP,
  DROP_BALANCE,
} from './roles.mjs'

// ---------- Fixture self-check (M17, P3, P7): run before every render ----------
const RATE = 41.25 // UAH per USD, the fixture rate
const usdOf = (a) => Number(a.replace(/[^\d,]/g, '').replace(',', '.'))
const fmt = (n) =>
  `$${Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${Math.round((n % 1) * 100)
    .toString()
    .padStart(2, '0')}`
const NAME_OK = [
  (s) => s === COMPANY,
  (s) => /^[А-ЯІЇЄҐ][а-яіїєґ’]+ Демо$/.test(s),
  (s) => /^Розробник \d+$/.test(s),
  (s) => /^Клієнт «[^»]+»$/.test(s),
  (s) => s === 'Розробник з дуже довгим ім’ям і прізвищем для перевірки переносу',
  (s) => ['Оренда офісу', 'Хмарний хостинг', 'Дизайн-інструмент', 'Обладнання', 'Банк'].includes(s),
]
export function assertFixtures() {
  const fail = []
  const check = (ok, msg) => ok || fail.push(msg)
  const rows = [...PAGE, ...LONG, ...WITH_DELETED, ...PEND, ...SEN]
  for (const r of rows) {
    check(/^(≈ )?\$\d{1,3}( \d{3})*,\d{2}$/.test(r.a), `amount format: ${r.a}`)
    for (const k of ['from', 'to', 't'])
      if (r[k])
        check(
          NAME_OK.some((f) => f(r[k])),
          `invented name only: ${r[k]}`,
        )
    if (r.usd) check(usdOf(r.a) === r.usd, `usd ${r.usd} != ${r.a}`)
    if (r.uah) {
      check(Math.abs(r.usd * RATE - r.uah) < 0.01, `uah ${r.uah} != ${r.usd} × ${RATE}`)
      check(usdOf(r.orig.replace(' UAH', '')) === r.uah, `orig ${r.orig} != ${r.uah}`)
    }
    // P12: no action today's code does not have. Cash confirm has none.
    if (r.st === 'PENDING_CASH_CONFIRM') check(!r.act, `cash-confirm row has «${r.act}»`)
  }
  // One fixture: the status filter `?status=PENDING` (the ACCOUNTANT deep link and the filtered list)
  // holds every PENDING row, salaries included.
  check(PEND.length === PENDING_N && PENDING_ROWS.length === PENDING_N, `pending ${PENDING_N}`)
  // M22 / R3-08: the preset chip counts only the rows the viewer can validate (`validateQueue`).
  check(
    VALIDATE_N === PAGE.filter(canValidateRow).length &&
      PAGE.filter(canValidateRow).every((r) => r.type !== 'SALARY' && r.act === 'Валідувати'),
    `preset count ${VALIDATE_N}`,
  )
  check(
    PAGE.filter((r) => r.act === 'Валідувати').length === VALIDATE_N,
    'a row offers «Валідувати» outside the preset',
  )
  // SENIOR strip: 20 % of the VALIDATED incomes not yet in a payout request, per project.
  const validated = SEN.filter((r) => r.st === 'VALIDATED' && r.type === 'SENIOR_INCOME')
  const base = validated.reduce((s, r) => s + usdOf(r.a), 0)
  check(Math.abs(base * SEN_SHARE.pct - SEN_SHARE.value) < 0.01, `senior share ${base}`)
  check(fmt(SEN_SHARE.value) === SEN_SHARE.label, `senior label ${SEN_SHARE.label}`)
  check(
    new Set(validated.map((r) => r.project)).size === SEN_SHARE.projects,
    `senior strip projects ${validated.length}`,
  )
  // M20: every role page draws the ADMIN page's rows with the same status, inside the page's window
  // (the oldest PAGE day); older rows are the role page's own.
  const oldest = Math.min(...PAGE.map((r) => dayKey(r.d)))
  const inWindow = (d) => d.endsWith('.2026') || dayKey(d) >= oldest
  const twin = (who, pred) => PAGE.filter((r) => (r.from === who || r.to === who) && pred(r))
  const senTwins = twin(SEN_ME, () => true)
  check(
    SEN.length === senTwins.length &&
      SEN.every((s) => senTwins.some((r) => r.d === s.d && r.a === s.a && r.st === s.st)),
    'SENIOR rows differ from the ADMIN rows',
  )
  for (const [who, list] of [
    [HR_ME, SAL],
    [JUN_ME, JUN],
  ]) {
    const mine = twin(who, (r) => r.type === 'SALARY')
    const drawn = list.filter(([, d]) => d.slice(6) === '2026' && dayKey(d.slice(0, 5)) >= oldest)
    check(
      drawn.length === mine.length &&
        mine.every((r) =>
          drawn.some(
            ([m, d, st, a]) => m === r.month && d.startsWith(r.d) && st === r.st && a === r.a,
          ),
        ),
      `${who} salary rows differ from the ADMIN rows`,
    )
  }
  const DROP_ME = 'Дроп Демо'
  const dropIn = twin(DROP_ME, (r) => r.type === 'DROP_INCOME')
  const dropOut = twin(DROP_ME, (r) => r.type === 'PAYOUT')
  const dIncDrawn = DINC.filter((r) => r.type === 'DROP_INCOME' && inWindow(r.d))
  const dPayDrawn = DPAY.filter((r) => inWindow(r.d))
  check(
    dIncDrawn.length === dropIn.length &&
      dropIn.every((r) => dIncDrawn.some((d) => d.d === r.d && d.raw === r.st && d.a === r.a)),
    'DROP incomes differ from the ADMIN rows',
  )
  check(
    dPayDrawn.length === dropOut.length &&
      dropOut.every((r) => dPayDrawn.some((d) => d.d === r.d && d.raw === r.st && d.a === r.a)),
    'DROP transfers differ from the ADMIN rows',
  )
  // DROP card: the server formula (`computeDropAggregate`), not a sum of the rows on the page (P3).
  const sum = (xs) => xs.reduce((s, r) => s + r.usd, 0)
  const b = DROP_BALANCE
  const net =
    sum(PAYOUT_DROP.filter((r) => r.raw === 'PAID' && r.dir === 'in')) -
    sum(PAYOUT_DROP.filter((r) => r.raw === 'PAID' && r.dir === 'out'))
  check(net === b.balance.usd && fmt(net) === b.balance.label, `drop balance ${net}`)
  const owed = DINC.filter((r) => r.type === 'DROP_PENDING_PAYOUT' && r.raw === 'PENDING_PAYMENT')
  check(sum(owed) === b.obligation.usd && fmt(sum(owed)) === b.obligation.label, 'drop obligation')
  check(owed.length === b.obligation.count, `drop obligation count ${owed.length}`)
  const work = DINC.filter(
    (r) => r.type === 'DROP_INCOME' && (r.raw === 'PENDING' || r.raw === 'VALIDATED'),
  )
  check(work.length === b.inWork.count, `drop in-work count ${work.length}`)
  // R3-15: the card's «У роботі» equals the incomes drawn with a pending or validated pill; an income
  // already in a transfer shows «У переказі від <date>» instead, and that transfer exists.
  const pilled = DINC.filter(
    (r) => r.type === 'DROP_INCOME' && !r.bundle && mapDropIncomeStatus(r.raw) !== 'paid',
  )
  check(pilled.length === b.inWork.count, `drop in-work drawn ${pilled.length}`)
  for (const r of DINC.filter((x) => x.type === 'DROP_INCOME' && x.raw === 'PENDING_PAYMENT'))
    check(
      r.bundle && DPAY.some((p) => p.d === r.bundle && p.from === r.d),
      `drop income ${r.d} is in a transfer but not marked`,
    )
  const debtRows = DPAY.filter((p) => p.raw === 'PENDING_PAYMENT')
  check(sum(debtRows) === b.debt.usd && fmt(b.debt.usd) === b.debt.label, 'drop debt')
  // The debt is booked when the drop creates the payout request: income × (1 − share).
  const booked = DINC.filter((r) => r.type === 'DROP_INCOME' && r.raw === 'PENDING_PAYMENT')
  check(Math.abs(sum(booked) * (1 - DROP_SHARE) - b.debt.usd) < 0.01, 'drop debt != income × share')
  // A hash is verified on submit (PAID or refused), so a pending transfer never carries one.
  for (const p of debtRows) check(!p.hash, `pending transfer ${p.d} has a hash`)
  // One fixture: the drop's income in the ADMIN list has the same status and amount as on its page.
  for (const r of ROWS.filter((x) => x.type === 'DROP_INCOME'))
    check(
      DINC.some((d) => d.d === r.d && d.raw === r.st && d.a === r.a),
      `drop income ${r.d} differs between ADMIN and DROP`,
    )
  for (const r of [...DINC, ...DPAY]) check(fmt(r.usd) === r.a, `drop row ${r.a}`)
  if (fail.length) throw new Error(`fixtures do not add up:\n- ${fail.join('\n- ')}`)
  return rows.length + DINC.length + DPAY.length
}

// ---------- Shared pieces ----------
const sel = (html, x) => html.replace(row(x), row(x, { sel: true }))
const withMark = (i, mark, rows = PAGE) => rows.map((r, k) => (k === i ? { ...r, mark } : r))
// The row every write frame uses (P1): the pending salary, primary «Розрахуватися» (`canPaySalary`).
const W = 3
const WR = { ...DETAIL, mark: 'unknown' }

// Banner of an unknown write, in the phone detail, the tablet pane and the desktop panel (§9.2, P1).
export const UNKNOWN_TITLE = 'Невідомо, чи зміну збережено'
export const UNKNOWN_TEXT =
  'Відповідь не надійшла. Оновіть: статус покаже, чи зміну збережено. Не повторюйте дію, доки статус не оновиться.'
const unknownBanner = `<div role="status" class="col" style="gap:8px;margin:0 0 16px;padding:12px 14px;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85)"><div class="row" style="gap:8px;align-items:flex-start"><span style="color:var(--warning);display:grid;flex:none;margin-top:1px">${icon('circle-alert', { size: 17 })}</span><div class="col" style="gap:3px"><span style="font-size:15px;font-weight:600">${UNKNOWN_TITLE}</span><span class="t-foot" style="color:var(--fg)">${UNKNOWN_TEXT}</span></div></div><div class="row" style="gap:8px;padding-left:25px"><span class="btn secondary sm" style="height:44px">${icon('rotate-cw', { size: 15 })}Оновити</span><span class="btn ghost sm" style="height:44px">Зрозуміло</span></div></div>`
const fineBanner = unknownBanner.replaceAll('height:44px', 'height:32px')

// Desktop row detail (P4, foundation "Modality by width"): docked and non-modal only at ≥ 1440 (the
// list narrows by 480 and switches to its compact columns; ↑ / ↓ in the table retarget the panel).
// At 1024–1439 it is a modal overlay, 420 wide: scrim, focus trap, Esc closes, the list does not move.
const panelW = (w) => (w >= 1440 ? 480 : 420)
// M18: the panel's «Редагувати» and «…» follow the viewer and the state, as on the phone top bar.
const panelActions = ({ admin = true, blocked = false } = {}) => {
  if (!admin) return ''
  const off = blocked ? ' aria-disabled="true" aria-describedby="blk"' : ''
  const dim = blocked ? 'opacity:0.45;' : ''
  return `<span class="btn ghost sm"${off} style="${dim}height:32px;font-size:14px">Редагувати<span class="kbdkey">E</span></span><span class="iconbtn" aria-label="Інші дії" aria-haspopup="menu"${blocked ? ' aria-describedby="blk"' : ''} style="${dim}width:32px;height:32px">${icon('ellipsis', { size: 16 })}</span>`
}
const detailPanel = (w, { banner = '', blocked = false, x = DETAIL, admin = true } = {}) => {
  const modal = w < 1440
  return `${modal ? '<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:60"></div>' : `<style>main{margin-right:${panelW(w)}px}</style>`}<aside ${modal ? 'role="dialog" aria-modal="true" ' : ''}aria-labelledby="dp-t" style="position:absolute;top:0;right:0;bottom:0;width:${panelW(w)}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);${modal ? 'box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);' : ''}display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 12px 0 24px;gap:4px;border-bottom:1px solid var(--border)"><h2 id="dp-t" class="grow t-head" style="margin:0">Транзакція</h2>${panelActions({ admin, blocked })}<span class="kbdkey" style="margin:0 4px 0 6px">Esc</span><span class="iconbtn" aria-label="Закрити" style="width:32px;height:32px">${icon('x', { size: 18 })}</span></div>
  <div class="col grow" style="min-height:0;overflow:hidden;padding:16px 24px">${banner}${detailBody(x).replace('<h1 ', '<p ').replace('</h1>', '</p>')}</div>${detailFooter(x, { blocked, bottom: 16 }).replace('padding:12px 16px', 'padding:12px 24px')}</aside>`
}
// Docked: the compact table without «Тип · проєкт» (the panel shows both), so the party keeps room.
// The toolbar never wraps (§3.3): while the panel docks, «Показати видалені» folds into the status
// menu as its last item (R3-10), so the toolbar draws no toggle.
const docked = (html) =>
  html
    .replace('<col style="width:120px">', '')
    .replace('<th>Тип · проєкт</th>', '')
    .replace(/<td class="muted">[^<]*<\/td>/g, '')
const detailD = (w, h, { banner = '', mark, blocked = false } = {}) => {
  const rows = mark ? withMark(W, mark) : PAGE
  const list =
    w >= 1440
      ? `${toolbar({ w: 1024 })}${docked(table(rows, { w: 1024, sel: W, blocked: blocked ? W : -1 }))}`
      : `${toolbar({ w, deleted: false })}${table(rows, { w, sel: W, blocked: blocked ? W : -1 })}`
  return desktopFrame({
    w,
    h,
    body: `${list}${pager()}`,
    overlay: detailPanel(w, { banner, blocked, x: mark ? { ...DETAIL, mark } : DETAIL }),
  })
}

// ---------- Month filter (M1, A-1): a chip on phone, a whole-button chip on desktop ----------
const NOV = PAGE.filter((r) => /^\d{2}\.11$/.test(r.d))
const monthM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['Листопад 2026'], match: NOV.length })}${dayList(NOV)}`,
  })
const monthD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, month: 'Листопад 2026', count: `${NOV.length} з 132` })}${table(NOV, { w, sel: -1 })}`,
  })
export const MONTH_EMPTY = {
  ic: 'calendar',
  title: 'За березень 2026 транзакцій немає',
  text: 'Оберіть інший місяць або покажіть усі транзакції.',
}
const monthEmptyM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['Березень 2026'], match: 0 })}${stateBlock({
      ...MONTH_EMPTY,
      action: '<span class="btn secondary" style="height:44px">Показати всі місяці</span>',
    })}`,
  })

// ---------- Row writes (§9.2, P1): pending, unknown, definite failure — all on the same row ----------
const kv = (k, v) =>
  `<div class="lrow" style="min-height:48px"><div class="t-body muted" style="flex:none">${k}</div><div class="grow t-body" style="text-align:right">${v}</div></div>`
const payBody = `<div class="group">${kv('Сума', `<span class="num">${DETAIL.a}</span>`)}${kv('Отримувач', DETAIL.to)}${kv('Період', DETAIL.month ?? '—')}${kv('Списати з', COMPANY)}</div>`
export const PENDING_NOTE =
  'Можна закрити: збереження триватиме, а результат з’явиться в рядку транзакції.'
const paySheet = (w, h, { body, primary }) =>
  sheet({
    w,
    h,
    top: Math.round(h * (w <= 320 ? 0.3 : 0.42)),
    title: 'Розрахуватися',
    lead: '',
    trail: closeBtn,
    body,
    footer: `<div style="padding:12px 16px ${safeBottom(w) + 8}px">${primary}</div>`,
  })
const pendingM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${dayList(withMark(W, 'pending', ROWS).slice(0, 7))}`,
    showFab: false,
    overlay: paySheet(w, h, {
      body: `${payBody}<p class="t-foot muted" role="status" style="margin:12px 16px 0">${PENDING_NOTE}</p>`,
      primary: `<span class="btn primary" aria-disabled="true" style="width:100%;opacity:0.7">${icon('loader-circle', { size: 18 })}Зберігаємо…</span>`,
    }),
  })
export const FAILED_TITLE = 'Не вдалося розрахуватися'
export const FAILED_TEXT = 'Нічого не змінено. Дані у формі залишились — спробуйте ще раз.'
const failedAlert = `<div role="alert" class="row" style="gap:10px;align-items:flex-start;margin:14px 16px 0;padding:12px 14px;border-radius:12px;background:oklch(0.22 0.05 25);border:1px solid oklch(0.42 0.12 25)"><span style="color:var(--destructive);display:grid;flex:none;margin-top:1px">${icon('circle-alert', { size: 17 })}</span><div class="col" style="gap:3px"><span style="font-size:15px;font-weight:600">${FAILED_TITLE}</span><span class="t-foot" style="color:var(--fg)">${FAILED_TEXT}</span></div></div>`
const failedM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${dayList(ROWS.slice(0, 6))}`,
    showFab: false,
    overlay: paySheet(w, h, {
      body: `${payBody}${failedAlert}`,
      primary: '<span class="btn primary" style="width:100%">Розрахуватися</span>',
    }),
  })
const unknownM = (w, h) => detailM(w, h, { x: WR, banner: unknownBanner, blocked: true })
// R3-12: back on the list, the same row carries the «Результат невідомий» marker until a refetch.
// Drawn scrolled to that row (the list is under the pinned search, R3-25), so the marker is in view.
const unknownListM = (w, h) =>
  phoneTab(w, h, {
    scrolled: true,
    body: `${AT_END}${scrolledHead}${dayList(withMark(W, 'unknown', ROWS).slice(W, W + 6))}`,
  })

// ---------- Cached refetch failed (M3): rows stay, one alert notice ----------
const refetchM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${notice('Не вдалося оновити. Показано дані станом на 14:32.', { ic: 'cloud-alert', tone: 'var(--destructive)', role: 'alert', action: retry })}${dayList(ROWS.slice(0, 7))}`,
  })

// ---------- End of the list (P7): batches come from memory, so the list ends with a line ----------
// Drawn scrolled to the bottom: the large title has collapsed into the bar, the last rows sit above
// the end line, and the foundation's end clearance (tab bar + FAB + 16) keeps «+» off every amount.
const AT_END = `<style>.content{display:flex;flex-direction:column}.content>.largetitle{display:none}.content>*{flex:none}.content>.tail{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-start}.tail>*{flex:none}</style>`
// One scrolled-head rule (R3-25) for footer-375 and scrolled-320: the search stays pinned under the
// bar (M14); with no filter active the chip row scrolls away with the list; the day header sticks.
const scrolledHead = `<div style="padding-top:8px;border-bottom:1px solid var(--separator)">${searchAndFilters({ chips: false })}</div>`
const footerM = (w, h) =>
  phoneTab(w, h, {
    scrolled: true,
    body: `${AT_END}${scrolledHead}<div class="tail">${dayList(PAGE.slice(-4))}${END}</div>`,
  })
const scrolled320 = (w, h) =>
  phoneTab(w, h, {
    scrolled: true,
    body: `${AT_END}${scrolledHead}<div class="tail">${dayList(PAGE.slice(-2))}${END}</div>`,
  })

// ---------- Tablet: two panes at ≥ 900, filter side panel, error ----------
// The pane: the body scrolls, the actions sit in a sticky footer 16 px above the home indicator (P8).
export const pane = ({ x = DETAIL, banner = '', blocked = false, admin = true } = {}) =>
  `<section aria-labelledby="pn-t" class="grow col" style="min-width:0"><div class="row" style="height:56px;padding:0 8px 0 24px;flex:none"><h2 id="pn-t" class="grow t-head" style="margin:0">Транзакція</h2>${detailTrailing({ admin, blocked })}</div><div style="flex:1;min-height:0;overflow:hidden;padding:0 24px">${banner}${detailBody(x).replace('<h1 ', '<p ').replace('</h1>', '</p>')}</div>${detailFooter(x, { blocked, bottom: 36 }).replace('padding:12px 16px', 'padding:12px 24px')}</section>`
export const PANE_EMPTY = {
  ic: 'list-checks',
  title: 'Оберіть транзакцію',
  text: 'Тут з’являться її деталі та дії.',
}
const emptyPane = `<section aria-label="Деталі транзакції" class="grow col" style="min-width:0;justify-content:center">${stateBlock(PANE_EMPTY)}</section>`
const main1000 = (w, h, { x = DETAIL, mark, banner = '', blocked = false } = {}) => {
  const rows = mark ? withMark(W, mark, ROWS) : ROWS
  return tabletFrame({
    w,
    h,
    pane: pane({ x, banner, blocked }),
    body: `${searchAndFilters()}${sel(dayList(rows.slice(0, 8)), rows[W])}`,
  })
}
const main1000Empty = (w, h) =>
  tabletFrame({
    w,
    h,
    pane: emptyPane,
    body: `${searchAndFilters()}${dayList(ROWS.slice(0, 8))}`,
  })
const loading1000 = (w, h) =>
  tabletFrame({
    w,
    h,
    pane: emptyPane,
    body: `<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${searchAndFilters({ preset: 0 })}${skeletonList(3)}${skeletonList(4)}</div>`,
  })
// Filter side panel at 640–899: 400 px, modal, so the list keeps at least 240 px visible beside it.
const filterPanel = (w) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:60"></div>
  <aside role="dialog" aria-modal="true" aria-labelledby="fp-t" style="position:absolute;top:0;right:0;bottom:0;width:400px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 8px 0 16px;gap:8px;border-bottom:1px solid var(--border)"><span class="btn ghost" style="height:44px;font-size:17px;padding:0 8px;color:var(--primary)">Скинути</span><h2 id="fp-t" class="grow t-head" style="margin:0;text-align:center">Фільтри</h2>${closeBtn}</div>
  <div class="grow" style="min-height:0;padding:16px 0">${filterBody({ month: 'Листопад 2026' })}</div>
  <div style="padding:14px 16px ${safeBottom(w) + 8}px;border-top:1px solid var(--border)"><span class="btn primary" style="width:100%">${SHOW_N}</span></div></aside>`
const filters768 = (w, h) =>
  tabletFrame({
    w,
    h,
    body: `${searchAndFilters({ active: ['Статус: Очікує валідації'], match: PENDING_ROWS.length })}${dayList(PENDING_ROWS)}`,
    overlay: filterPanel(w),
  })
const error768 = (w, h) => tabletFrame({ w, h, body: `${searchAndFilters()}${stateBlock(ERROR)}` })

// ---------- Coarse pointer at desktop width (M9): 44 px controls, 52 px rows, «…» always visible ----------
const touch = (html) =>
  html.replaceAll('height:32px', 'height:44px').replaceAll('width:32px', 'width:44px')
const touchD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${touch(toolbar({ w, deleted: false }))}${table(PAGE, { w, sel: 1, coarse: true })}${touch(pager())}`,
  })

// ---------- Detail of a rejected income and of a part-paid salary (P13) ----------
const REJ = SEN.find((r) => r.st === 'REJECTED')
const rejected = {
  ...REJ,
  payee: 'Ви',
  cur: 'USDT',
  acts: ['Виправити'],
  date: '14 листопада 2026',
  by: 'Олег Демо',
  extra: [
    // The share and its source (M11, R3-17): this one is the project's rate.
    ['Частка компанії', `${REJ.share} · за проєктом · ${fmt(usdOf(REJ.a) * 0.2)}`],
    ['Причина відмови', REJ.reason],
    // M23: neutral for either outcome; the row was rejected, not validated.
    ['Хто перевірив', 'Бухгалтер Демо'],
  ],
}
export const PART = { paid: 1000 }
const partial = {
  ...DETAIL,
  extra: [
    ['Сплачено', fmt(PART.paid)],
    ['До сплати', fmt(usdOf(DETAIL.a) - PART.paid)],
  ],
}

export function round1Frames() {
  return [
    M('main-1000', 1000, 760, main1000(1000, 760)),
    M('main-1000-empty-pane', 1000, 760, main1000Empty(1000, 760)),
    M('drafts-unknown-1000', 1000, 760, draftsUnknownT(1000, 760, emptyPane)),
    M('loading-1000', 1000, 760, loading1000(1000, 760)),
    D('main-touch-1180', 1180, 820, touchD(1180, 820)),
    D('row-menu-touch-1180', 1180, 820, rowMenuD(1180, 820, { coarse: true })),
    M('month-375', 375, 812, monthM(375, 812)),
    D('month-1440', 1440, 900, monthD(1440, 900)),
    M('month-empty-375', 375, 812, monthEmptyM(375, 812)),
    M('error-768', 768, 1024, error768(768, 1024)),
    M('refetch-failed-375', 375, 812, refetchM(375, 812)),
    M('filters-768', 768, 1024, filters768(768, 1024)),
    M('footer-375', 375, 812, footerM(375, 812)),
    M('scrolled-320', 320, 568, scrolled320(320, 568)),
    M('row-write-pending-375', 375, 812, pendingM(375, 812)),
    M('row-write-failed-375', 375, 812, failedM(375, 812)),
    M('row-write-unknown-375', 375, 812, unknownM(375, 812)),
    M('row-write-unknown-list-375', 375, 812, unknownListM(375, 812)),
    M(
      'row-write-unknown-1000',
      1000,
      760,
      main1000(1000, 760, { x: WR, mark: 'unknown', banner: unknownBanner, blocked: true }),
    ),
    D(
      'row-write-unknown-1440',
      1440,
      900,
      detailD(1440, 900, { banner: fineBanner, mark: 'unknown', blocked: true }),
    ),
    D('detail-1024', 1024, 768, detailD(1024, 768)),
    D('detail-1440', 1440, 900, detailD(1440, 900)),
    M('detail-rejected-375', 375, 812, detailM(375, 812, { x: rejected, admin: false })),
    M('detail-partial-375', 375, 812, detailM(375, 812, { x: partial })),
  ]
}
