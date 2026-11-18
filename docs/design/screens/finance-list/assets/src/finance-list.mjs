// Finance list (Task 1.2) HTML prototypes on the foundation v2 tokens and helpers.
// Every name and amount below is invented seed-like data: no real people, companies or money.
import { icon, page, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { DEST, GROUPS, TABS, allowed } from '../../../_foundation/assets/src/nav.mjs'
import { tabScreen, topBar, tabBar, TABBAR_H } from '../../../_foundation/assets/src/mobile.mjs'
import { brandMark } from '../../../_foundation/assets/src/tablet.mjs'

// ---------- Data ----------
// st: PENDING | VALIDATED | PENDING_PAYMENT | REJECTED | PAID | LOCKED | PENDING_CASH_CONFIRM
// a: the lead figure in USD, unsigned and in the default colour (today no amount carries a sign, §3.5).
// orig: the transaction's own amount when it is not USD / USDT; the lead figure then carries «≈».
// Fixture rate: 1 USD = 41,25 UAH (assertFixtures() in round1.mjs checks every converted row).
const R = (day, d, from, to, type, project, st, a, more = {}) => ({
  day,
  d,
  from,
  to,
  type,
  project,
  st,
  a,
  ...more,
})
export const ROWS = [
  R(
    'Сьогодні',
    '17.11',
    'Рахунок компанії',
    'Оренда офісу',
    'EXPENSE',
    'Альфа',
    'PAID',
    '$1 200,00',
    { att: true },
  ),
  R(
    'Сьогодні',
    '17.11',
    'Клієнт «Північ»',
    'Олег Демо',
    'SENIOR_INCOME',
    'Бета',
    'PENDING',
    '$4 800,00',
    { act: 'Валідувати', share: '20 %' },
  ),
  R(
    'Сьогодні',
    '17.11',
    'Рахунок компанії',
    'Хмарний хостинг',
    'EXPENSE',
    'Інфраструктура',
    'PAID',
    '$86,40',
    { att: true },
  ),
  R(
    'Вчора',
    '16.11',
    'Рахунок компанії',
    'Розробник 4',
    'SALARY',
    'Альфа',
    'PENDING',
    '$2 150,00',
    { act: 'Розрахуватися', month: 'Листопад 2026' },
  ),
  R(
    'Вчора',
    '16.11',
    'Олег Демо',
    'Рахунок компанії',
    'PAYOUT',
    'Бета',
    'PENDING_PAYMENT',
    '$3 000,00',
    { act: 'Підтвердити оплату' },
  ),
  R(
    'Вчора',
    '16.11',
    'Клієнт «Схід»',
    'Адмін Демо',
    'ADMIN_INCOME',
    'Гамма',
    'VALIDATED',
    '≈ $6 250,00',
    { orig: '257 812,50 UAH', usd: 6250, uah: 257812.5 },
  ),
  // M20: the SENIOR, HR, JUNIOR and DROP pages draw these same rows (roles.mjs derives them).
  R(
    'Вчора',
    '16.11',
    'Клієнт «Схід»',
    'Олег Демо',
    'SENIOR_INCOME',
    'Гамма',
    'VALIDATED',
    '$2 600,00',
    { share: '20 %' },
  ),
  R('Вчора', '16.11', 'Рахунок компанії', 'Марта Демо', 'SALARY', '—', 'PENDING', '$1 300,00', {
    act: 'Розрахуватися',
    month: 'Листопад 2026',
  }),
  R(
    '15 листопада',
    '15.11',
    'Адмін Демо',
    'Рахунок компанії',
    'ADMIN_TRANSFER',
    '—',
    'PAID',
    '$1 500,00',
  ),
  R(
    '15 листопада',
    '15.11',
    'Рахунок компанії',
    'Дизайн-інструмент',
    'EXPENSE',
    '—',
    'REJECTED',
    '$29,00',
  ),
  // The two PENDING incomes the ACCOUNTANT queue also shows: one fixture for every role (P3).
  R(
    '15 листопада',
    '15.11',
    'Клієнт «Схід»',
    'Ігор Демо',
    'SENIOR_INCOME',
    'Гамма',
    'PENDING',
    '$2 900,00',
    { act: 'Валідувати', share: '20 %' },
  ),
  R(
    '14 листопада',
    '14.11',
    'Рахунок компанії',
    'Розробник 2',
    'SALARY',
    'Бета',
    'PAID',
    '$1 980,00',
    { month: 'Жовтень 2026' },
  ),
  R(
    '14 листопада',
    '14.11',
    'Клієнт «Захід»',
    'Дроп Демо',
    'DROP_INCOME',
    'Альфа',
    'VALIDATED',
    '$3 400,00',
    { share: '30 %' },
  ),
  R(
    '14 листопада',
    '14.11',
    'Клієнт «Захід»',
    'Олег Демо',
    'SENIOR_INCOME',
    'Альфа',
    'REJECTED',
    '$1 750,00',
    { reason: 'Сума не збігається з рахунком клієнта', share: '20 %' },
  ),
  R(
    '13 листопада',
    '13.11',
    'Клієнт «Північ»',
    'Олег Демо',
    'SENIOR_INCOME',
    'Бета',
    'PAID',
    '$3 100,00',
    { share: '20 %' },
  ),
  R('13 листопада', '13.11', 'Рахунок компанії', 'Обладнання', 'EXPENSE', '—', 'PAID', '$310,00', {
    att: true,
  }),
  R('13 листопада', '13.11', 'Рахунок компанії', 'Банк', 'EXPENSE', '—', 'PAID', '$12,50'),
]
// Rows of the drop, the HR and the JUNIOR viewer dated inside the first page (M20); they sort in
// among the filler rows by date.
const OLDER = [
  R(
    '12 листопада',
    '12.11',
    'Клієнт «Північ»',
    'Дроп Демо',
    'DROP_INCOME',
    'Бета',
    'PENDING',
    '$1 800,00',
    { act: 'Валідувати', share: '30 %' },
  ),
  R(
    '11 листопада',
    '11.11',
    'Дроп Демо',
    'Рахунок компанії',
    'PAYOUT',
    '—',
    'PENDING_PAYMENT',
    '$700,00',
    { act: 'Підтвердити оплату' },
  ),
  R(
    '10 листопада',
    '10.11',
    'Клієнт «Схід»',
    'Дроп Демо',
    'DROP_INCOME',
    'Гамма',
    'PENDING_PAYMENT',
    '$1 000,00',
    { share: '30 %' },
  ),
  R('5 листопада', '05.11', 'Рахунок компанії', 'Марта Демо', 'SALARY', '—', 'PAID', '$1 300,00', {
    month: 'Жовтень 2026',
  }),
  R(
    '5 листопада',
    '05.11',
    'Рахунок компанії',
    'Розробник 4',
    'SALARY',
    'Альфа',
    'PAID',
    '$2 150,00',
    {
      month: 'Жовтень 2026',
    },
  ),
  R('1 листопада', '01.11', 'Дроп Демо', 'Рахунок компанії', 'PAYOUT', '—', 'PAID', '$640,00'),
]

// Old paid rows that fill the first page to its 50 rows, so the pager «1–50 з 132» counts rows the
// table really holds (P7). Days run back from 12 November, two rows a day. «Розробник 4» is the
// JUNIOR viewer: the filler never pays them, so their page and this one hold the same rows (M20).
export const usd = (n) =>
  `$${Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${Math.round((n % 1) * 100)
    .toString()
    .padStart(2, '0')}`
const SPEND = ['Оренда офісу', 'Хмарний хостинг', 'Дизайн-інструмент', 'Обладнання', 'Банк']
const GEN = { 10: 'жовтня', 11: 'листопада' }
export const FILLER = Array.from({ length: 50 - ROWS.length - OLDER.length }, (_, i) => {
  const date = new Date(Date.UTC(2026, 10, 12 - Math.floor(i / 2)))
  const dd = date.getUTCDate()
  const mm = date.getUTCMonth() + 1
  const salary = i % 3 === 0
  return R(
    `${dd} ${GEN[mm]}`,
    `${String(dd).padStart(2, '0')}.${mm}`,
    'Рахунок компанії',
    salary ? `Розробник ${[1, 2, 3, 5, 6, 7][(i / 3) % 6]}` : SPEND[i % 5],
    salary ? 'SALARY' : 'EXPENSE',
    salary ? 'Бета' : '—',
    'PAID',
    usd(salary ? 1800 + i * 10 : 40 + i * 13.5),
    salary ? { month: 'Жовтень 2026' } : {},
  )
})
// The first page of the ADMIN list holds 50 rows of 132, newest first.
export const dayKey = (d) => +d.slice(3, 5) * 100 + +d.slice(0, 2)
export const PAGE = [...ROWS, ...[...OLDER, ...FILLER].sort((a, b) => dayKey(b.d) - dayKey(a.d))]
export const TOTAL = 132

// The lead icon names the type only and carries no direction (P2): direction is the text line.
export const TYPE = {
  EXPENSE: ['Витрата', 'receipt'],
  SENIOR_INCOME: ['Дохід сеньйора', 'banknote'],
  ADMIN_INCOME: ['Дохід адміна', 'banknote'],
  DROP_INCOME: ['Дохід дропа', 'banknote'],
  SALARY: ['Зарплата', 'wallet'],
  PAYOUT: ['Виплата', 'hand-coins'],
  ADMIN_TRANSFER: ['Переказ', 'landmark'],
}
// Final states (VALIDATED, PAID) carry no pill on the phone row: the row shows only what needs attention.
export const STATUS = {
  PENDING: ['Очікує валідації', 'warn'],
  VALIDATED: ['Підтверджено', 'ok'],
  PENDING_PAYMENT: ['Очікує виплати', 'info'],
  REJECTED: ['Відхилено', 'err'],
  PAID: ['Оплачено', 'ok'],
  LOCKED: ['Заблоковано', ''],
  PENDING_CASH_CONFIRM: ['Очікує підтвердження бухгалтером (готівка)', 'warn'],
}
const FINAL = new Set(['VALIDATED', 'PAID'])

export const pill = (st, { small = false } = {}) => {
  const [label, tone] = STATUS[st]
  const info =
    tone === 'info'
      ? 'color:var(--info);border-color:oklch(0.38 0.07 250);background:oklch(0.2 0.035 250);'
      : ''
  return `<span class="pill ${tone === 'info' ? '' : tone}" style="${info}${small ? 'height:18px;font-size:11px;padding:0 6px;' : ''}vertical-align:middle">${label}</span>`
}

// ---------- Phone / tablet list row ----------
const CLAMP2 =
  'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere'

const SMALL =
  'height:auto;min-height:20px;white-space:normal;line-height:15px;padding:2px 7px;font-size:11px'
// Row-write markers (§9.2): pending while the server has not answered, unknown until a refetch settles it.
export const MARK = {
  pending: `<span class="pill" role="status" style="${SMALL};color:var(--info);border-color:oklch(0.38 0.07 250);background:oklch(0.2 0.035 250);gap:5px"><span class="spin" aria-hidden="true" style="display:inline-block;width:10px;height:10px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent"></span>Зберігається…</span>`,
  unknown: `<span class="pill warn" role="status" style="${SMALL};gap:4px">${icon('circle-alert', { size: 12, stroke: 2.2 })}Результат невідомий</span>`,
  left: '<span class="t-foot muted">Не відповідає фільтру</span>',
}
// In a table cell the unknown marker is one word, the full text is its tooltip and accessible name,
// so the pill stays on one line (R3-10, P11).
const CELL_UNKNOWN = `<span class="pill warn" role="status" title="Результат невідомий" aria-label="Результат невідомий" style="gap:4px;height:22px;padding:0 8px;white-space:nowrap">${icon('circle-alert', { size: 12, stroke: 2.2 })}Невідомо</span>`
const delPill = `<span class="pill" style="${SMALL}">Видалено</span>`
// Status slot: the pill when the status needs someone (or the viewer can still act, OP-7), the
// «Видалено» pill and the row-write marker. Never before the title (R1-20).
const statusSlot = (x) => {
  const parts = [
    !FINAL.has(x.st) || x.showPill
      ? pill(x.st, { small: true }).replace(
          /height:18px;font-size:11px;padding:0 6px;/,
          `${SMALL};`,
        )
      : '',
    x.deleted ? delPill : '',
    x.mark ? MARK[x.mark] : '',
  ].filter(Boolean)
  return parts.length
    ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:3px">${parts.join('')}</div>`
    : ''
}
// Direction as text, once per row (P2): `payer → receiver`; a person viewer reads «Ви» for themselves.
export const direction = (x) => x.dir ?? `${x.from} → ${x.to}`

export function row(x, { sel = false } = {}) {
  const [typeLabel, ic] = TYPE[x.type]
  const clip = x.att
    ? ` · <span aria-label="Чек прикріплено" style="display:inline-flex;vertical-align:-2px">${icon('paperclip', { size: 13 })}</span>`
    : ''
  // No clock time anywhere (M12): type, the salary month, the project, the receipt clip.
  const meta = `${typeLabel}${x.month ? ` · ${x.month}` : ''}${x.project && x.project !== '—' ? ` · Проєкт «${x.project}»` : ''}${clip}`
  // An amount over 14 characters (7+ digits) would squeeze the title to a word: it drops under the title.
  const amount = `<span class="amount" style="flex:none">${x.a}</span>`
  const head =
    x.a.length > 14
      ? `<div class="t-body" style="font-weight:500;${CLAMP2}">${title(x)}</div><div class="row">${amount}</div>`
      : `<div class="row" style="align-items:flex-start;gap:12px"><div class="t-body grow" style="font-weight:500;${CLAMP2}">${title(x)}</div>${amount}</div>`
  // Line two: the direction, with the original amount right-aligned on the same line (R2-17), so the
  // right column never leaves a blank line under the title. When both do not fit, the original wraps
  // to its own line under the amount's edge rather than cutting the receiver (R3-20, `main-320`).
  const dirLine = `<div class="row" style="gap:0 12px;align-items:baseline;flex-wrap:wrap"><span class="t-foot muted trunc" style="flex:0 1 auto;max-width:100%">${direction(x)}</span>${x.orig ? `<span class="t-cap muted num" style="flex:none;margin-left:auto">${x.orig}</span>` : ''}</div>`
  // Deleted rows: muted text (>= 4.5:1), never opacity (opacity drops contrast below AA).
  return `${x.deleted ? `<style>${DEL_CSS}</style>` : ''}<div class="lrow two${x.deleted ? ' del' : ''}" role="link" data-tx ${sel ? 'aria-current="true" ' : ''}style="--inset:64px;${sel ? 'background:var(--raised);' : ''}"><div class="lead">${icon(ic, { size: 18 })}</div>
  <div class="grow col" style="gap:2px;min-width:0">${head}${dirLine}<div class="t-foot muted trunc">${meta}</div>${statusSlot(x)}</div></div>`
}

// The title names the party that is not the viewer (OP-12). For ADMIN / ACCOUNTANT the viewer is the
// company account; a flow with neither side being the company shows both. `t` overrides it for the
// person viewers (SENIOR, HR, JUNIOR, DROP), whose own name never appears.
export const COMPANY = 'Рахунок компанії'
export const title = (x) => x.t ?? (x.to === COMPANY ? x.from : x.to)

// Ukrainian plural for «транзакція» (one / few / many; `other` is the fraction form, never hit here).
export const txCount = (n) => {
  const m10 = n % 10
  const m100 = n % 100
  const w =
    m10 === 1 && m100 !== 11
      ? 'транзакція'
      : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
        ? 'транзакції'
        : 'транзакцій'
  return `${n} ${w}`
}

// The phone list screen: the foundation tab screen without the top-bar search icon (R1-15) — the
// search field is always in the list head.
export const listScreen = (opts) =>
  tabScreen(opts).replace(/<div class="iconbtn" aria-label="Пошук">[\s\S]*?<\/div>/, '')

export function dayList(rows, opts = {}) {
  const days = [...new Set(rows.map((r) => r.day))]
  return days
    .map(
      (d, i) =>
        `<div class="sechead${i === 0 ? ' sticky' : ''}" role="heading" aria-level="2"><span class="t-over">${d}</span></div><div class="group" role="list">${rows
          .filter((r) => r.day === d)
          .map((r) => row(r, opts))
          .join('')}</div>`,
    )
    .join('')
}

// Search + one chip row (P6). With no filter: the preset «Очікує валідації (n)» for ACCOUNTANT / ADMIN
// (P14; n = rows the viewer can validate, M22), then «Фільтри» and sort; with no data (loading, error,
// cold offline) the preset hides (`preset: 0`), as it does for the other roles. With a filter: the
// active chips come FIRST in a scroller, and «Фільтри (n)» and sort are 44 px icon buttons pinned
// outside it (R3-06), so the filter count and sort never scroll away. The whole active chip is one
// 44 px button «Прибрати фільтр: …» (R1-15). `match`: «Показано n з N» under the row while a filter or
// a search narrows the list; n counts matches, not the rows drawn (R3-07), and `data-match` lets
// render.mjs check the rows drawn against min(n, 50).
export const badge = (n) =>
  `<b class="num" style="min-width:20px;height:20px;border-radius:10px;background:var(--primary);color:var(--primary-fg);font-size:12px;line-height:20px;text-align:center;padding:0 5px">${n}</b>`
export function searchAndFilters({
  active = [],
  count = active.length,
  q = '',
  sort = 'Дата',
  match = null,
  total = 132,
  preset = VALIDATE_N,
  // Scrolled (R3-25): the search stays pinned under the bar (M14); the chip row stays pinned only
  // while a filter is active, so `chips: false` draws the pinned head of an unfiltered list.
  chips = true,
} = {}) {
  const chip = (label, { on = false, name = '' } = {}) =>
    `<span class="row" role="button" ${name ? `aria-label="${name}" ` : ''}style="gap:6px;height:44px;padding:0 ${on ? 12 : 14}px 0 14px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;flex:none;${on ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${label}${on ? `<span aria-hidden="true" style="display:grid">${icon('x', { size: 15, stroke: 2.2 })}</span>` : ''}</span>`
  const iconChip = (ic, name, extra = '') =>
    `<span class="row" role="button" aria-label="${name}" style="gap:4px;height:44px;min-width:44px;padding:0 ${extra ? 8 : 0}px 0 ${extra ? 10 : 0}px;justify-content:center;border-radius:22px;flex:none;background:var(--surface);border:1px solid var(--border)">${icon(ic, { size: 17 })}${extra}</span>`
  const narrowed = active.length > 0
  const lead = preset
    ? `${chip(`Очікує валідації ${badge(preset)}`, { name: `Показати транзакції, які можна валідувати: ${preset}` })}${iconChip('sliders-horizontal', 'Фільтри')}${iconChip('arrow-down', `Сортування: ${sort}`)}`
    : `${chip(`${icon('sliders-horizontal', { size: 17 })}Фільтри`)}${chip(`${icon('arrow-down', { size: 15 })}${sort}`)}`
  const fade =
    '<span aria-hidden="true" style="position:absolute;right:0;top:0;bottom:0;width:24px;background:linear-gradient(to right,transparent,var(--bg));pointer-events:none"></span>'
  const chipRow = narrowed
    ? `<div class="row" style="gap:8px;padding:0 16px 6px"><div style="position:relative;flex:1;min-width:0"><div class="row" style="gap:8px;overflow-x:auto;scrollbar-width:none;padding-right:16px">${active.map((a) => chip(a, { on: true, name: `Прибрати фільтр: ${a}` })).join('')}</div>${active.length > 1 ? fade : ''}</div>${iconChip('sliders-horizontal', `Фільтри, активних: ${count}`, badge(count))}${iconChip('arrow-down', `Сортування: ${sort}`)}</div>`
    : `<div class="row" style="gap:8px;padding:0 16px 6px;overflow-x:auto;scrollbar-width:none">${lead}</div>`
  const clear = q
    ? `<span class="iconbtn" role="button" aria-label="Очистити пошук" style="width:44px;height:44px;margin-right:-12px;color:var(--muted-fg)">${icon('circle-x', { size: 18 })}</span>`
    : ''
  const matchLine =
    match === null
      ? ''
      : `<div class="t-foot muted num" role="status" data-match="${match}" style="padding:4px 16px 2px">Показано ${match} з ${total}</div>`
  return `<div style="padding:4px 16px 10px"><div class="row" role="searchbox" style="gap:8px;height:44px;border-radius:12px;background:var(--surface);padding:0 12px;color:${q ? 'var(--fg)' : 'var(--placeholder)'};font-size:16px">${icon('search', { size: 18 })}<span class="grow trunc">${q || 'Пошук транзакцій'}</span>${clear}</div></div>
  ${chips || narrowed ? chipRow : ''}${matchLine}`
}

// ---------- Tablet (640–1023): rail + one pane (role-aware copy of the foundation rail) ----------
function railItems(role) {
  const rest = GROUPS.flatMap((g) => g.items).filter(
    (d) => allowed(role).includes(d) && !TABS[role].includes(d),
  )
  return [...TABS[role], ...rest]
}
function rail(role, active, h, { canCreate = true } = {}) {
  const budget = h - 24 - 120 - 64 - 20
  const itemH = (d) => 16 + 24 + 4 + 13 * Math.ceil(DEST[d].label.length / 10) + 2
  const shown = []
  for (const d of railItems(role))
    if (shown.reduce((a, x) => a + itemH(x), 0) + itemH(d) + 58 <= budget) shown.push(d)
  const item = (d, on, label, ic) =>
    `<div class="col" ${on ? 'aria-current="page"' : ''} style="align-items:center;gap:4px;width:68px;padding:8px 0;border-radius:14px;${on ? 'background:var(--raised)' : ''};color:${on ? 'var(--fg)' : 'var(--muted-fg)'}"><span style="color:${on ? 'var(--primary)' : 'inherit'}">${icon(ic, { size: 24, stroke: on ? 2.1 : 1.75 })}</span><span style="font-size:11px;line-height:13px;font-weight:500;text-align:center;max-width:66px">${label}</span></div>`
  return `<nav aria-label="Основна навігація" class="col" style="width:80px;flex:none;align-items:center;gap:2px;padding:12px 0 20px;border-right:1px solid var(--border);background:oklch(0.095 0.002 85)">
  ${brandMark(36)}<div style="height:10px"></div>
  ${canCreate ? `<div aria-label="Нова транзакція" role="button" style="width:52px;height:52px;border-radius:16px;background:var(--primary);color:var(--primary-fg);display:grid;place-items:center;margin-bottom:10px">${icon('plus', { size: 24, stroke: 2.4 })}</div>` : ''}
  ${shown.map((d) => item(d, d === active, DEST[d].label, DEST[d].icon)).join('')}${item('more', false, 'Ще', 'ellipsis')}
  <div style="flex:1"></div><div style="width:40px;height:40px;border-radius:20px;display:grid;place-items:center;background:var(--yellow-subtle);color:var(--primary);font-size:14px;font-weight:600">АД</div></nav>`
}
// `pane` (≥ 900, shell v2 §3): the list takes 360 px and the detail pane fills the rest.
export function tabletFrame({
  w,
  h,
  role = 'ADMIN',
  body,
  title = 'Фінанси',
  canCreate = true,
  pane = '',
  overlay = '',
}) {
  return `<div class="device touch" style="width:${w}px;height:${h}px;position:relative">
  <div class="row" style="height:24px;padding:0 20px;justify-content:space-between;font-size:13px;font-weight:600;flex:none"><span>9:41 вт 17 лист.</span><span class="row" style="gap:6px">${icon('wifi', { size: 14, stroke: 2.2 })}100%</span></div>
  <div class="row grow" style="align-items:stretch;min-height:0;position:relative">${rail(role, '/finance', h, { canCreate })}
  <section aria-label="Транзакції" class="col ${pane ? '' : 'grow'}" style="min-width:0;${pane ? 'width:360px;flex:none;border-right:1px solid var(--border)' : ''}">
  <div class="row" style="height:56px;padding:0 8px 0 16px;flex:none"><h1 class="grow t-title" style="margin:0">${title}</h1><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  <div style="flex:1;min-height:0;overflow:hidden">${body}</div></section>${pane}</div>
  <div class="homebar" style="width:180px"></div>${overlay}</div>`
}

// ---------- Desktop (≥ 1024): role-aware sidebar + header + dense table ----------
const DEL_CSS = `.del :is(.amount,.trunc,.t-body,.muted,.t-cap,.t-foot,.lead){color:var(--muted-fg)!important}`
const TABLE_CSS = `${DEL_CSS}
th svg{display:block}
th{position:sticky;top:0;background:var(--card);font-size:12px;font-weight:600;color:var(--muted-fg);height:36px;padding:0 12px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:left}
td{height:40px;padding:0 12px;border-bottom:1px solid var(--separator);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis;font-size:14px}
tbody tr:last-child td{border-bottom:0}
tr[aria-selected="true"] td{background:var(--accent, var(--raised))}
tr[aria-selected="true"] td:first-child{box-shadow:inset 2px 0 0 var(--primary)}
tr.hover td{background:var(--surface)}
td.r,th.r{text-align:right}
td.wrap{white-space:normal}
.rowact{opacity:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
tr.hover .rowact,tr[aria-selected="true"] .rowact{opacity:1}`

function sidebar(role) {
  const ok = new Set(allowed(role))
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((d) => ok.has(d)) })).filter(
    (g) => g.items.length,
  )
  return `<nav aria-label="Основна навігація" class="col" style="width:248px;flex:none;border-right:1px solid var(--border);background:oklch(0.095 0.002 85);padding:12px 10px">
  <div class="row" style="gap:10px;height:40px;padding:0 6px">${brandMark(28)}<div class="grow"><div style="font-size:14px;font-weight:600;line-height:17px">Cheeky Cheese</div><div class="t-cap muted">CRM</div></div><span class="muted" aria-label="Згорнути бічну панель">${icon('panel-left-close', { size: 18 })}</span></div>
  <div class="row" style="gap:8px;height:36px;margin:12px 0 6px;padding:0 10px;border-radius:9px;background:var(--surface);border:1px solid var(--border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 15 })}<span class="grow">Пошук або команда</span><span class="kbdkey">⌘K</span></div>
  ${groups
    .map(
      (g) =>
        `<div class="row" style="height:28px;margin-top:10px;padding:0 10px"><span class="t-over" style="font-size:11px">${g.title}</span></div>${g.items
          .map((d) => {
            const on = d === '/finance'
            return `<div class="row" ${on ? 'aria-current="page"' : ''} style="gap:10px;height:36px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:${on ? 600 : 500};${on ? 'background:var(--raised);color:var(--fg);box-shadow:inset 2px 0 0 var(--primary)' : 'color:var(--muted-fg)'}"><span style="color:${on ? 'var(--primary)' : 'inherit'}">${icon(DEST[d].icon, { size: 17 })}</span><span class="grow trunc">${DEST[d].label}</span></div>`
          })
          .join('')}`,
    )
    .join('')}
  <div style="flex:1"></div></nav>`
}

