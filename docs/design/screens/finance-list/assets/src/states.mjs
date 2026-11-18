// Finance list (Task 1.2): states, single interaction frames. Built on the main-state blocks.
// Every name and amount below is invented seed-like data: no real people, companies or money.
import { icon, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { topBar, TABBAR_H } from '../../../_foundation/assets/src/mobile.mjs'
import {
  sheet,
  closeBtn,
  skeletonList,
  stateBlock,
  offlineBanner,
} from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { toggle } from '../../../_foundation/assets/src/prims-mobile.mjs'
import { pinnedRows, draftFab, DRAFT, AMOUNT } from '../../../_foundation/assets/src/money-form.mjs'
import {
  ROWS,
  PAGE,
  PENDING_N,
  TYPE,
  STATUS,
  M,
  D,
  row,
  dayList,
  searchAndFilters,
  desktopFrame,
  tabletFrame,
  toolbar,
  table,
  pager,
  title,
  listScreen,
  txCount,
} from './finance-list.mjs'

// ---------- Shared pieces ----------
export const phoneTab = (w, h, opts) =>
  listScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', ...opts })

// A quiet in-flow notice (same slot and shape as the foundation offline banner).
export const notice = (
  text,
  { ic = 'info', tone = 'var(--info)', action = '', role = 'status' } = {},
) =>
  `<div role="${role}" class="row" style="gap:8px;margin:0 12px 6px;padding:8px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px"><span style="color:${tone};display:grid;flex:none">${icon(ic, { size: 16 })}</span><span class="grow">${text}</span>${action}</div>`
export const dNotice = (text, opts) =>
  notice(text, opts)
    .replace('margin:0 12px 6px', 'margin:0')
    .replace('font-size:14px', 'font-size:13px')

// Desktop: the state block sits inside the same card the table uses, so the frame does not jump.
export const dCard = (inner) =>
  `<div class="grow col" style="min-height:0;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card);align-items:center">${inner}</div>`

const EMPTY = {
  ic: 'receipt',
  title: 'Транзакцій ще немає',
}
const FILTERED = {
  ic: 'search-x',
  title: 'Нічого не знайдено',
  text: 'Змініть пошук або скиньте фільтри.',
  action: `<span class="btn secondary" style="height:44px">Скинути фільтри</span>`,
}
export const ERROR = {
  ic: 'cloud-alert',
  tone: 'var(--destructive)',
  role: 'alert',
  title: 'Не вдалося завантажити транзакції',
  text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
  action: `<span class="btn secondary" style="height:44px">${icon('rotate-cw', { size: 18 })}Спробувати ще</span>`,
}
export const retry = `<span class="btn ghost sm" style="height:44px;color:var(--primary);flex:none">Повторити</span>`

// ---------- Loading ----------
// With no rows yet the preset chip hides (M22, §3.1): there is no count to show.
const loadingM = (w, h) =>
  phoneTab(w, h, {
    body: `<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${searchAndFilters({ preset: 0 })}${skeletonList(3)}${skeletonList(4)}</div>`,
  })
const skTableRows = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<tr aria-hidden="true"><td><div class="sk" style="width:38px;height:11px"></div></td><td><div class="sk" style="width:${[46, 32, 54, 38, 42, 28, 50, 36][i % 8] * 4}px;height:12px"></div></td><td><div class="sk" style="width:70px;height:11px"></div></td><td><div class="sk" style="width:60px;height:11px"></div></td><td><div class="sk" style="width:84px;height:18px;border-radius:9px"></div></td><td class="r"><div class="sk" style="width:90px;height:12px;margin-left:auto"></div></td><td></td></tr>`,
  ).join('')
const loadingD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, preset: 0, count: '<span class="sk" style="display:inline-block;width:80px;height:11px"></span>' })}<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${table([], { w }).replace('<tbody></tbody>', `<tbody>${skTableRows(12)}</tbody>`)}</div>`,
  })

// ---------- Empty (no transactions at all): no search, no filters; the «+» is the one entry ----------
const emptyM = (w, h) =>
  phoneTab(w, h, {
    body: stateBlock({ ...EMPTY, text: 'Натисніть «+», щоб додати першу.' }),
  })
const emptyD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: dCard(stateBlock({ ...EMPTY, text: 'Створіть першу кнопкою «Нова транзакція».' })),
  })

