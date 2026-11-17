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
  TYPE,
  STATUS,
  M,
  D,
  row,
  dayList,
  searchAndFilters,
  desktopFrame,
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
const loadingM = (w, h) =>
  phoneTab(w, h, {
    body: `<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${searchAndFilters()}${skeletonList(3)}${skeletonList(4)}</div>`,
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
    body: `${toolbar({ w, deleted: false, count: '<span class="sk" style="display:inline-block;width:80px;height:11px"></span>' })}<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${table([], { w }).replace('<tbody></tbody>', `<tbody>${skTableRows(12)}</tbody>`)}</div>`,
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
const filteredM = (w, h, active = ['Статус: Відхилено']) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ q: 'оренда', active })}${stateBlock(FILTERED)}`,
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
const errorM = (w, h) => phoneTab(w, h, { body: `${searchAndFilters()}${stateBlock(ERROR)}` })
const errorD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, count: '—' })}${dCard(stateBlock(ERROR))}`,
  })

// ---------- Offline: the cached list stays readable; every action stays enabled (M4) ----------
// A write attempted offline ends in the definite alert inside its dialog; nothing is disabled here.
const OFFLINE_TEXT =
  'Немає з’єднання. Показано останні завантажені дані; збереження не пройде, введене залишиться у формі.'
const offlineM = (w, h) =>
  phoneTab(w, h, { body: `${offlineBanner()}${searchAndFilters()}${dayList(ROWS)}` })
const offlineD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${dNotice(OFFLINE_TEXT, { ic: 'wifi-off', tone: 'var(--warning)' })}${toolbar({ w, deleted: false })}${table(ROWS, { w, sel: -1, hover: 1 })}${pager()}`,
  })

// ---------- Partial: the rates query failed; amounts stay in the transaction currency ----------
// The converted row shows its own amount; USD / USDT rows are unchanged. Amount sort is disabled.
export const RATES_OFF = ROWS.map((r) => (r.orig ? { ...r, a: r.orig, orig: undefined } : r))
const RATES_TEXT = 'Курс недоступний — суми показано у валюті транзакції.'
const partialM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${notice(RATES_TEXT, { ic: 'circle-alert', tone: 'var(--warning)', action: retry })}${dayList(RATES_OFF)}`,
  })
const partialD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${dNotice(RATES_TEXT, { ic: 'circle-alert', tone: 'var(--warning)', action: retry.replace('height:44px', 'height:28px') })}${toolbar({ w, deleted: false })}${table(RATES_OFF, { w, sel: -1, sortOff: true })}${pager()}`,
  })

// ---------- Filters: phone bottom sheet (URL-held); desktop listbox ----------
const pickRow = (k, v) =>
  `<div class="lrow" role="button" aria-haspopup="dialog" style="min-height:52px"><div class="grow t-body">${k}</div><span class="muted t-sub trunc" style="max-width:58%">${v}</span>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
export const filterBody = ({ deleted = true } = {}) =>
  `<div class="group">${pickRow('Тип', 'Усі типи')}${pickRow('Статус', 'Очікує валідації')}${pickRow('Сортування', 'Спочатку нові')}</div>
  ${deleted ? `<div class="group" style="margin-top:14px"><div class="lrow" style="min-height:52px"><div class="grow t-body">Показати видалені</div>${toggle(false, 'Показати видалені')}</div></div>` : ''}`
export const SHOW_N = 'Показати 18 транзакцій'
const filterSheet = (w, h, { deleted = true } = {}) =>
  sheet({
    w,
    h,
    top: Math.round(h * (w <= 320 ? 0.22 : 0.5)),
    title: 'Фільтри',
    lead: '<span style="font-size:17px">Скинути</span>',
    trail: closeBtn,
    body: filterBody({ deleted }),
    footer: `<div style="padding:12px 16px ${safeBottom(w) + 8}px"><span class="btn primary" style="width:100%">${SHOW_N}</span></div>`,
  })
export const PENDING_ROWS = ROWS.filter((r) => r.st === 'PENDING')
const filtersM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['Статус: Очікує валідації'] })}${dayList(PENDING_ROWS)}`,
    overlay: filterSheet(w, h),
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
    body: `${toolbar({ w, status: 'Очікує валідації', deleted: false, count: '18 з 132' })}${table(
      PENDING_ROWS,
      { w, sel: -1 },
    )}`,
    overlay: statusMenu(248 + 24 + (w >= 1280 ? 300 : 220) + 8 + 92 + 8),
  })

// ---------- Drafts: a kept money draft pins above the list; the create entry carries the dot ----------
const draftsM = (w, h) =>
  draftFab(
    phoneTab(w, h, {
      body: `${searchAndFilters()}${pinnedRows([DRAFT.failed])}${dayList(ROWS)}`,
    }),
  )
// Four kept drafts (shell v2 §4): unresolved first, two rows, then «Ще 2 чернетки · Показати».
const draftsUnknownM = (w, h) =>
  draftFab(
    phoneTab(w, h, {
      body: `${searchAndFilters()}${pinnedRows([DRAFT.armed, DRAFT.failed2, DRAFT.inflight, DRAFT.unknown])}${dayList(ROWS)}`,
    }),
    2,
  )
const WARN = (p) => `color-mix(in oklch, var(--destructive) ${p}%, transparent)`
const draftTr = `<tr><td colspan="7" style="padding:0;max-width:none;background:${WARN(7)};box-shadow:inset 2px 0 0 var(--destructive)"><div class="row" style="gap:10px;height:40px;padding:0 8px 0 12px"><span style="color:var(--destructive);display:grid">${icon('file-pen', { size: 16 })}</span><span class="num" style="font-weight:600;white-space:nowrap">${AMOUNT} USD</span><span class="grow muted trunc">Не збережено · Витрата</span><button type="button" class="btn sm secondary" aria-label="Відкрити чернетку ${AMOUNT} USD" style="height:28px;font-size:13px;padding:0 12px;background:${WARN(18)};border-color:${WARN(45)}">Відкрити</button></div></td></tr>`
const DOT =
  '<i aria-hidden="true" style="position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--bg)"></i>'
const draftsD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(ROWS, { w, sel: -1 }).replace('<tbody>', `<tbody>${draftTr}`)}${pager()}`,
  })
    .replace(
      '<span class="btn primary" style="height:36px',
      '<span class="btn primary" aria-label="Нова транзакція, 1 чернетка потребує уваги" style="position:relative;height:36px',
    )
    .replace('C</span></span></header>', `C</span>${DOT}</span></header>`)

// ---------- Show deleted (ADMIN / ACCOUNTANT only): the «Видалено» pill takes the status slot ----------
export const WITH_DELETED = ROWS.map((r, i) =>
  i === 2 || i === 7 ? { ...r, deleted: true, act: 'Відновити' } : r,
)
const deletedM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['З видаленими'] })}${dayList(WITH_DELETED)}`,
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
    act: 'Валідувати',
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
    d: '28.12.25',
    from: 'Рахунок компанії',
    to: 'Розробник 2',
    type: 'SALARY',
    project: 'Бета',
    st: 'PAID',
    a: '$1 980,00',
    month: 'Грудень 2025',
  },
]
const longM = (w, h) => phoneTab(w, h, { body: `${searchAndFilters()}${dayList(LONG)}` })
const longD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(LONG, { w, sel: -1 })}${pager()}`,
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