export function desktopFrame({
  w,
  h,
  role = 'ADMIN',
  body,
  actions,
  crumb = 'Фінанси',
  overlay = '',
}) {
  const cta =
    actions ??
    `<span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Нова транзакція<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span></span>`
  return `<style>${TABLE_CSS}</style><div class="device" style="width:${w}px;height:${h}px;flex-direction:row;position:relative">${sidebar(role)}
  <main class="grow col" style="min-width:0">
  <header class="row" style="height:56px;flex:none;padding:0 20px 0 24px;gap:12px;border-bottom:1px solid var(--border)">
    <div class="grow row" style="gap:8px;font-size:14px"><span class="muted">Гроші</span><span class="muted">${icon('chevron-right', { size: 14 })}</span><h1 style="font-size:14px;font-weight:600;margin:0">${crumb}</h1></div>
    <span class="iconbtn" style="width:36px;height:36px" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 18 })}<i class="dot" style="top:7px;right:7px"></i></span>${cta}</header>
  <div class="col grow" style="min-height:0;padding:20px 24px 24px;gap:14px;${w >= 1440 ? 'max-width:1320px' : ''}">${body}</div></main>${overlay}</div>`
}

// A listbox trigger; an active one carries a 24 px «Прибрати фільтр: …» button. `whole`: the chip has
// no listbox (the month chip, A-1), so the whole chip is the remove button.
const dBtn = (label, { on = false, x = false, whole = false } = {}) =>
  `<span class="row" role="button" ${whole ? `aria-label="Прибрати фільтр: ${label}"` : 'aria-haspopup="listbox"'} style="gap:4px;height:32px;padding:0 ${x ? 4 : 10}px 0 10px;border-radius:8px;font-size:13px;white-space:nowrap;${on ? 'background:var(--yellow-subtle);color:var(--fg);border:1px solid oklch(0.32 0.06 85)' : 'border:1px solid var(--input-border);color:var(--muted-fg)'}">${whole ? icon('calendar', { size: 13 }) : ''}${label}${x ? `<span ${whole ? 'aria-hidden="true"' : `role="button" aria-label="Прибрати фільтр: ${label}"`} style="display:grid;place-items:center;width:24px;height:24px">${icon('x', { size: 13 })}</span>` : icon('chevron-down', { size: 13 })}</span>`