// ---------- Filtered to nothing ----------
// «Скинути фільтри» clears the filters and the search text together (R3-25); when only the search
// narrows, the button reads «Очистити пошук». At 320 every state block is start-aligned 24 px under
// the chips, so its button clears the FAB (P13, R3-25).
const at320 = (w, html) =>
  w <= 320
    ? html.replace(
        'align-items:center;text-align:center;gap:6px;padding:56px 32px 0',
        'align-items:flex-start;text-align:start;gap:6px;padding:24px 24px 0',
      )
    : html
const filteredM = (w, h, active = ['Статус: Відхилено']) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ q: 'оренда', active, match: 0 })}${at320(w, stateBlock(FILTERED))}`,
  })
// 320: three active chips — the row scrolls sideways; the sort chip stays second.
const filtered320 = (w, h) => filteredM(w, h, ['Тип: Витрата', 'Статус: Відхилено', 'З видаленими'])
const filteredD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, status: 'Відхилено', deleted: false, count: '0 з 132', q: 'оренда' })}${dCard(stateBlock(FILTERED))}`,
  })

// ---------- Error (first load failed; nothing cached) ----------
// P13: at 320 the block starts 24 px under the chips and is start-aligned, so «Спробувати ще» clears the FAB.
const errorM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ preset: 0 })}${at320(w, stateBlock(ERROR))}`,
  })
const errorD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, count: '' })}${dCard(stateBlock(ERROR))}`,
  })

// ---------- Offline: the cached list stays readable; every action stays enabled (M4) ----------
// A write attempted offline ends in the definite alert inside its dialog; nothing is disabled here.
// The notice carries the "data as of" stamp, like the refetch-failed notice (P9). On reconnect the
// reads refetch by themselves (`refetchOnReconnect` is the TanStack default, `true`).
export const OFFLINE_TEXT =
  'Немає з’єднання. Показано дані станом на 14:32; збереження не пройде, введене залишиться у формі.'
const offlineM = (w, h) =>
  phoneTab(w, h, {
    body: `${notice(OFFLINE_TEXT, { ic: 'wifi-off', tone: 'var(--warning)' })}${searchAndFilters()}${dayList(ROWS)}`,
  })
const offlineD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${dNotice(OFFLINE_TEXT, { ic: 'wifi-off', tone: 'var(--warning)' })}${toolbar({ w, deleted: false })}${table(PAGE, { w, sel: -1, hover: 1 })}${pager()}`,
  })
// First load offline with nothing cached: its own state (P9). It reloads by itself on reconnect;
// «Спробувати ще» is there for a user who does not want to wait.
export const OFFLINE_COLD = {
  ic: 'wifi-off',
  tone: 'var(--warning)',
  role: 'status',
  title: 'Немає з’єднання',
  text: 'Транзакції ще не завантажено. Список з’явиться, щойно з’єднання повернеться.',
  action: `<span class="btn secondary" style="height:44px">${icon('rotate-cw', { size: 18 })}Спробувати ще</span>`,
}
export const offlineColdM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ preset: 0 })}${at320(w, stateBlock(OFFLINE_COLD))}`,
  })
export const offlineColdD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, count: '' })}${dCard(stateBlock(OFFLINE_COLD))}`,
  })

// ---------- Partial: the rates query failed; amounts stay in the transaction currency ----------
// The converted row shows its own amount; USD / USDT rows are unchanged. Amount sort is disabled.
const ratesOff = (rows) => rows.map((r) => (r.orig ? { ...r, a: r.orig, orig: undefined } : r))
export const RATES_OFF = ratesOff(ROWS)
// R3-21: the notice names the disabled sort, so the phone shows it without opening the sort sheet.
export const RATES_TEXT =
  'Курс недоступний — суми показано у валюті транзакції, сортування за сумою вимкнено.'
const partialM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${notice(RATES_TEXT, { ic: 'circle-alert', tone: 'var(--warning)', action: retry })}${dayList(RATES_OFF)}`,
  })
const partialD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${dNotice(RATES_TEXT, { ic: 'circle-alert', tone: 'var(--warning)', action: retry.replace('height:44px', 'height:28px') })}${toolbar({ w, deleted: false })}${table(ratesOff(PAGE), { w, sel: -1, sortOff: true })}${pager()}`,
  })

// ---------- Filters: phone bottom sheet (URL-held); desktop listbox ----------
const pickRow = (k, v) =>
  `<div class="lrow" role="button" aria-haspopup="dialog" style="min-height:52px"><div class="grow t-body">${k}</div><span class="muted t-sub trunc" style="max-width:58%">${v}</span>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
