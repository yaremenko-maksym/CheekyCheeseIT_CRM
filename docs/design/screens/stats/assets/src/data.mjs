// Stats screen: invented fixture data, formatting and the small shared elements.
// Everything here is a fixture (no real names or amounts). KPIs are DERIVED from the series (R1-21).
import { icon } from '../../../_foundation/assets/src/base.mjs'
import { ROLE_LABEL } from '../../../_foundation/assets/src/nav.mjs'

// ---------- 20 months: Apr 2025 … Nov 2026 (the whole history, so «Усе» = 20 bars) ----------
const SHORT = [
  'квіт',
  'трав',
  'черв',
  'лип',
  'серп',
  'вер',
  'жовт',
  'лист',
  'груд',
  'січ',
  'лют',
  'бер',
  'квіт',
  'трав',
  'черв',
  'лип',
  'серп',
  'вер',
  'жовт',
  'лист',
]
const FULL = [
  'Квітень 2025',
  'Травень 2025',
  'Червень 2025',
  'Липень 2025',
  'Серпень 2025',
  'Вересень 2025',
  'Жовтень 2025',
  'Листопад 2025',
  'Грудень 2025',
  'Січень 2026',
  'Лютий 2026',
  'Березень 2026',
  'Квітень 2026',
  'Травень 2026',
  'Червень 2026',
  'Липень 2026',
  'Серпень 2026',
  'Вересень 2026',
  'Жовтень 2026',
  'Листопад 2026',
]
export const N = FULL.length
export const MONTHS = SHORT.map((s, i) => ({
  short: s,
  full: FULL[i],
  name: FULL[i].split(' ')[0].toLowerCase(),
  yy: FULL[i].slice(-2),
}))
// thousands of USD
export const S = {
  income: [
    18.2, 19.6, 20.4, 22.1, 21.0, 23.3, 22.7, 24.0, 21.4, 19.8, 23.6, 24.1, 22.9, 26.3, 25.0, 27.8,
    26.9, 21.2, 29.4, 24.6,
  ],
  expenses: [
    3.8, 3.9, 4.0, 4.2, 4.1, 4.3, 4.0, 4.5, 4.1, 3.6, 5.2, 4.4, 4.0, 4.8, 5.6, 4.9, 5.1, 6.3, 5.0,
    4.7,
  ],
  salaries: [
    13.9, 14.1, 14.3, 14.6, 14.6, 14.8, 14.9, 15.0, 15.2, 15.2, 15.6, 15.6, 16.0, 16.4, 15.2, 16.1,
    16.7, 16.3, 16.5, 16.6,
  ],
}
S.profit = S.income.map((v, i) => Math.round((v - S.expenses[i] - S.salaries[i]) * 10) / 10)
export const SERIES = [
  ['profit', 'Прибуток'],
  ['income', 'Дохід'],
  ['expenses', 'Витрати'],
  ['salaries', 'Зарплати'],
]
export const LOSS = S.profit.findIndex((v) => v < 0) // 17 = Вересень 2026 (not a tick month at 12)
export const periodIdx = (n) => {
  const len = n === 'all' ? N : n
  return Array.from({ length: len }, (_, i) => N - len + i)
}
export const PERIODS = ['6 міс', '12 міс', 'Усе']
export const PERIOD_N = [6, 12, 'all']

// ---------- Partners (exactly two, always; one balance is a defensive data state) ----------
export const PARTNERS = [
  { n: 'Віктор Кравець', i: 'ВК', b: 18420.5 },
  { n: 'Олена Шевчук', i: 'ОШ', b: 12960.0 },
]
export const BALANCED = [
  { n: 'Віктор Кравець', i: 'ВК', b: 15240.0 },
  { n: 'Олена Шевчук', i: 'ОШ', b: 15240.0 },
]
export const LONG = [
  { n: 'Олександра Вишневецька-Коваленко', i: 'ОВ', b: 1234567.89 },
  { n: 'Віктор Кравець', i: 'ВК', b: -1204.6 },
]
export const ONE = [PARTNERS[0]]
export const ZERO = PARTNERS.map((p) => ({ ...p, b: 0 }))