const dToggle = (on) =>
  `<span class="row" role="switch" aria-checked="${on}" style="gap:8px;height:32px;padding:0 6px;font-size:13px;color:var(--muted-fg)"><span style="width:30px;height:18px;border-radius:9px;position:relative;background:${on ? 'var(--primary)' : 'var(--secondary)'};border:1px solid var(--border)"><i style="position:absolute;top:2px;left:${on ? 14 : 2}px;width:12px;height:12px;border-radius:6px;background:${on ? 'var(--primary-fg)' : 'var(--fg)'}"></i></span>Показати видалені</span>`

// The count reads «132 транзакції», or «18 з 132» while filters narrow the list (A-5).
export function toolbar({
  w,
  type = '',
  status = '',
  month = '',
  deleted = null,
  total = 132,
  count,
  q = '',
}) {
  const shown = count ?? (typeof total === 'number' ? txCount(total) : total)
  return `<div class="row" style="gap:8px;flex:none"><span class="row" role="searchbox" style="gap:8px;height:32px;width:${w >= 1280 ? 300 : 220}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:${q ? 'var(--fg)' : 'var(--muted-fg)'};font-size:13px">${icon('search', { size: 14 })}<span class="grow trunc">${q || 'Пошук транзакцій'}</span><span class="kbdkey">/</span></span>
  ${dBtn(type ? `Тип: ${type}` : 'Усі типи', { on: !!type, x: !!type })}${dBtn(status ? `Статус: ${status}` : 'Усі статуси', { on: !!status, x: !!status })}${month ? dBtn(month, { on: true, x: true, whole: true }) : ''}${deleted === null ? '' : dToggle(deleted)}${type || status || month || deleted ? '<span class="btn ghost sm" style="color:var(--muted-fg)">Скинути</span>' : ''}
  <span class="grow"></span><span class="t-foot muted num">${shown}</span></div>`
}