// The month arrives by link (M1) and has no picker: in the sheet it is a row with a 44 px remove
// button (P6). «Скинути» clears type, status, month, sort and «Показати видалені»; the search text
// stays (it lives outside the sheet and has its own clear button).
const monthRow = (m) =>
  `<div class="lrow" style="min-height:52px"><div class="grow t-body">Місяць</div><span class="t-sub">${m}</span><span class="iconbtn" role="button" aria-label="Прибрати фільтр: ${m}" style="width:44px;height:44px;margin-right:-10px;color:var(--muted-fg)">${icon('circle-x', { size: 18 })}</span></div>`
export const filterBody = ({ deleted = true, month = '' } = {}) =>
  `<div class="group">${pickRow('Тип', 'Усі типи')}${pickRow('Статус', 'Очікує валідації')}${month ? monthRow(month) : ''}${pickRow('Сортування', 'Спочатку нові')}</div>
  ${deleted ? `<div class="group" style="margin-top:14px"><div class="lrow" style="min-height:52px"><div class="grow t-body">Показати видалені</div>${toggle(false, 'Показати видалені')}</div></div>` : ''}`
export const PENDING_ROWS = PAGE.filter((r) => r.st === 'PENDING')
export const SHOW_N = `Показати ${txCount(PENDING_ROWS.length)}`
const filterSheet = (w, h, { deleted = true, month = '' } = {}) =>
  sheet({
    w,
    h,
    // At 320 the sheet opens at the large detent (R3-25): the whole body fits without scrolling.
    top: Math.round(h * (w <= 320 ? 0.18 : 0.44)),
    title: 'Фільтри',
    lead: '<span style="font-size:17px">Скинути</span>',
    trail: closeBtn,
    body: filterBody({ deleted, month }),
    footer: `<div style="padding:12px 16px ${safeBottom(w) + 8}px"><span class="btn primary" style="width:100%">${SHOW_N}</span></div>`,
  })
const filtersM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['Статус: Очікує валідації'], match: PENDING_ROWS.length })}${dayList(PENDING_ROWS)}`,
    overlay: filterSheet(w, h, { month: 'Листопад 2026' }),
    showFab: false,
  })
const statusMenu = (left) =>
  `<div role="listbox" aria-label="Статус" style="position:absolute;left:${left}px;top:${56 + 20 + 38}px;width:300px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px">${[
    ['Усі статуси', false],
    ...Object.entries(STATUS).map(([k, [l]]) => [l, k === 'PENDING']),
  ]
    .map(
      ([l, on], i) =>
        `<div role="option" aria-selected="${on}" class="row" style="gap:8px;min-height:32px;padding:6px 10px;border-radius:8px;font-size:13px;line-height:17px;${on ? 'background:var(--raised)' : ''}${i === 0 ? ';color:var(--muted-fg)' : ''}"><span class="grow">${l}</span>${on ? `<span style="color:var(--primary);display:grid">${icon('check', { size: 15, stroke: 2.4 })}</span>` : ''}</div>`,
    )
    .join('')}</div>`
const filtersD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, status: 'Очікує валідації', deleted: false, count: `${PENDING_ROWS.length} з 132` })}${table(
      PENDING_ROWS,
      { w, sel: -1 },
    )}`,
    overlay: statusMenu(248 + 24 + (w >= 1280 ? 300 : 220) + 8 + 92 + 8),
  })

// ---------- Drafts: a kept money draft pins above the list; the create entry carries the dot ----------
// R2-16 (P10): one money format. The foundation card prints «1 250,50 USD»; the list prints «$1 200,00».
// This screen rewrites the draft amount to the list format (the foundation file is not edited).
const money = (html) => html.replace(/(\d[\d ,]*) USD/g, '$$$1')
const UNK = (p) => `color-mix(in oklch, var(--warning) ${p}%, transparent)`
// P1, M19: the unknown card carries its sent time (shell v2) and the duplicate warning, and offers
// «Оновити статус» beside «Відкрити». Until money creates carry an idempotency key (Task 1.1),
// «Оновити статус» re-reads the list only: it cannot prove the create did not land, so the card stays
// unknown, and no resend is ever offered without the warning line.
export const UNKNOWN_DRAFT_TEXT = 'Результат невідомий: витрата могла зберегтися.'
export const DUPLICATE_WARNING =
  'Може створити дублікат. Перевірте список, перш ніж надсилати знову.'