// ---------- Receivers (income compliance) ----------
export const ROLE = { SENIOR: 'Сеньйор', ADMIN_SENIOR: 'Адмін-сеньйор', DROP: 'Дроп' }
// `open` = the projects with no credited income; there are exactly `p - s` of them (R2-13).
export const RECEIVERS = [
  {
    n: 'Ірина Мельник',
    i: 'ІМ',
    role: 'SENIOR',
    p: 5,
    s: 3,
    st: 'lag',
    pill: '2 без доходу',
    open: [
      ['Orbita CRM', 'Lumen Retail'],
      ['Nimbus Portal', 'Verde Market'],
    ],
  },
  {
    n: 'Дмитро Бондар',
    i: 'ДБ',
    role: 'ADMIN_SENIOR',
    p: 3,
    s: 2,
    st: 'pend',
    pill: '1 у процесі',
    open: [['Atlas Billing', 'Fjord Logistics']],
  },
  {
    n: 'Софія Лисенко',
    i: 'СЛ',
    role: 'SENIOR',
    p: 3,
    s: 2,
    st: 'lag',
    pill: '1 без доходу',
    open: [['Helio Studio', 'Quartz Media']],
  },
  { n: 'Андрій Ткачук', i: 'АТ', role: 'DROP', p: 1, s: 1, st: 'ok', pill: 'Усі отримано', open: [] },
]

// Signed-in person shown in the desktop sidebar chip (invented fixtures, one per drawn role).
export const CHIP = {
  ADMIN: { n: 'Віктор Кравець', i: 'ВК', role: ROLE_LABEL.ADMIN },
  ACCOUNTANT: { n: 'Марина Савчук', i: 'МС', role: ROLE_LABEL.ACCOUNTANT },
}

// Cache stamps (M3): `{when}` is the time today and «ДД.ММ о ГГ:ХХ» on any other day (primitives-v2 format).
export const WHEN_TODAY = '14:32'
export const WHEN_OLD = '10.11 о 14:32'

// ---------- Formatting (mirrors formatMoney: uk grouping, decimal comma, U+2212, CODE suffix) ----------
const nf = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const money = (v, code = 'USD', { sign = false } = {}) =>
  `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${nf.format(Math.abs(v))} ${code}`
export const kfmt = (v, sign = true) =>
  `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}`
// Sign rule: «+» only on profit-type figures; every negative value uses U+2212.
export const seriesMoney = (series, v) => money(v * 1000, 'USD', { sign: series === 'profit' })
const rules = new Intl.PluralRules('uk')
export const plural = (n, forms) => forms[rules.select(n)]
export const PROJECTS = (n) =>
  `${n} ${plural(n, { one: 'активний проєкт', few: 'активні проєкти', many: 'активних проєктів', other: 'активного проєкту' })}`
export const MONTH_COUNT = (n) =>
  `${n} ${plural(n, { one: 'місяць', few: 'місяці', many: 'місяців', other: 'місяця' })}`

// Today's partnerShare: whole percent over Σ|balance|, negative balance → «—»; bar ≥ 2 %.
export function partnerShare(b, abs) {
  const has = abs > 0 && b >= 0
  return {
    label: has ? `${Math.round((b / abs) * 100)} %` : '—',
    bar: Math.max(2, abs > 0 ? Math.round((Math.abs(b) / abs) * 100) : 0),
  }
}
export function settle(list) {
  const sorted = [...list].sort((a, b) => b.b - a.b)
  const rich = sorted[0]
  const poor = sorted[sorted.length - 1]
  const pair = sorted.length >= 2
  const even = pair ? Math.abs(rich.b - poor.b) / 2 : 0
  return {
    sorted,
    total: sorted.reduce((s, p) => s + p.b, 0),
    abs: sorted.reduce((s, p) => s + Math.abs(p.b), 0),
    rich,
    poor,
    pair,
    even,
    balanced: pair && even <= 0.01,
  }
}