const sortTh = (label, dir, cls = '', { disabled = false } = {}) =>
  `<th class="${cls}" aria-sort="${dir === 'down' ? 'descending' : dir ? 'ascending' : 'none'}"${disabled ? ' aria-disabled="true" title="Сортування за сумою недоступне: немає курсу валют."' : ''}><span style="display:inline-flex;align-items:center;gap:4px;${disabled ? 'opacity:0.55' : ''}">${label}${dir ? icon(dir === 'down' ? 'arrow-down' : 'arrow-up', { size: 12 }) : `<span style="opacity:0.45;display:grid">${icon(disabled ? 'ban' : 'chevrons-up-down', { size: 12 })}</span>`}</span></th>`

// A status pill in a cell is one line; a label longer than the column ends in «…» and the full label
// is the tooltip (P11).
const tdPill = (html) => {
  const label = html.match(/>([^<]+)<\/span>$/)?.[1] ?? ''
  return html
    .replace('<span class="pill', `<span title="${label}" class="pill`)
    .replace(
      'vertical-align:middle',
      'vertical-align:middle;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:22px;line-height:20px;padding:0 8px',
    )
}
// An inline action that the column cannot hold goes into «…» (P11): the cap is 19 characters.
export const INLINE_MAX = 19

// Columns at ≥ 1440: Дата 76 (112 when a row shows a year) · Учасник flex, never under 220 ·
// Тип 140 · Проєкт 130, above 1440 its content up to 200 · Статус 170 · Сума 150 · Дії sized to the
// longest inline action (max 220). Below 1440 (R3-05) type and project share a column (120), Статус
// 128, Сума 130 and Дії is the «…» only, under a coarse pointer too (its first item is the primary),
// so Учасник keeps 220 px; render.mjs measures it. The Учасник cell is two lines at every width (P2):
// line one the party that is not the company, line two the direction. The Сума cell's second line is
// the original amount, or the share and its source (M11). `coarse`: a touch pointer at desktop
// width — 52 px rows, «…» always visible at 44 px; the inline primary shows where the wide columns
// apply (§3.7). `blocked`: the index of a row whose money action is disabled after an unknown outcome
// (P1); its inline action is drawn `aria-disabled` with the reason.
export function table(
  rows,
  {
    w,
    sel = 0,
    hover = -1,
    menuFor = -1,
    canAct = true,
    sortOff = false,
    coarse = false,
    blocked = -1,
  } = {},
) {
  const wide = w >= 1440
  const head = `<tr>${sortTh('Дата', 'down')}<th>Учасник</th><th>${wide ? 'Тип' : 'Тип · проєкт'}</th>${wide ? '<th>Проєкт</th>' : ''}<th>Статус</th>${sortTh('Сума', '', 'r', { disabled: sortOff })}<th><span class="sr">Дії</span></th></tr>`
  const inline = canAct && wide
  const fits = (x) => x.act && x.act.length <= INLINE_MAX
  const longest = Math.max(0, ...rows.map((x) => (fits(x) ? x.act.length : 0)))
  const moreW = coarse ? 44 : 28
  const actW =
    inline && longest
      ? Math.min(coarse ? 260 : 220, 24 + moreW + 6 + Math.ceil(longest * 7.4) + 28)
      : 24 + moreW
  const dateW = rows.some((x) => /\.\d{4}$/.test(x.d)) ? 112 : 76
  const longestProject = Math.max(0, ...rows.map((x) => (x.project ?? '').length))
  const projW = w > 1440 ? Math.min(200, Math.max(130, 24 + Math.ceil(longestProject * 8.2))) : 130
  const cols = `<colgroup><col style="width:${dateW}px"><col><col style="width:${wide ? 140 : 120}px">${wide ? `<col style="width:${projW}px">` : ''}<col style="width:${wide ? 170 : 128}px"><col style="width:${wide ? 150 : 130}px"><col style="width:${actW}px"></colgroup>`
  const tr = rows
    .map((x, i) => {
      const [typeLabel] = TYPE[x.type]
      const clip = x.att
        ? `<span aria-label="Чек прикріплено" class="muted" style="display:inline-flex;flex:none">${icon('paperclip', { size: 13 })}</span>`
        : ''
      const off = i === blocked
      const act =
        inline && fits(x)
          ? `<span class="btn secondary sm rowact" ${off ? 'aria-disabled="true" title="Недоступно: результат попередньої дії ще невідомий" ' : ''}style="opacity:${off ? 0.5 : 1};${coarse ? 'height:44px;padding:0 14px;font-size:14px' : ''}">${x.act}</span>`
          : ''
      const show = i === menuFor || coarse || Boolean(x.act)
      const more = `<span class="iconbtn rowact" aria-label="Інші дії" aria-haspopup="menu" style="width:${moreW}px;height:${moreW}px;${show ? 'opacity:1;' : ''}${i === menuFor ? 'background:var(--surface)' : ''}">${icon('ellipsis', { size: 16 })}</span>`
      // The full direction is also the tooltip, which opens on focus (§3.3).
      const party = `<span class="col" style="min-width:0;line-height:17px"><span class="row" style="gap:6px;min-width:0"><span class="trunc">${title(x)}</span>${clip}</span><span class="trunc muted" style="font-size:13px">${direction(x)}</span></span>`
      const status = [
        tdPill(pill(x.st)),
        x.deleted ? tdPill('<span class="pill" style="vertical-align:middle">Видалено</span>') : '',
        x.mark === 'unknown' ? CELL_UNKNOWN : x.mark && x.mark !== 'left' ? MARK[x.mark] : '',
        x.mark === 'left' ? MARK.left : '',
      ]
        .filter(Boolean)
        .join('')
      return `<tr data-tx ${i === sel ? 'aria-selected="true"' : ''} class="${i === hover ? 'hover' : ''}${x.deleted ? ' del' : ''}"><td class="num muted">${x.d}</td><td title="${direction(x)}" tabindex="-1">${party}</td><td class="muted">${typeLabel}${wide ? '' : x.project !== '—' ? ` · ${x.project}` : ''}</td>${wide ? `<td class="muted">${x.project}</td>` : ''}<td class="wrap" style="padding-top:6px;padding-bottom:6px"><span class="row" style="gap:6px;flex-wrap:wrap;min-width:0">${status}</span></td><td class="r"><span class="amount" style="font-size:14px">${x.a}</span>${x.orig ? `<div class="t-cap muted num" style="line-height:12px">${x.orig}</div>` : x.share ? `<div class="t-cap muted" style="line-height:12px">Частка ${x.share} · проєкт</div>` : ''}</td><td class="r"><span class="row" style="gap:6px;justify-content:flex-end">${act}${more}</span></td></tr>`
    })
    .join('')
  const rowH = coarse ? 52 : 48
  // R3-24: the table scrolls inside its card, so a long page draws the cue: a bottom fade and a
  // scrollbar thumb sized to the visible share of the rows.
  const cue =
    rows.length > 14
      ? `<div aria-hidden="true" style="position:absolute;left:0;right:0;bottom:0;height:48px;background:linear-gradient(to bottom,transparent,var(--card));pointer-events:none"></div><div aria-hidden="true" style="position:absolute;right:3px;top:${coarse ? 48 : 40}px;width:5px;height:${Math.max(8, Math.round((100 * 13) / rows.length))}%;border-radius:3px;background:oklch(1 0 0 / 0.24)"></div>`
      : ''
  return `<style>td{height:${rowH}px}</style><div class="grow" style="position:relative;min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"><table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0" aria-label="Транзакції">${cols}<thead>${head}</thead><tbody>${tr}</tbody></table>${cue}</div>`
}