export const SENT_AT = 'надіслана о 14:32'
const unknownCard = `<div style="padding:0 16px 8px"><div class="col" role="group" aria-label="Чернетка $${AMOUNT}, результат невідомий" style="gap:6px;padding:10px 8px 8px 14px;border-radius:14px;background:var(--card);border:1px solid ${UNK(40)};box-shadow:inset 2px 0 0 var(--warning)"><span class="row" style="gap:8px"><span class="t-body num" style="font-weight:600;white-space:nowrap">$${AMOUNT} · Витрата</span><span class="t-foot muted num trunc">${SENT_AT}</span></span><span class="t-foot muted" style="padding-right:6px">${UNKNOWN_DRAFT_TEXT} ${DUPLICATE_WARNING}</span><span class="row" style="gap:8px;justify-content:flex-end"><a class="btn sm secondary" href="#" aria-label="Оновити статус чернетки $${AMOUNT}" style="height:44px;padding:0 14px;background:${UNK(18)};border-color:${UNK(45)}">Оновити статус</a><a class="btn sm secondary" href="#" aria-label="Відкрити чернетку $${AMOUNT}" style="height:44px;padding:0 14px">Відкрити</a></span></div></div>`
const FOUNDATION_UNKNOWN = pinnedRows([DRAFT.unknown]).slice(
  '<div style="padding-bottom:4px">'.length,
  -'</div>'.length,
)
export const pins = (drafts) => money(pinnedRows(drafts).replace(FOUNDATION_UNKNOWN, unknownCard))
// The FAB badge counts unresolved drafts only (unknown + failed), per P1.
export const unresolved = (drafts) =>
  drafts.filter((d) => d.kind === 'unknown' || d.kind === 'failed').length
const ONE = [DRAFT.failed]
const FOUR = [DRAFT.armed, DRAFT.failed2, DRAFT.inflight, DRAFT.unknown]
const draftsM = (w, h) =>
  draftFab(
    phoneTab(w, h, {
      body: `${searchAndFilters()}${pins(ONE)}${dayList(ROWS)}`,
    }),
    unresolved(ONE),
  )
// Four kept drafts (shell v2 §4): unresolved first, two rows, then «Ще 2 чернетки · Показати».
const draftsUnknownM = (w, h) =>
  draftFab(
    phoneTab(w, h, {
      body: `${searchAndFilters()}${pins(FOUR)}${dayList(ROWS)}`,
    }),
    unresolved(FOUR),
  )
// R3-11: the tablet two-pane layout pins the same cards at the top of the 360 px list column; the
// rail «+» carries the unresolved count as the phone FAB does. «Відкрити» opens the draft in the pane.
const railDrafts = (html, n) =>
  html.replace(
    /<div aria-label="Нова транзакція" role="button" style="(width:52px[^"]*)">/,
    `<div aria-label="Нова транзакція, чернеток потребують уваги: ${n}" role="button" style="position:relative;$1"><i aria-hidden="true" class="num" style="position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:var(--destructive);color:#fff;font:700 12px/18px var(--font);font-style:normal;text-align:center;box-shadow:0 0 0 2px var(--bg)">${n}</i>`,
  )
export const draftsUnknownT = (w, h, pane) =>
  railDrafts(
    tabletFrame({ w, h, pane, body: `${searchAndFilters()}${pins(FOUR)}${dayList(ROWS)}` }),
    unresolved(FOUR),
  )
const WARN = (p) => `color-mix(in oklch, var(--destructive) ${p}%, transparent)`
const draftTr = `<tr><td colspan="7" style="padding:0;max-width:none;background:${WARN(7)};box-shadow:inset 2px 0 0 var(--destructive)"><div class="row" style="gap:10px;height:40px;padding:0 8px 0 12px"><span style="color:var(--destructive);display:grid">${icon('file-pen', { size: 16 })}</span><span class="num" style="font-weight:600;white-space:nowrap">$${AMOUNT}</span><span class="grow muted trunc">Не збережено · Витрата</span><button type="button" class="btn sm secondary" aria-label="Відкрити чернетку $${AMOUNT}" style="height:28px;font-size:13px;padding:0 12px;background:${WARN(18)};border-color:${WARN(45)}">Відкрити</button></div></td></tr>`
const DOT =
  '<i aria-hidden="true" style="position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--bg)"></i>'