// ---------- KPIs derived from the series ----------
const sum = (a) => a.reduce((x, y) => x + y, 0)
const last = N - 1
const totalIncome = sum(S.income) * 1000
const totalExp = sum(S.expenses) * 1000
const totalSal = sum(S.salaries) * 1000
const best = S.income.indexOf(Math.max(...S.income))
export const KPIS = [
  {
    t: 'Загальний дохід',
    v: money(totalIncome),
    trend: ((S.income[last] - S.income[last - 1]) / S.income[last - 1]) * 100,
    hint: 'Сума всіх оплачених надходжень та доходу сеньйорів і адмінів за весь час.',
  },
  {
    t: 'Витрати',
    v: money(totalExp),
    hint: 'Сума всіх оплачених операційних витрат компанії.',
  },
  {
    t: 'Зарплати',
    v: money(totalSal),
    hint: 'Сума всіх виплачених зарплат співробітникам компанії за весь час.',
  },
  {
    t: 'Чистий баланс',
    v: money(totalIncome - totalExp - totalSal, 'USD', { sign: true }),
    hint: 'Чистий залишок: дохід мінус витрати та зарплати. Додатне значення = компанія в плюсі.',
  },
  {
    t: 'Дохід за останній місяць',
    v: money(S.income[last] * 1000),
    sub: MONTHS[last].name + ' ' + FULL[last].slice(-4),
    hint: 'Виручка за листопад 2026. Включає доходи всіх сеньйорів і адмінів.',
  },
  {
    t: 'Прибуток за останній місяць',
    v: money(S.profit[last] * 1000, 'USD', { sign: true }),
    sub: `Маржа: ${((S.profit[last] / S.income[last]) * 100).toFixed(1).replace('.', ',')} %`,
    hint: 'Чистий прибуток за листопад 2026: дохід мінус витрати та зарплати того місяця.',
  },
  {
    t: 'Середній дохід / міс.',
    v: money(totalIncome / N),
    sub: `за ${MONTH_COUNT(N)}`,
    hint: 'Середньомісячна виручка за весь час роботи компанії.',
  },
  {
    t: 'Найкращий місяць',
    v: money(S.income[best] * 1000),
    sub: MONTHS[best].name + ' ' + FULL[best].slice(-4),
    hint: 'Місяць із найбільшою виручкою за весь час.',
  },
]
export const PARTNER_HINT =
  'Накопичений баланс кожного партнера: усі оплачені надходження та дохід партнерів мінус перекази між партнерами. Баланси рахуються в USD, рахунок компанії — в USDT (1 USDT = 1 USD). Для вирівнювання один партнер надсилає іншому половину різниці балансів.'
export const COMPANY_HINT =
  'Накопичений USDT-баланс на рахунку компанії — поповнюється через підтверджені виплати (метод «Рахунок компанії») і зменшується виведенням дивідендів.'

// ---------- Small shared elements ----------
export const card = (inner, style = '') =>
  `<section style="background:var(--card);border:1px solid var(--border);border-radius:var(--r-xl);${style}">${inner}</section>`
export const PCOLOR = ['var(--chart-1)', 'var(--chart-2)']
export const avatar = (ini, i, s = 36) =>
  `<span aria-hidden="true" style="width:${s}px;height:${s}px;border-radius:${s / 2}px;flex:none;display:grid;place-items:center;font-size:13px;font-weight:650;background:${i === 0 ? 'var(--yellow-subtle)' : 'oklch(0.24 0.05 250)'};color:${PCOLOR[i] ?? 'var(--fg)'}">${ini}</span>`
/** Info button: 44 px target on a coarse pointer; on a fine pointer a 28 px glyph box with a 44 px hit area. */
export const infoBtn = (label, { fine = false, mr = -10 } = {}) =>
  fine
    ? `<span class="iconbtn muted" role="button" aria-label="Пояснення: ${label}" style="width:44px;height:44px;margin:-8px -8px -8px 0"><span style="width:28px;height:28px;display:grid;place-items:center">${icon('info', { size: 16 })}</span></span>`
    : `<span class="iconbtn muted" role="button" aria-label="Пояснення: ${label}" style="width:44px;height:44px;margin-right:${mr}px">${icon('info', { size: 18 })}</span>`
/** One «Повторити» button: disabled while offline (reason in the strip), busy while a retry runs (R2-07). */
export const retry = ({ h = 44, sm = false, size = 16, disabled = false, busy = false } = {}) =>
  `<span class="btn secondary ${sm ? 'sm' : ''} ${disabled ? 'dis' : ''}" role="button" ${disabled || busy ? 'aria-disabled="true"' : ''} ${busy ? 'aria-busy="true"' : ''} style="${h ? `height:${h}px;` : ''}${busy ? 'opacity:0.7' : ''}">${icon(busy ? 'loader-circle' : 'rotate-cw', { size })}Повторити</span>`
export const sk = (w, h, st = '') => `<div class="sk" style="height:${h}px;width:${w};${st}"></div>`
export const srOnly =
  'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
export const lossSwatch = `<i style="width:10px;height:10px;border-radius:2px;display:inline-block;background:repeating-linear-gradient(45deg,var(--chart-1) 0 1.5px,transparent 1.5px 4px);outline:1px solid var(--chart-1)"></i>`
export const FIT_END = '<div data-fit-end style="height:0"></div>'