// Hidden while every row fits on one page (≤ 50, A-5). `data-pager` lets render.mjs check the range
// against the rows the table holds (P7).
export const pager = (from = 1, to = 50, total = 132) =>
  total <= 50
    ? ''
    : `<div class="row" data-pager="${from}-${to}" style="gap:8px;justify-content:flex-end;flex:none;font-size:13px"><span class="muted num">${from}–${to} з ${total}</span><span class="btn secondary sm" aria-label="Попередня сторінка" style="width:32px;padding:0">${icon('chevron-left', { size: 15 })}</span><span class="btn secondary sm" aria-label="Наступна сторінка" style="width:32px;padding:0">${icon('chevron-right', { size: 15 })}</span></div>`

// ---------- Frames ----------
// `full`: a full-page screenshot (the device is drawn as tall as its content, AC7).
export const M = (name, w, h, body, full = false) => ({
  name,
  w,
  h,
  dpr: 2,
  full,
  html: page(body, { width: w }),
})
export const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })

const mobileMain = (w, h) =>
  listScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: `${searchAndFilters()}${dayList(ROWS)}`,
  })
// The status=PENDING count of the fixture: every «n з 132» for that status filter (salaries included).
export const PENDING_N = PAGE.filter((r) => r.st === 'PENDING').length
// The preset chip counts only what the viewer can validate (M22): today's `validateQueue` predicate.
export const canValidateRow = (r) =>
  (r.type === 'SENIOR_INCOME' || r.type === 'DROP_INCOME') && r.st === 'PENDING'
export const VALIDATE_N = PAGE.filter(canValidateRow).length
// 640–899 single pane: the list column is capped at 560 px and start-aligned beside the rail (P8),
// so the amount stays next to its title.
export const CAP = (html) => `<div style="max-width:560px">${html}</div>`
const tabletMain = (w, h) =>
  tabletFrame({
    w,
    h,
    body: CAP(`${searchAndFilters()}${dayList(ROWS.slice(0, 10))}`),
  })
export const desktopMain = (w, h, opts = {}) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(PAGE, { w, sel: 1, hover: 3, ...opts })}${pager()}`,
  })

export function frames() {
  return [
    M('main-320', 320, 1442, mobileMain(320, 1442), true),
    M('main-375', 375, 812, mobileMain(375, 812)),
    M('main-768', 768, 1024, tabletMain(768, 1024)),
    D('main-1024', 1024, 768, desktopMain(1024, 768)),
    D('main-1440', 1440, 900, desktopMain(1440, 900)),
    D('main-1920', 1920, 1080, desktopMain(1920, 1080)),
  ]
}