const draftsD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(PAGE, { w, sel: -1 }).replace('<tbody>', `<tbody>${draftTr}`)}${pager()}`,
  })
    .replace(
      '<span class="btn primary" style="height:36px',
      '<span class="btn primary" aria-label="Нова транзакція, 1 чернетка потребує уваги" style="position:relative;height:36px',
    )
    .replace('C</span></span></header>', `C</span>${DOT}</span></header>`)

// ---------- Show deleted (ADMIN / ACCOUNTANT only): the «Видалено» pill takes the status slot ----------
// Two deleted rows join the same first page (P7: the page still draws 50 rows; total 132 + 2 = 134).
// They are their own transactions, so no row changes status between frames (P3 "one fixture").
const DEL = (r, a) => ({
  ...r,
  a,
  usd: undefined,
  orig: undefined,
  deleted: true,
  act: 'Відновити',
})
export const WITH_DELETED = [
  ...PAGE.slice(0, 3),
  DEL(ROWS[2], '$410,00'),
  ...PAGE.slice(3, 8),
  DEL(
    ROWS.find((r) => r.to === 'Дизайн-інструмент'),
    '$95,00',
  ),
  ...PAGE.slice(8),
].slice(0, 50)
// End of the list (P7): the last batch is in memory, so the list ends with a line, not a loader.
export const END =
  '<div role="status" class="t-foot muted" style="text-align:center;padding:16px 16px 24px">Більше транзакцій немає</div>'
const deletedM = (w, h) =>
  phoneTab(w, h, {
    // R3-07: «З видаленими» matches all 134; the page draws its 50-row window of them.
    body: `${searchAndFilters({ active: ['З видаленими'], match: 134, total: 134 })}${dayList(WITH_DELETED)}`,
  })
const deletedD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: true, total: 134 })}${table(WITH_DELETED, {
      w,
      sel: -1,
      hover: 2,
    })}${pager(1, 50, 134)}`,
  })

// ---------- Long content: long parties, the longest status, big amounts, a row from another year ----------
// 1 234 567,89 USD × 41,25 = 50 925 925,46 UAH (assertFixtures()).
export const LONG = [
  {
    day: 'Сьогодні',
    d: '17.11',
    from: 'Клієнт «Міжнародна освітня платформа для дистанційного навчання»',
    to: 'Олег Демо',
    type: 'ADMIN_INCOME',
    project: 'Платформа онлайн-курсів для корпоративних клієнтів',
    st: 'PENDING_CASH_CONFIRM',
    a: '≈ $1 234 567,89',
    orig: '50 925 925,46 UAH',
    usd: 1234567.89,
    uah: 50925925.46,
  },
  ...ROWS.slice(0, 1),
  {
    ...ROWS[3],
    to: 'Розробник з дуже довгим ім’ям і прізвищем для перевірки переносу',
    a: '$12 345,67',
  },
  ...ROWS.slice(4),
  {
    day: '28 грудня 2025',
    d: '28.12.2025',
    from: 'Рахунок компанії',
    to: 'Розробник 2',
    type: 'SALARY',
    project: 'Бета',
    st: 'PAID',
    a: '$1 980,00',
    month: 'Грудень 2025',
  },
]
const longM = (w, h) => phoneTab(w, h, { body: `${searchAndFilters()}${dayList(LONG)}${END}` })
const longD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, total: LONG.length })}${table(LONG, { w, sel: -1 })}${pager(1, LONG.length, LONG.length)}`,
  })

export { title, TYPE, row, phone, topBar, TABBAR_H, txCount }

export function stateFrames() {
  const pair = (name, m, d) => [
    M(`${name}-375`, 375, 812, m(375, 812)),
    D(`${name}-1440`, 1440, 900, d(1440, 900)),
  ]
  return [
    ...pair('loading', loadingM, loadingD),
    ...pair('empty', emptyM, emptyD),
    ...pair('filtered', filteredM, filteredD),
    M('filtered-320', 320, 568, filtered320(320, 568)),
    ...pair('error', errorM, errorD),
    M('error-320', 320, 568, errorM(320, 568)),
    ...pair('offline', offlineM, offlineD),
    ...pair('offline-cold', offlineColdM, offlineColdD),
    ...pair('partial', partialM, partialD),
    ...pair('filters', filtersM, filtersD),
    M('filters-320', 320, 568, filtersM(320, 568)),
    ...pair('drafts', draftsM, draftsD),
    M('drafts-unknown-375', 375, 812, draftsUnknownM(375, 812)),
    ...pair('deleted', deletedM, deletedD),
    M('deleted-320', 320, 1462, deletedM(320, 1462), true),
    M('long-320', 320, 1526, longM(320, 1526), true),
    D('long-1440', 1440, 900, longD(1440, 900)),
  ]
}
