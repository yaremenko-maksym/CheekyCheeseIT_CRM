// Finance list (Task 1.2): role variants and single interaction frames (pull-to-refresh, detail push,
// swipe, desktop row menu, the DROP state set). Every name and amount below is invented seed-like data.
import { icon, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { tabScreen, topBar } from '../../../_foundation/assets/src/mobile.mjs'
import { skeletonList, stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { detailActions } from '../../../_foundation/assets/src/prims-mobile.mjs'
import {
  ROWS,
  M,
  D,
  row,
  dayList,
  searchAndFilters,
  desktopFrame,
  toolbar,
  table,
  pager,
  pill,
  COMPANY,
  listScreen,
  txCount,
} from './finance-list.mjs'

const screen = (w, h, role, body, extra = {}) =>
  listScreen({ w, h, role, active: '/finance', title: 'Фінанси', body, ...extra })

// ---------- Pull-to-refresh (refreshing stage; the list stays, it never blanks) ----------
const SPINNER = `<svg width="26" height="26" viewBox="0 0 24 24" role="progressbar" aria-label="Оновлення"><g stroke="var(--fg)" stroke-width="2.2" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => `<line x1="12" y1="3" x2="12" y2="7" opacity="${0.2 + i * 0.1}" transform="rotate(${i * 45} 12 12)"/>`).join('')}</g></svg>`
const ptrM = (w, h) =>
  screen(
    w,
    h,
    'ADMIN',
    `<div style="position:relative"><div style="position:absolute;left:0;right:0;top:4px;display:grid;place-items:center">${SPINNER}</div><div style="transform:translateY(48px)">${searchAndFilters()}${dayList(ROWS.slice(0, 5))}</div></div>`,
  )

// ---------- Detail (pushed page on phone, pane at ≥ 900, side panel on desktop): one body ----------
const kv = (k, v, { link = false } = {}) =>
  `<${link ? 'a href="#"' : 'div'} class="lrow" style="--inset:16px;min-height:52px"><div class="t-body muted" style="flex:none">${k}</div><div class="grow t-body" style="text-align:right;overflow-wrap:anywhere">${v}</div>${link ? icon('chevron-right', { size: 18, cls: 'chev' }) : ''}</${link ? 'a' : 'div'}>`
export const DETAIL = ROWS[3]
export const detailBody = (x = DETAIL, { banner = '' } = {}) => {
  const head = `<div class="col" style="align-items:center;gap:6px;padding:8px 16px 18px;text-align:center"><h1 class="t-sub muted" style="margin:0;font-weight:400">${x.to}</h1><div class="num" style="font-size:40px;line-height:46px;font-weight:700;letter-spacing:-0.03em;white-space:nowrap">${x.a}</div>${pill(x.st).replace('vertical-align:middle', 'height:28px;padding:0 12px;font-size:13px')}</div>`
  const parts = `<div class="group">${kv('Тип', 'Зарплата')}${kv('Період', x.month)}${kv('Платник', x.from)}${kv('Отримувач', x.to, { link: true })}${kv('Дата', '16 листопада 2026')}${kv('Проєкт', `Проєкт «${x.project}»`, { link: true })}${kv('Створив', 'Адмін Демо')}</div>`
  const receipt = `<div class="sechead"><span class="t-over">Чек</span></div><div class="group"><div class="lrow" role="button" style="min-height:52px;color:var(--primary)">${icon('paperclip', { size: 18 })}<span class="grow t-body">Прикріпити чек</span></div></div>`
  const actions = `<div class="col" style="gap:10px;padding:20px 0 8px"><span class="btn primary" style="width:100%">Розрахуватися</span><span class="btn secondary" style="width:100%">Додати частину зарплати</span></div>`
  return `${banner}${head}${parts}${receipt}${actions}`
}
const detailM = (w, h) =>
  phone({
    w,
    h,
    inner: `${topBar({ back: true, title: '', bell: false, search: false, trailing: detailActions })}<div class="content" style="padding:0 16px ${safeBottom(w) + 24}px">${detailBody()}</div>`,
  })

// ---------- Swipe: trailing edge only, the viewer's primary action first (§6.2) ----------
const TILE = {
  primary: 'background:var(--primary);color:var(--primary-fg)',
  edit: 'background:oklch(0.42 0.02 250);color:var(--fg)',
  del: 'background:var(--destructive);color:#fff',
}
const tile = ([label, ic, tone]) =>
  `<div class="col" role="button" style="width:84px;height:100%;${TILE[tone]};justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600;text-align:center;line-height:14px;padding:0 4px">${icon(ic, { size: 18 })}${label}</div>`
export const swiped = (x, tiles) =>
  `<div class="lrow two" style="padding:0;overflow:hidden;position:relative"><div class="row" style="position:absolute;right:0;top:0;bottom:0">${tiles.map(tile).join('')}</div>
    <div style="width:100%;transform:translateX(-${tiles.length * 84}px);background:var(--card)">${row(x).replace('class="lrow two"', 'class="lrow two" style="background:var(--card)"')}</div></div>`
const swipeList = (head, rows, i, tiles, rest = '') =>
  `${head}<div class="sechead sticky" role="heading" aria-level="2"><span class="t-over">${rows[0].day}</span></div><div class="group" role="list">${rows.map((x, k) => (k === i ? swiped(x, tiles) : row(x))).join('')}</div>${rest}`
const swipeM = (w, h) =>
  screen(
    w,
    h,
    'ADMIN',
    swipeList(
      searchAndFilters(),
      ROWS.slice(0, 3),
      1,
      [
        ['Валідувати', 'check', 'primary'],
        ['Змінити', 'pencil', 'edit'],
        ['Видалити', 'trash-2', 'del'],
      ],
      dayList(ROWS.slice(3, 6)),
    ),
  )

// ---------- Desktop row menu: every action of the row; the primary carries `A` (A-4) ----------
const rowMenuD = (w, h) => {
  const wide = w >= 1280
  const primary = ['hand-coins', 'Розрахуватися', 'A']
  const open = ['arrow-up-right', 'Відкрити', 'Enter']
  const items = [
    ...(wide ? [open, primary] : [primary, open]),
    ['plus', 'Додати частину зарплати'],
    ['paperclip', 'Прикріпити чек'],
    ['pencil', 'Редагувати', 'E'],
  ]
  const rowH = wide ? 40 : 48
  const menu = `<div role="menu" aria-label="Дії з транзакцією" style="position:absolute;right:30px;top:${56 + 20 + 32 + 14 + 1 + 36 + 4 * rowH - 2}px;width:260px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px">${items
    .map(
      ([ic, t, k], i) =>
        `<div role="menuitem" class="row" style="gap:10px;height:34px;padding:0 10px;border-radius:8px;font-size:13px;${i === 0 ? 'background:var(--raised)' : ''}">${icon(ic, { size: 15 })}<span class="grow">${t}</span>${k ? `<span class="kbdkey">${k}</span>` : ''}</div>`,
    )
    .join(
      '',
    )}<div style="height:1px;background:var(--separator);margin:4px 0"></div><div role="menuitem" class="row" style="gap:10px;height:34px;padding:0 10px;border-radius:8px;font-size:13px;color:var(--destructive)">${icon('trash-2', { size: 15 })}<span class="grow">Видалити…</span></div></div>`
  return desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(ROWS, { w, sel: 3, menuFor: 3 })}${pager()}`,
    overlay: menu,
  })
}

// ---------- ACCOUNTANT: the `?status=PENDING` deep link lands on the validation queue ----------
export const PEND = [
  ROWS[1],
  { ...ROWS[3], act: 'Додати частину зарплати' },
  {
    day: '15 листопада',
    d: '15.11',
    from: 'Клієнт «Схід»',
    to: 'Ігор Демо',
    type: 'SENIOR_INCOME',
    project: 'Гамма',
    st: 'PENDING',
    a: '$2 900,00',
    act: 'Валідувати',
  },
  {
    day: '14 листопада',
    d: '14.11',
    from: 'Клієнт «Захід»',
    to: 'Олег Демо',
    type: 'SENIOR_INCOME',
    project: 'Альфа',
    st: 'PENDING',
    a: '$1 750,00',
    act: 'Валідувати',
  },
]
const accHead = () => searchAndFilters({ active: ['Статус: Очікує валідації'] })
const accM = (w, h) => screen(w, h, 'ACCOUNTANT', `${accHead()}${dayList(PEND)}`)
const accD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'ACCOUNTANT',
    body: `${toolbar({ w, status: 'Очікує валідації', deleted: false, count: '4 з 132' })}${table(PEND, { w, sel: 0 })}`,
  })
const swipeAccM = (w, h) =>
  screen(
    w,
    h,
    'ACCOUNTANT',
    swipeList(
      accHead(),
      PEND.slice(0, 1),
      0,
      [['Валідувати', 'check', 'primary']],
      dayList(PEND.slice(1)),
    ),
  )

// ---------- SENIOR: own projects; titles never show the viewer's own name (OP-12) ----------
// A VALIDATED income with no payout request still needs the senior, so it shows its pill (OP-7).
export const SEN = [
  {
    ...ROWS[1],
    t: 'Клієнт «Північ»',
    st: 'VALIDATED',
    showPill: true,
    act: 'Виплатити',
    usd: 4800,
  },
  {
    day: 'Вчора',
    d: '16.11',
    from: 'Клієнт «Схід»',
    to: 'Олег Демо',
    t: 'Клієнт «Схід»',
    type: 'SENIOR_INCOME',
    project: 'Гамма',
    st: 'VALIDATED',
    showPill: true,
    a: '$2 600,00',
    act: 'Виплатити',
    usd: 2600,
  },
  { ...ROWS[4], t: COMPANY, sub: COMPANY, act: 'Оплатити' },
  {
    day: '14 листопада',
    d: '14.11',
    from: 'Клієнт «Захід»',
    to: 'Олег Демо',
    t: 'Клієнт «Захід»',
    type: 'SENIOR_INCOME',
    project: 'Альфа',
    st: 'REJECTED',
    a: '$1 750,00',
    act: 'Виправити',
  },
  {
    day: '13 листопада',
    d: '13.11',
    from: 'Клієнт «Північ»',
    to: 'Олег Демо',
    t: 'Клієнт «Північ»',
    type: 'SENIOR_INCOME',
    project: 'Бета',
    st: 'PAID',
    a: '$3 100,00',
  },
]
// Company share 20 % of the two VALIDATED incomes not yet in a payout request: (4 800 + 2 600) × 0,2.
export const SEN_SHARE = { pct: 0.2, value: 1480, label: '$1 480,00' }
const strip = (wide = false) =>
  `<div class="row" style="gap:12px;${wide ? '' : 'margin:0 16px 10px;'}padding:12px 12px 12px 16px;border-radius:14px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);flex-wrap:wrap"><div class="grow col" style="gap:3px;min-width:180px"><div class="row" style="gap:8px;flex-wrap:wrap"><span style="font-size:${wide ? 14 : 15}px;font-weight:600">Частка CheekyCheeseIT до сплати</span><span class="pill warn" style="height:20px;font-size:11px">2 проєкти</span></div><span class="num" style="font-size:${wide ? 20 : 22}px;font-weight:700">${SEN_SHARE.label}</span><span class="t-foot muted">За перевіреними доходами, які ще не включено в заявку на виплату</span></div><span class="btn primary" style="height:44px;${wide ? '' : 'width:100%'}">Оплатити</span></div>`
const payBtn = `<div style="padding:0 16px 10px"><span class="btn secondary" style="width:100%;height:44px">${icon('wallet', { size: 18 })}Виплатити (2)</span></div>`
const senM = (w, h) =>
  screen(w, h, 'SENIOR', `${strip()}${payBtn}${searchAndFilters()}${dayList(SEN)}`)
const senD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'SENIOR',
    actions: `<span class="btn secondary" style="height:36px;font-size:14px;padding:0 12px;border-radius:9px">${icon('wallet', { size: 16 })}Виплатити (2)</span><span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Нова транзакція<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span></span>`,
    body: `${strip(true)}${toolbar({ w, total: SEN.length })}${table(SEN, { w, sel: -1 })}`,
  })
const swipeSenM = (w, h) =>
  screen(
    w,
    h,
    'SENIOR',
    swipeList(
      searchAndFilters(),
      SEN.slice(0, 1),
      0,
      [['Виплатити', 'wallet', 'primary']],
      dayList(SEN.slice(1)),
    ),
  )

// ---------- HR: own salary only, reached from «Ще» (pushed page, no create) ----------
// «Дата» keeps today's label and value: the business date, present on unpaid rows too (R1-13).
// Phone shows the year only for another year (M12); the desktop column shows the full date.
export const SAL = [
  ['Листопад 2026', '17.11.2026', 'PENDING', '$1 300,00'],
  ['Жовтень 2026', '05.11.2026', 'PAID', '$1 300,00'],
  ['Вересень 2026', '06.10.2026', 'PAID', '$1 300,00'],
  ['Серпень 2026', '05.09.2026', 'PAID', '$1 250,00'],
  ['Липень 2026', '05.08.2026', 'PAID', '$1 250,00'],
]
const shortDate = (d) => (d.endsWith('.2026') ? d.slice(0, 5) : d)
const salRow = ([m, d, st, a], extra = '') =>
  `<div class="lrow two" role="link" style="--inset:64px"><div class="lead">${icon('wallet', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px"><div class="t-body grow" style="font-weight:500">${m}</div><span class="amount">${a}</span></div><div class="t-foot muted trunc">Зарплата · <span class="num">${shortDate(d)}</span>${extra}</div>${st === 'PAID' ? '' : `<div style="margin-top:3px">${pill(st, { small: true })}</div>`}</div></div>`
const hrM = (w, h) =>
  phone({
    w,
    h,
    inner: `${topBar({ back: true, title: 'Фінанси', search: false })}<div class="content" style="padding-top:8px"><div class="group" role="list">${SAL.map((s) => salRow(s)).join('')}</div><div style="height:${safeBottom(w) + 24}px"></div></div>`,
  })
const simpleTable = (head, rows, label = 'Виплати') =>
  `<div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"><table style="width:100%;border-collapse:separate;border-spacing:0" aria-label="${label}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
const hrD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'HR',
    actions: '',
    body: simpleTable(
      '<th>Місяць</th><th>Дата</th><th>Статус</th><th class="r">Сума</th>',
      SAL.map(
        ([m, d, st, a], i) =>
          `<tr ${i === 1 ? 'class="hover"' : ''}><td>${m}</td><td class="num muted">${d}</td><td>${pill(st)}</td><td class="r"><span class="amount" style="font-size:14px">${a}</span></td></tr>`,
      ).join(''),
    ),
  })

// ---------- JUNIOR: own salary with project; the tx hash shows `slice(0,14)` + «…» and copies ----------
const JUN = SAL.map((s, i) => [
  ...s,
  ['Альфа', 'Альфа', 'Бета', 'Бета', 'Бета'][i],
  i === 0 ? '' : `0x7f3a${i}c9e1b2d48a0e5f`.slice(0, 14),
])
const junM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'JUNIOR',
    active: '/finance',
    title: 'Фінанси',
    body: `<div class="group" role="list" style="margin-top:4px">${JUN.map((s) => salRow(s, ` · Проєкт «${s[4]}»`)).join('')}</div>`,
  })
const copyBtn = `<span class="iconbtn" role="button" aria-label="Копіювати хеш" style="width:28px;height:28px">${icon('copy', { size: 14 })}</span>`
const hashCell = (hash) =>
  hash
    ? `<span class="row" style="gap:4px" title="${hash}…"><span class="num muted" style="font-family:ui-monospace,monospace;font-size:12px">${hash}…</span>${copyBtn}</span>`
    : '<span class="muted">—</span>'
const junD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'JUNIOR',
    actions: '',
    body: simpleTable(
      '<th class="r">Сума</th><th>Проєкт</th><th>Місяць</th><th>Дата</th><th>Статус</th><th>Хеш транзакції</th>',
      JUN.map(
        ([m, d, st, a, p, hash]) =>
          `<tr><td class="r"><span class="amount" style="font-size:14px">${a}</span></td><td class="muted">${p}</td><td>${m}</td><td class="num muted">${d}</td><td>${pill(st)}</td><td>${hashCell(hash)}</td></tr>`,
      ).join(''),
    ),
  })

// ---------- DROP: balance, own incomes, transfers to the company account ----------
// Model labels as in code: declared → «Дохід» + «Валовий дохід»; obligation → «Зобов’язання»
// (renamed from «Нарахування», A-6) + «Ваша частка». Balance figures add up to the rows (§5):
// Отримано = paid obligations, Очікує розрахунку = validated obligations, У роботі = pending declared.
export const DINC = [
  { d: '14.11', c: 'Клієнт «Захід»', model: 'declared', st: 'pending', usd: 3400, a: '$3 400,00' },
  { d: '12.11', c: 'Клієнт «Північ»', model: 'declared', st: 'pending', usd: 1800, a: '$1 800,00' },
  { d: '10.11', c: 'Клієнт «Схід»', model: 'obligation', st: 'validated', usd: 360, a: '$360,00' },
  { d: '06.11', c: 'Клієнт «Захід»', model: 'obligation', st: 'validated', usd: 890, a: '$890,00' },
  { d: '02.11', c: 'Клієнт «Схід»', model: 'obligation', st: 'paid', usd: 2400, a: '$2 400,00' },
  { d: '28.10', c: 'Клієнт «Північ»', model: 'obligation', st: 'paid', usd: 6000, a: '$6 000,00' },
]
export const DROP_BALANCE = {
  received: { usd: 8400, label: '$8 400,00' },
  awaiting: { usd: 1250, label: '$1 250,00', count: 2, unit: 'зобов’язання' },
  inWork: { count: 2, label: '2 доходи' },
  share: '30%',
  debt: '$300,00', // server `debtToCompany`, not derived from the rows
}
const MODEL = { declared: ['Дохід', 'Валовий дохід'], obligation: ['Зобов’язання', 'Ваша частка'] }
const DST = {
  pending: ['Очікує', 'warn'],
  validated: ['Валідовано', 'ok'],
  paid: ['Оплачено', 'ok'],
  rejected: ['Відхилено', 'err'],
}
const dPill = ([label, tone], small = true) =>
  `<span class="pill ${tone}" style="${small ? 'height:18px;font-size:11px;padding:0 6px;' : ''}vertical-align:middle">${label}</span>`
export const DPAY = [
  { d: '16.11', a: '$300,00', st: ['Очікує', 'warn'], hash: '0x51be2a7c90d4' },
  { d: '01.11', a: '$640,00', st: ['Підтверджено', 'ok'], hash: '0x9c04d1e7a3f2' },
  { d: '20.10', a: '$210,00', st: ['Не пройшов', 'err'], hash: '0x2e7f6b18c5a9' },
]
const FAILED_LINE = 'Переказ не пройшов — зверніться до адміністратора'
const stat = (k, v, sub = '') =>
  `<div class="col" style="gap:2px;min-width:0"><span class="t-foot muted">${k}</span><span class="num" style="font-size:18px;font-weight:700">${v}</span>${sub ? `<span class="t-foot muted">${sub}</span>` : ''}</div>`
const balance = (wide = false, { zero = false } = {}) => {
  const b = DROP_BALANCE
  const debt = zero
    ? ''
    : `<div class="row" style="gap:10px;margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border)"><span style="color:var(--warning);display:grid">${icon('circle-alert', { size: 16 })}</span><div class="grow col" style="gap:1px"><span style="font-size:14px;font-weight:600">Ви маєте сплатити компанії <span class="num">${b.debt}</span></span><span class="t-foot muted">Підтверджені доходи, які ви ще не перерахували</span></div></div>`
  return `<section aria-label="Мій баланс" style="${wide ? '' : 'margin:0 16px 12px;'}padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-head" style="font-size:15px;margin-bottom:10px">Мій баланс</div><div style="display:grid;grid-template-columns:repeat(${wide ? 4 : 2},minmax(0,1fr));gap:12px 16px">${stat('Отримано', zero ? '$0,00' : b.received.label)}${stat('Очікує розрахунку', zero ? '$0,00' : b.awaiting.label, zero ? '' : `${b.awaiting.count} ${b.awaiting.unit}`)}${stat('Частка', b.share)}${stat('У роботі', zero ? '0 доходів' : b.inWork.label)}</div>${debt}</section>`
}
const balanceError = `<section aria-label="Мій баланс" role="alert" class="row" style="gap:10px;margin:0 16px 12px;padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><span style="color:var(--destructive);display:grid">${icon('cloud-alert', { size: 18 })}</span><span class="grow t-body">Помилка завантаження балансу</span><span class="iconbtn" role="button" aria-label="Повторити спробу" style="width:44px;height:44px">${icon('rotate-cw', { size: 18 })}</span></section>`
const dropIncRow = (x) => {
  const [badge, sub] = MODEL[x.model]
  return `<div class="lrow two" role="link" style="--inset:64px"><div class="lead">${icon('arrow-down-left', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px;align-items:flex-start"><div class="t-body grow" style="font-weight:500">${x.c}</div><span class="col" style="align-items:flex-end"><span class="amount">${x.a}</span><span class="t-cap muted">${sub}</span></span></div><div class="t-foot muted trunc"><span class="num">${x.d}</span> · ${badge}</div>${x.st === 'paid' ? '' : `<div style="margin-top:3px">${dPill(DST[x.st])}</div>`}</div></div>`
}
const dropPayRow = (x) =>
  `<div class="lrow two" style="--inset:64px"><div class="lead">${icon('arrow-up-right', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px"><span class="t-body grow" style="font-weight:500">Переказ на рахунок компанії</span><span class="amount">${x.a}</span></div><div class="t-foot muted trunc"><span class="num">${x.d}</span> · <span class="num" style="font-family:ui-monospace,monospace">${x.hash}…</span></div><div class="row" style="gap:6px;margin-top:3px;flex-wrap:wrap">${dPill(x.st)}${x.st[1] === 'err' ? `<span class="t-foot" style="color:var(--fg)">${FAILED_LINE}</span>` : ''}</div></div></div>`
const sec = (t) =>
  `<div class="sechead" role="heading" aria-level="2"><span class="t-over">${t}</span></div>`
const dropChip = (label) =>
  `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:44px;padding:0 12px 0 14px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;background:var(--surface);border:1px solid var(--border)">${label}${icon('chevron-down', { size: 15 })}</span>`
const dropFilters = `<div class="row" style="gap:8px;padding:0 16px 6px">${dropChip('Усі статуси')}${dropChip('Усі періоди')}</div>`
const inlineError = (title) =>
  `<div role="alert" class="col" style="align-items:center;gap:8px;margin:0 16px;padding:20px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border);text-align:center"><span style="color:var(--destructive);display:grid">${icon('cloud-alert', { size: 22 })}</span><span class="t-body" style="font-weight:500">${title}</span><span class="btn secondary" style="height:44px">${icon('rotate-cw', { size: 18 })}Повторити</span></div>`
const dropScreen = (w, h, body) =>
  tabScreen({ w, h, role: 'DROP', active: '/finance', title: 'Фінанси', body }).replace(
    /(<div class="fab" role="button" aria-label=")[^"]*"/,
    '$1Зареєструвати дохід"',
  )
const incomes = `<div class="group" role="list" style="margin-top:6px">${DINC.map(dropIncRow).join('')}</div>`
const transfers = `<div class="group" role="list">${DPAY.map(dropPayRow).join('')}</div>`
const dropM = (w, h) =>
  dropScreen(
    w,
    h,
    `${balance()}${sec('Мої доходи')}${dropFilters}${incomes}${sec('Перекази на рахунок компанії')}${transfers}`,
  )
const dropLoadingM = (w, h) =>
  dropScreen(
    w,
    h,
    `<div role="status" aria-label="Завантаження" style="display:contents"><div style="margin:0 16px 12px;padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="sk" style="width:110px;height:14px;margin-bottom:14px"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 16px">${'<div class="col" style="gap:6px"><div class="sk" style="width:70px;height:11px"></div><div class="sk" style="width:96px;height:18px"></div></div>'.repeat(4)}</div></div>${sec('Мої доходи')}${skeletonList(4)}</div>`,
  )
const dropEmptyM = (w, h) =>
  dropScreen(
    w,
    h,
    `${balance(false, { zero: true })}${sec('Мої доходи')}${stateBlock({ ic: 'arrow-down-left', title: 'Доходів ще немає' })}${sec('Перекази на рахунок компанії')}<div class="t-body muted" style="padding:4px 16px 16px">Переказів ще не було</div>`,
  )
const dropErrorM = (w, h) =>
  dropScreen(
    w,
    h,
    `${balance()}${sec('Мої доходи')}${dropFilters}${inlineError('Не вдалося завантажити доходи')}${sec('Перекази на рахунок компанії')}${transfers}`,
  )
const dropPartialM = (w, h) =>
  dropScreen(
    w,
    h,
    `${balanceError}${sec('Мої доходи')}${dropFilters}${incomes}${sec('Перекази на рахунок компанії')}${inlineError('Не вдалося завантажити перекази')}`,
  )
const dCopy = copyBtn
const dropD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'DROP',
    actions: `<span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Зареєструвати дохід</span>`,
    body: `${balance(true)}<div class="row" style="gap:8px;flex:none"><h2 class="t-over grow" style="margin:0">Мої доходи</h2>${['Усі статуси', 'Усі періоди'].map((l) => `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:32px;padding:0 10px;border-radius:8px;font-size:13px;border:1px solid var(--input-border);color:var(--muted-fg)">${l}${icon('chevron-down', { size: 13 })}</span>`).join('')}</div>${simpleTable(
      '<th>Дата</th><th>Компанія</th><th>Тип</th><th>Статус</th><th class="r">Сума</th>',
      DINC.map(
        (x) =>
          `<tr><td class="num muted">${x.d}</td><td>${x.c}</td><td class="muted">${MODEL[x.model][0]}</td><td>${dPill(DST[x.st], false)}</td><td class="r"><span class="amount" style="font-size:14px">${x.a}</span><div class="t-cap muted" style="line-height:12px">${MODEL[x.model][1]}</div></td></tr>`,
      ).join(''),
      'Мої доходи',
    ).replace(
      'class="grow"',
      'style="flex:none"',
    )}<h2 class="t-over" style="margin:6px 0 0">Перекази на рахунок компанії</h2>${simpleTable(
      '<th>Дата</th><th>Хеш транзакції</th><th>Статус</th><th class="r">Сума</th>',
      DPAY.map(
        (x) =>
          `<tr><td class="num muted">${x.d}</td><td>${hashCell(x.hash).replace(copyBtn, dCopy)}</td><td class="wrap"><span class="row" style="gap:8px;flex-wrap:wrap">${dPill(x.st, false)}${x.st[1] === 'err' ? `<span class="t-foot">${FAILED_LINE}</span>` : ''}</span></td><td class="r num">${x.a}</td></tr>`,
      ).join(''),
      'Перекази на рахунок компанії',
    ).replace('class="grow"', 'style="flex:none"')}`,
  })

export { txCount }

export function roleFrames() {
  const pair = (name, m, d) => [
    M(`${name}-375`, 375, 812, m(375, 812)),
    D(`${name}-1440`, 1440, 900, d(1440, 900)),
  ]
  return [
    M('ptr-375', 375, 812, ptrM(375, 812)),
    M('detail-375', 375, 812, detailM(375, 812)),
    M('swipe-375', 375, 812, swipeM(375, 812)),
    M('swipe-accountant-375', 375, 812, swipeAccM(375, 812)),
    M('swipe-senior-375', 375, 812, swipeSenM(375, 812)),
    D('row-menu-1024', 1024, 768, rowMenuD(1024, 768)),
    D('row-menu-1440', 1440, 900, rowMenuD(1440, 900)),
    ...pair('role-accountant', accM, accD),
    ...pair('role-senior', senM, senD),
    ...pair('role-hr', hrM, hrD),
    ...pair('role-junior', junM, junD),
    ...pair('role-drop', dropM, dropD),
    M('drop-loading-375', 375, 812, dropLoadingM(375, 812)),
    M('drop-empty-375', 375, 812, dropEmptyM(375, 812)),
    M('drop-error-375', 375, 812, dropErrorM(375, 812)),
    M('drop-partial-375', 375, 812, dropPartialM(375, 812)),
  ]
}
