// Finance list (Task 1.2): role variants and single interaction frames (pull-to-refresh, detail push,
// swipe, desktop row menu, the DROP state set). Every name and amount below is invented seed-like data.
import { icon, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { tabScreen, topBar } from '../../../_foundation/assets/src/mobile.mjs'
import { skeletonList, stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { detailActions } from '../../../_foundation/assets/src/prims-mobile.mjs'
import {
  ROWS,
  PAGE,
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
  title,
  TYPE,
  COMPANY,
  listScreen,
  txCount,
  usd,
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
// The body scrolls; the actions sit in a sticky footer above the safe area (P8). After an unknown
// outcome the money actions are `aria-disabled` with the reason until «Оновити» settles the state or
// the user presses «Зрозуміло» (P1).
const kv = (k, v, { link = false } = {}) =>
  `<${link ? 'a href="#"' : 'div'} class="lrow" style="--inset:16px;min-height:52px"><div class="t-body muted" style="flex:none">${k}</div><div class="grow t-body" style="text-align:right;overflow-wrap:anywhere">${v}</div>${link ? icon('chevron-right', { size: 18, cls: 'chev' }) : ''}</${link ? 'a' : 'div'}>`
export const DETAIL = {
  ...ROWS[3],
  acts: ['Розрахуватися', 'Додати частину зарплати'],
  date: '16 листопада 2026',
  cur: 'USD',
}
export const BLOCKED_REASON = 'Недоступно: результат попередньої дії ще невідомий'
export const detailBody = (x = DETAIL) => {
  const head = `<div class="col" style="align-items:center;gap:6px;padding:8px 16px 18px;text-align:center"><h1 class="t-sub muted" style="margin:0;font-weight:400">${title(x)}</h1><div class="num" style="font-size:40px;line-height:46px;font-weight:700;letter-spacing:-0.03em;white-space:nowrap">${x.a}</div>${x.orig ? `<div class="t-foot muted num">${x.orig}</div>` : ''}${pill(x.st).replace('vertical-align:middle', 'height:28px;padding:0 12px;font-size:13px')}</div>`
  const rows = [
    kv('Тип', TYPE[x.type][0]),
    x.month ? kv('Період', x.month) : '',
    kv('Платник', x.payer ?? x.from),
    kv('Отримувач', x.payee ?? x.to, { link: !x.payee }),
    kv('Валюта', x.cur ?? 'USD'),
    ...(x.extra ?? []).map(([k, v]) => kv(k, v)),
    kv('Дата', x.date ?? '16 листопада 2026'),
    x.project && x.project !== '—' ? kv('Проєкт', `Проєкт «${x.project}»`, { link: true }) : '',
    kv('Створив', x.by ?? 'Адмін Демо'),
  ].join('')
  const receipt = x.noReceipt
    ? ''
    : `<div class="sechead"><span class="t-over">Чек</span></div><div class="group"><div class="lrow" role="button" style="min-height:52px;color:var(--primary)">${icon('paperclip', { size: 18 })}<span class="grow t-body">Прикріпити чек</span></div></div>`
  return `${head}<div class="group">${rows}</div>${receipt}`
}
export const detailFooter = (x = DETAIL, { blocked = false, bottom = 16 } = {}) => {
  const acts = x.acts ?? (x.act ? [x.act] : [])
  if (!acts.length) return ''
  const btn = (t, i) =>
    `<span class="btn ${i ? 'secondary' : 'primary'}" ${blocked ? 'aria-disabled="true" aria-describedby="blk" ' : ''}style="width:100%;${blocked ? 'opacity:0.45' : ''}">${t}</span>`
  return `<div class="col" style="gap:10px;flex:none;padding:12px 16px ${bottom}px;border-top:1px solid var(--border);background:var(--bg)">${blocked ? `<span id="blk" class="t-foot muted" style="text-align:center">${BLOCKED_REASON}</span>` : ''}${acts.map(btn).join('')}</div>`
}
export const detailM = (w, h, { x = DETAIL, banner = '', blocked = false } = {}) =>
  phone({
    w,
    h,
    inner: `${topBar({ back: true, title: '', bell: false, search: false, trailing: detailActions })}<div class="content" style="padding:0 16px 16px">${banner}${detailBody(x)}</div>${detailFooter(x, { blocked, bottom: safeBottom(w) + 16 })}`,
  })

// ---------- Swipe: trailing edge only, the viewer's primary action first (§6.2) ----------
// The foundation tile draws the 12 px «Видалити» label on `--destructive` (3.58:1). This screen
// overrides it in its own source (P5): a darker red under the same white label; `contrast.mjs`
// measures every tile and `render.mjs` refuses to render below 4.5:1. OP-19: the foundation fixes
// the tile first, then this override is deleted.
export const TILE_BASE = { del: 'background:var(--destructive);color:#fff' }
export const TILE = {
  primary: 'background:var(--primary);color:var(--primary-fg)',
  edit: 'background:oklch(0.42 0.02 250);color:var(--fg)',
  del: 'background:oklch(0.55 0.19 25);color:#fff',
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

// ---------- Desktop row menu: every action of the row; one order at every width, primary first (A-4) ----------
// Fine pointer: 34 px items. Coarse pointer (any width): 44 px items (P11).
export const rowMenuD = (w, h, { coarse = false } = {}) => {
  const items = [
    ['wallet', 'Розрахуватися', 'A'],
    ['plus', 'Додати частину зарплати'],
    ['eye', 'Відкрити', 'Enter'],
    ['paperclip', 'Прикріпити чек'],
    ['pencil', 'Редагувати', 'E'],
  ]
  const rowH = coarse ? 52 : 48
  const itemH = coarse ? 44 : 34
  const toolH = coarse ? 44 : 32
  const menu = `<div role="menu" aria-label="Дії з транзакцією" style="position:absolute;right:30px;top:${56 + 20 + toolH + 14 + 1 + 36 + 4 * rowH - 2}px;width:${coarse ? 290 : 260}px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px">${items
    .map(
      ([ic, t, k], i) =>
        `<div role="menuitem" class="row" style="gap:10px;height:${itemH}px;padding:0 10px;border-radius:8px;font-size:${coarse ? 15 : 13}px;${i === 0 ? 'background:var(--raised)' : ''}">${icon(ic, { size: 15 })}<span class="grow">${t}</span>${k && !coarse ? `<span class="kbdkey">${k}</span>` : ''}</div>`,
    )
    .join(
      '',
    )}<div style="height:1px;background:var(--separator);margin:4px 0"></div><div role="menuitem" class="row" style="gap:10px;height:${itemH}px;padding:0 10px;border-radius:8px;font-size:${coarse ? 15 : 13}px;color:var(--destructive)">${icon('trash-2', { size: 15 })}<span class="grow">Видалити…</span></div></div>`
  const touch = (html) =>
    coarse ? html.replaceAll('height:32px', 'height:44px').replaceAll('width:32px', 'width:44px') : html
  return desktopFrame({
    w,
    h,
    body: `${touch(toolbar({ w, deleted: false }))}${table(PAGE, { w, sel: 3, menuFor: 3, coarse })}${touch(pager())}`,
    overlay: menu,
  })
}

// ---------- ACCOUNTANT: the `?status=PENDING` deep link lands on the validation queue ----------
// The same PENDING rows the ADMIN list holds (one fixture, P3). ACCOUNTANT cannot settle a salary
// (`canPaySalary` is ADMIN only) but can add a salary part (`canAddSalaryPart`): that label is longer
// than the inline cap, so on desktop it lives in «…» (P11).
export const PEND = PAGE.filter((r) => r.st === 'PENDING').map((r) =>
  r.type === 'SALARY' ? { ...r, act: 'Додати частину зарплати' } : r,
)
const accHead = () =>
  searchAndFilters({ active: ['Статус: Очікує валідації'], match: PEND.length })
const accM = (w, h) => screen(w, h, 'ACCOUNTANT', `${accHead()}${dayList(PEND)}`)
const accD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'ACCOUNTANT',
    body: `${toolbar({ w, status: 'Очікує валідації', deleted: false, count: `${PEND.length} з 132` })}${table(PEND, { w, sel: 0 })}`,
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
    dir: 'Клієнт «Північ» → Ви',
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
    dir: 'Клієнт «Схід» → Ви',
    type: 'SENIOR_INCOME',
    project: 'Гамма',
    st: 'VALIDATED',
    showPill: true,
    a: '$2 600,00',
    act: 'Виплатити',
    usd: 2600,
  },
  { ...ROWS[4], t: COMPANY, dir: `Ви → ${COMPANY}`, act: 'Оплатити' },
  {
    day: '14 листопада',
    d: '14.11',
    from: 'Клієнт «Захід»',
    to: 'Олег Демо',
    t: 'Клієнт «Захід»',
    dir: 'Клієнт «Захід» → Ви',
    reason: 'Сума не збігається з рахунком клієнта',
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
    dir: 'Клієнт «Північ» → Ви',
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
// Amounts are the salary's own currency with no «≈» and no conversion (P13): August was paid in UAH.
export const SAL = [
  ['Листопад 2026', '17.11.2026', 'PENDING', '$1 300,00'],
  ['Жовтень 2026', '05.11.2026', 'PAID', '$1 300,00'],
  ['Вересень 2026', '06.10.2026', 'PAID', '$1 300,00'],
  ['Серпень 2026', '05.09.2026', 'PAID', '51 562,50 UAH'],
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
// The JUNIOR page has no search, so no search icon either (P13): `listScreen` strips it.
const junM = (w, h) =>
  listScreen({
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
// The card shows SERVER figures (`computeDropAggregate`, P3), not sums of the rows on the page:
// - Отримано (`balance`) = PAID `PAYOUT_DROP` received by the drop − PAID `PAYOUT_DROP` sent by the
//   drop, each at today's rate. Those rows are not on this page, so the figure is a net, not a row sum.
// - Очікує розрахунку (`pendingObligationAmount` / `Count`) = the drop's `DROP_PENDING_PAYOUT` rows in
//   `PENDING_PAYMENT` (what the company owes the drop); not part of the balance.
// - У роботі (`pendingCount`) = the drop's `DROP_INCOME` rows in `PENDING` or `VALIDATED`.
// - The debt line (`debtToCompany`) = the drop's `PAYOUT` rows in `PENDING_PAYMENT`. Each one is a
//   transfer row below (the same booked row), so the card points at it and offers no pay action.
// Rows carry the raw server status; the pill comes from the page's own mappers (`mapDrop*Status`),
// so the 14.11 income is VALIDATED here and in the ADMIN list (ROWS, «Дохід дропа»).
export const DROP_SHARE = 0.3
export const DINC = [
  { d: '14.11', c: 'Клієнт «Захід»', type: 'DROP_INCOME', raw: 'VALIDATED', usd: 3400 },
  { d: '12.11', c: 'Клієнт «Північ»', type: 'DROP_INCOME', raw: 'PENDING', usd: 1800 },
  { d: '10.11', c: 'Клієнт «Схід»', type: 'DROP_INCOME', raw: 'PENDING_PAYMENT', usd: 1000 },
  { d: '06.11', c: 'Клієнт «Захід»', type: 'DROP_PENDING_PAYOUT', raw: 'PENDING_PAYMENT', usd: 890 },
  { d: '04.11', c: 'Клієнт «Схід»', type: 'DROP_PENDING_PAYOUT', raw: 'PENDING_PAYMENT', usd: 360 },
  { d: '02.11', c: 'Клієнт «Схід»', type: 'DROP_PENDING_PAYOUT', raw: 'PAID', usd: 2400 },
  { d: '28.10', c: 'Клієнт «Північ»', type: 'DROP_PENDING_PAYOUT', raw: 'PAID', usd: 6000 },
].map((x) => ({ ...x, a: usd(x.usd) }))
// The drop's own transfers: `PAYOUT` rows, sender = the drop. The 11.11 one is booked from the
// 10.11 income (1 000 × (1 − 30 %)) and has no hash yet. A submitted hash is verified on-chain at
// once: it moves this row to PAID or is refused, nothing waits in between (§5).
export const DPAY = [
  { d: '11.11', raw: 'PENDING_PAYMENT', usd: 700, hash: '', from: '10.11' },
  { d: '01.11', raw: 'PAID', usd: 640, hash: '0x9c04d1e7a3f2' },
  { d: '20.10', raw: 'REJECTED', usd: 210, hash: '' },
].map((x) => ({ ...x, a: usd(x.usd) }))
// Server-side `PAYOUT_DROP` rows (not drawn on this page), the input of `balance`.
export const PAYOUT_DROP = [
  { dir: 'in', raw: 'PAID', usd: 2400 },
  { dir: 'in', raw: 'PAID', usd: 6000 },
  { dir: 'in', raw: 'PAID', usd: 750 },
  { dir: 'out', raw: 'PAID', usd: 750 },
  { dir: 'in', raw: 'PENDING_PAYMENT', usd: 360 },
]
// The page's mappers, as in today's code.
export const mapDropIncomeStatus = (s) =>
  ({ VALIDATED: 'validated', PAID: 'paid', REJECTED: 'rejected' })[s] ?? 'pending'
export const mapDropObligationStatus = (s) =>
  ({ PAID: 'paid', REJECTED: 'rejected' })[s] ?? 'pending'
export const mapDropPaymentStatus = (s) =>
  ({ PAID: 'confirmed', REJECTED: 'failed' })[s] ?? 'pending'
const dStatus = (x) =>
  x.type === 'DROP_INCOME' ? mapDropIncomeStatus(x.raw) : mapDropObligationStatus(x.raw)
export const DROP_BALANCE = {
  balance: { usd: 8400, label: '$8 400,00' },
  obligation: { usd: 1250, label: '$1 250,00', count: 2, unit: 'зобов’язання' },
  inWork: { count: 2, label: '2 доходи' },
  share: '30%',
  debt: { usd: 700, label: '$700,00' },
}
const MODEL = {
  DROP_INCOME: ['Дохід', 'Валовий дохід'],
  DROP_PENDING_PAYOUT: ['Зобов’язання', 'Ваша частка'],
}
const DST = {
  pending: ['Очікує', 'warn'],
  validated: ['Валідовано', 'ok'],
  paid: ['Оплачено', 'ok'],
  rejected: ['Відхилено', 'err'],
}
const PST = {
  pending: ['Очікує', 'warn'],
  confirmed: ['Підтверджено', 'ok'],
  failed: ['Не пройшов', 'err'],
}
const dPill = ([label, tone], small = true) =>
  `<span class="pill ${tone}" style="${small ? 'height:18px;font-size:11px;padding:0 6px;' : ''}vertical-align:middle">${label}</span>`
const FAILED_LINE = 'Переказ не пройшов — зверніться до адміністратора'
const stat = (k, v, sub = '') =>
  `<div class="col" style="gap:2px;min-width:0"><span class="t-foot muted">${k}</span><span class="num" style="font-size:18px;font-weight:700">${v}</span>${sub ? `<span class="t-foot muted">${sub}</span>` : ''}</div>`
export const DEBT_TITLE = 'Ви маєте сплатити компанії'
export const DEBT_TEXT =
  'Це переказ від 11.11 у списку нижче. Не сплачуйте двічі: якщо кошти вже надіслано поза платформою, дочекайтеся, доки компанія підтвердить оплату.'
const balance = (wide = false, { zero = false } = {}) => {
  const b = DROP_BALANCE
  const debt = zero
    ? ''
    : `<div class="row" style="gap:10px;margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border);align-items:flex-start"><span style="color:var(--warning);display:grid;margin-top:2px">${icon('circle-alert', { size: 16 })}</span><div class="grow col" style="gap:2px"><span style="font-size:14px;font-weight:600">${DEBT_TITLE} <span class="num">${b.debt.label}</span></span><span class="t-foot muted">${DEBT_TEXT}</span></div></div>`
  return `<section aria-label="Мій баланс" style="${wide ? '' : 'margin:0 16px 12px;'}padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-head" style="font-size:15px;margin-bottom:10px">Мій баланс</div><div style="display:grid;grid-template-columns:repeat(${wide ? 4 : 2},minmax(0,1fr));gap:12px 16px">${stat('Отримано', zero ? '$0,00' : b.balance.label)}${stat('Очікує розрахунку', zero ? '$0,00' : b.obligation.label, zero ? '' : `${b.obligation.count} ${b.obligation.unit}`)}${stat('Частка', b.share)}${stat('У роботі', zero ? '0 доходів' : b.inWork.label)}</div>${debt}</section>`
}
const balanceError = `<section aria-label="Мій баланс" role="alert" class="row" style="gap:10px;margin:0 16px 12px;padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><span style="color:var(--destructive);display:grid">${icon('cloud-alert', { size: 18 })}</span><span class="grow t-body">Помилка завантаження балансу</span><span class="iconbtn" role="button" aria-label="Повторити спробу" style="width:44px;height:44px">${icon('rotate-cw', { size: 18 })}</span></section>`
// Neutral type glyphs, no arrows (P2); the model word and its quantity sit on the meta line, aligned
// with the title block (R2-17).
const dropIncRow = (x) => {
  const [badge, sub] = MODEL[x.type]
  const st = dStatus(x)
  return `<div class="lrow two" role="link" style="--inset:64px"><div class="lead">${icon(x.type === 'DROP_INCOME' ? 'banknote' : 'handshake', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px;align-items:flex-start"><div class="t-body grow" style="font-weight:500">${x.c}</div><span class="amount">${x.a}</span></div><div class="row" style="gap:12px"><span class="t-foot muted trunc grow"><span class="num">${x.d}</span> · ${badge}</span><span class="t-cap muted" style="flex:none">${sub}</span></div>${st === 'paid' ? '' : `<div style="margin-top:3px">${dPill(DST[st])}</div>`}</div></div>`
}
const hashText = (x) =>
  x.hash ? `<span class="num" style="font-family:ui-monospace,monospace">${x.hash}…</span>` : '—'
const dropPayRow = (x) => {
  const st = mapDropPaymentStatus(x.raw)
  return `<div class="lrow two" style="--inset:64px"><div class="lead">${icon('hand-coins', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px"><span class="t-body grow" style="font-weight:500">Переказ на рахунок компанії</span><span class="amount">${x.a}</span></div><div class="t-foot muted trunc"><span class="num">${x.d}</span> · Хеш: ${hashText(x)}</div><div class="row" style="gap:6px;margin-top:3px;flex-wrap:wrap">${dPill(PST[st])}${st === 'failed' ? `<span class="t-foot" style="color:var(--fg)">${FAILED_LINE}</span>` : ''}</div></div></div>`
}
const sec = (t) =>
  `<div class="sechead" role="heading" aria-level="2"><span class="t-over">${t}</span></div>`
const dropChip = (label) =>
  `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:44px;padding:0 12px 0 14px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;background:var(--surface);border:1px solid var(--border)">${label}${icon('chevron-down', { size: 15 })}</span>`
const dropFilters = `<div class="row" style="gap:8px;padding:0 16px 6px">${dropChip('Усі статуси')}${dropChip('Усі періоди')}</div>`
const inlineError = (title) =>
  `<div role="alert" class="col" style="align-items:center;gap:8px;margin:0 16px;padding:20px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border);text-align:center"><span style="color:var(--destructive);display:grid">${icon('cloud-alert', { size: 22 })}</span><span class="t-body" style="font-weight:500">${title}</span><span class="btn secondary" style="height:44px">${icon('rotate-cw', { size: 18 })}Повторити</span></div>`
// The DROP page has no search, so no search icon (P13).
const dropScreen = (w, h, body) =>
  listScreen({ w, h, role: 'DROP', active: '/finance', title: 'Фінанси', body }).replace(
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
export const DROP_EMPTY_TEXT = 'Тут з’являться доходи, які ви зареєструєте.'
const dropEmptyM = (w, h) =>
  dropScreen(
    w,
    h,
    `${balance(false, { zero: true })}${sec('Мої доходи')}${stateBlock({ ic: 'banknote', title: 'Доходів ще немає', text: DROP_EMPTY_TEXT })}${sec('Перекази на рахунок компанії')}<div class="t-body muted" style="padding:4px 16px 16px">Переказів ще не було</div>`,
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
          `<tr><td class="num muted">${x.d}</td><td>${x.c}</td><td class="muted">${MODEL[x.type][0]}</td><td>${dPill(DST[dStatus(x)], false)}</td><td class="r"><span class="amount" style="font-size:14px">${x.a}</span><div class="t-cap muted" style="line-height:12px">${MODEL[x.type][1]}</div></td></tr>`,
      ).join(''),
      'Мої доходи',
    ).replace(
      'class="grow"',
      'style="flex:none"',
    )}<h2 class="t-over" style="margin:6px 0 0">Перекази на рахунок компанії</h2>${simpleTable(
      '<th>Дата</th><th>Хеш транзакції</th><th>Статус</th><th class="r">Сума</th>',
      DPAY.map(
        (x) =>
          `<tr><td class="num muted">${x.d}</td><td>${hashCell(x.hash).replace(copyBtn, dCopy)}</td><td class="wrap"><span class="row" style="gap:8px;flex-wrap:wrap">${dPill(PST[mapDropPaymentStatus(x.raw)], false)}${x.raw === 'REJECTED' ? `<span class="t-foot">${FAILED_LINE}</span>` : ''}</span></td><td class="r num">${x.a}</td></tr>`,
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
