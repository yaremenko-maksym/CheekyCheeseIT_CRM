// Mobile (< 640) building blocks shared by the shell and primitive frames. Sample data is invented.
import { icon, phone, safeBottom } from './base.mjs'
import { DEST, TABS, QUICK_ADD, ACTIONS } from './nav.mjs'

export const TABBAR_H = 50

export function tabBar(role, active, { w = 375, moreBadge = 3 } = {}) {
  const tabs = TABS[role]
    .map((d) => {
      const on = d === active
      return `<div class="tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}">${icon(DEST[d].icon, { size: 24, stroke: on ? 2.1 : 1.75 })}<span>${DEST[d].label}</span></div>`
    })
    .join('')
  const more = `<div class="tab ${active === 'more' ? 'on' : ''}">${icon('ellipsis', { size: 24 })}<span>Ще</span>${moreBadge ? `<b class="badge num">${moreBadge}</b>` : ''}</div>`
  return `<nav class="tabbar" aria-label="Основна навігація" style="padding-bottom:${safeBottom(w)}px"><div class="tabs">${tabs}${more}</div></nav>`
}

// Context «+»: on a tab whose screen owns a create action in the role's set, «+» opens that action
// directly; elsewhere it opens the «Створити» menu. Offline it stays enabled (saving gives the definite alert).
export const CONTEXT_ADD = {
  '/finance': 'txn',
  '/users': 'user',
  '/interviews': 'interview',
  '/vacancies': 'vacancy',
}
export function fab(role, w = 375, active = '') {
  if (!QUICK_ADD[role].length) return ''
  const direct = QUICK_ADD[role].includes(CONTEXT_ADD[active])
    ? ACTIONS[CONTEXT_ADD[active]].label
    : ''
  return `<div class="fab" role="button" aria-label="${direct || 'Створити'}" ${direct ? '' : 'aria-haspopup="dialog"'} style="bottom:${TABBAR_H + safeBottom(w) + 16}px">${icon('plus', { size: 26, stroke: 2.4 })}</div>`
}
// Floating layer: toast and upload pill sit left of the FAB (16 + 56 + 8 = 80 px right inset) above the tab bar.
export const FLOAT_RIGHT = 80
// R1-04 / D-8: no per-row inset and no band. A MONEY list (Фінанси) has no floating «+»: its one create entry is a
// docked 48 px primary button in a 64 px strip above the tab bar, so nothing floats over an amount and a row is never
// covered (the list ends with the strip + 16). Lists without an amount column (people, interviews, vacancies) keep the FAB.
export const MONEY_LISTS = new Set(['/finance'])
// R5-26: the bar's magnifier only where the page has an inline search (Статистика and Дашборд have none).
export const NO_SEARCH = new Set(['/stats', '/'])
export const DOCK_H = 64
// R5-27: under a 600 px viewport (320 × 568) the dock is compact: a 44 px button in a 52 px strip.
export const dockH = (h = 812) => (h < 600 ? 52 : DOCK_H)
export function createDock(role, active, w, h = 812) {
  const key = CONTEXT_ADD[active]
  if (!MONEY_LISTS.has(active) || !QUICK_ADD[role].includes(key)) return ''
  const label = ACTIONS[key].label
  const c = h < 600
  return `<div class="dock" style="position:absolute;left:0;right:0;bottom:${TABBAR_H + safeBottom(w)}px;z-index:44;height:${dockH(h)}px;padding:${c ? 4 : 8}px 16px;background:var(--bg);border-top:1px solid var(--separator)"><div class="btn primary" role="button" aria-label="${label}" style="position:relative;width:100%;height:${c ? 44 : 48}px;font-size:17px">${icon('plus', { size: 22, stroke: 2.4 })}${label}</div></div>`
}

export function topBar({
  back = false,
  title = '',
  bell = true,
  search = true,
  trailing = '',
  side = 56,
} = {}) {
  // Pushed page: the title is centred on the bar, inset on both sides by the wider side (back or the
  // trailing actions), so it truncates before it collides and never drifts off centre.
  if (back)
    return `<div class="topbar" style="position:relative"><button type="button" class="iconbtn" style="margin-left:-12px" aria-label="Назад">${icon('chevron-left', { size: 28, stroke: 2 })}</button>
  <div class="title trunc" style="position:absolute;left:${side}px;right:${side}px;top:0;line-height:44px">${title}</div><div class="grow"></div>${trailing}${search ? `<div class="iconbtn" aria-label="Пошук">${icon('search', { size: 22 })}</div>` : ''}${bell ? `<div class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></div>` : ''}</div>`
  return `<div class="topbar"><div style="width:${Math.max(44, (trailing ? 44 : 0) + (search ? 44 : 0) + (bell ? 44 : 0))}px"></div>
  <div class="title">${title}</div>${trailing}${search ? `<div class="iconbtn" aria-label="Пошук">${icon('search', { size: 22 })}</div>` : ''}${bell ? `<div class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></div>` : ''}</div>`
}

export function largeTitle(t, sub = '') {
  return `<div class="largetitle"><div class="t-large">${t}</div>${sub ? `<div class="t-foot muted" style="margin-top:2px">${sub}</div>` : ''}</div>`
}

export function searchField(ph = 'Пошук') {
  return `<div style="padding:4px 16px 10px"><div class="row" role="searchbox" style="gap:8px;height:44px;border-radius:12px;background:var(--surface);padding:0 12px;color:var(--placeholder);font-size:16px">${icon('search', { size: 18 })}<span>${ph}</span></div></div>`
}

export function chips(list, active = 0) {
  // A row that does not fit scrolls sideways and fades out at the end (F0-24), so a cut chip reads as "more".
  return `<div class="row" style="gap:8px;padding:0 16px 6px;overflow:hidden;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 32px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 32px),transparent)">${list
    .map(
      (c, i) =>
        `<span class="row" role="button" style="gap:4px;height:44px;padding:0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;${i === active ? 'background:var(--fg);color:var(--bg)' : c.endsWith('▾') ? 'background:none;color:var(--muted-fg);border:1px dashed var(--input-border)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${c.endsWith('▾') ? `${icon('plus', { size: 14 })}${c.slice(0, -2)}` : c}</span>`,
    )
    .join('')}</div>`
}

// Invented sample transactions — no real names or amounts.
export const TXNS = [
  {
    day: 'Сьогодні',
    t: 'Оренда офісу',
    s: 'Витрата · Проєкт «Альфа»',
    a: '−1 200,00 USD',
    time: '14:20',
    ic: 'receipt',
    neg: true,
    att: true,
  },
  {
    day: 'Сьогодні',
    t: 'Оплата від клієнта',
    s: 'Дохід · Проєкт «Бета»',
    a: '+4 800,00 USD',
    time: '11:05',
    ic: 'arrow-down-left',
    att: false,
  },
  {
    day: 'Сьогодні',
    t: 'Хмарний хостинг',
    s: 'Витрата · Інфраструктура',
    a: '−86,40 USD',
    time: '09:12',
    ic: 'receipt',
    neg: true,
    att: true,
    pending: true,
  },
  {
    day: 'Вчора',
    t: 'Зарплата · Розробник 4',
    s: 'Зарплата · Проєкт «Альфа»',
    a: '−2 150,00 USD',
    time: '18:40',
    ic: 'wallet',
    neg: true,
  },
  {
    day: 'Вчора',
    t: 'Переказ на рахунок компанії',
    s: 'Переказ · Рахунок компанії',
    a: '−3 000,00 USDT',
    time: '16:02',
    ic: 'arrow-left-right',
    neg: true,
  },
  {
    day: 'Вчора',
    t: 'Оплата від клієнта',
    s: 'Дохід · Проєкт «Гамма»',
    a: '+6 250,00 USD',
    time: '10:30',
    ic: 'arrow-down-left',
  },
  {
    day: '9 листопада',
    t: 'Канцтовари',
    s: 'Витрата · Офіс',
    a: '−42,15 USD',
    time: '13:15',
    ic: 'receipt',
    neg: true,
    att: true,
  },
  {
    day: '9 листопада',
    t: 'Підписка на дизайн-інструмент',
    s: 'Витрата · Інструменти',
    a: '−29,00 USD',
    time: '08:00',
    ic: 'receipt',
    neg: true,
  },
]

/**
 * R1-03: a day total is derived from the rows drawn, per currency, and never sums two currencies
 * (USD and USDT stay apart). Each total is a nowrap span, so an amount and its code never break.
 */
export function dayTotal(rows) {
  const sums = new Map()
  for (const r of rows) {
    const m = r.a.match(/^([+−])([\d ]+,\d\d) ([A-Z]+)$/)
    if (!m) throw new Error(`dayTotal: unparsable amount ${r.a}`)
    const cents = Math.round(parseFloat(m[2].replace(/ /g, '').replace(',', '.')) * 100)
    sums.set(m[3], (sums.get(m[3]) ?? 0) + (m[1] === '−' ? -cents : cents))
  }
  return [...sums]
    .map(([cur, c]) => {
      const n = (Math.abs(c) / 100)
        .toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+,)/g, ' ')
      return `<span style="white-space:nowrap">${c < 0 ? '−' : '+'}${n} ${cur}</span>`
    })
    .join(' · ')
}

// R1-00 / R2-36, the one list-row rule (primitives-v2 §12.0): the title wraps to at most 2 lines (the full text stays in
// the accessible name), the meta wraps to at most 2 lines, status first, then time, clip, type, project.
// Amount, percentage and time never truncate.
const CLAMP2 =
  'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere'

export function txnRow(x, { compact = false, menu = false } = {}) {
  // match: every sent field equal and created after the send by server time (full highlight + «збіг»);
  // tag: a muted label that never highlights («схожа», «раніше»); isNew: created after the send («нова» only)
  // R4-23: every tag leads the meta line, as «збіг» does: «схожа · інший опис · 14:33 · …» (the meta wraps to
  // two lines at most), never a third line of its own. Otherwise the meta is time first: «14:20 · Витрата · …».
  const tagLine = false
  const warn = x.warn ? ';color:var(--warning);font-weight:600' : ''
  const mark = x.pending
    ? '<span class="pill warn" style="display:inline-flex;vertical-align:middle;height:18px;font-size:11px;margin-right:6px">Очікує</span>'
    : x.match
      ? '<span style="color:var(--primary);font-weight:600">збіг</span> · '
      : x.isNew
        ? 'нова · '
        : x.tag && !tagLine
          ? `${warn ? `<span style="${warn.slice(1)}">${x.tag}</span>` : x.tag} · `
          : ''
  const clip = x.att
    ? `<span style="display:inline-flex;vertical-align:-2px">${icon('paperclip', { size: 13 })}</span> `
    : ''
  const meta = `<div class="t-foot muted" style="${CLAMP2}">${mark}<span class="num">${x.time}</span> · ${clip}${x.s}</div>`
  const tagRow = tagLine
    ? `<span class="t-cap${x.warn ? '' : ' muted'}" style="white-space:nowrap${warn}">${x.tag}</span>`
    : ''
  const hl = x.match
    ? ';background:oklch(0.84 0.183 85.3 / 0.1);box-shadow:inset 3px 0 0 var(--primary)'
    : ''
  return `<div class="lrow two" style="--inset:64px${hl}"><div class="lead">${icon(x.ic, { size: 18 })}</div>
  <div class="grow col" style="gap:2px"><div class="row" style="align-items:flex-start;gap:12px"><div class="t-body grow clamp2" style="font-weight:500;min-width:0">${x.t}</div><span class="amount ${x.neg ? '' : 'pos'}" style="flex:none">${x.a}</span></div>${meta}${tagRow}</div>${menu ? `<button type="button" class="iconbtn" aria-haspopup="menu" aria-label="Дії: ${x.t}" style="margin-right:-8px;flex:none">${icon('ellipsis', { size: 22 })}</button>` : ''}</div>`
}

export function txnList(rows = TXNS, { stickyFirst = true } = {}) {
  const days = [...new Set(rows.map((r) => r.day))]
  return days
    .map(
      (d, i) =>
        `<div class="sechead ${i === 0 && stickyFirst ? '' : ''}"><span class="t-over">${d}</span></div><div class="group">${rows
          .filter((r) => r.day === d)
          .map((r) => txnRow(r))
          .join('')}</div>`,
    )
    .join('')
}

// One stage vocabulary everywhere (F0-27): the board's column names; the pill is the next slot (as on the card).
export const PEOPLE = [
  ['ОК', 'Олена Коваль', 'Англійська', '12.11 · 11:00', 'y'],
  ['ІМ', 'Ігор Мельник', 'Технічна', '12.11 · 16:00', 'y'],
  ['ТС', 'Тарас Савчук', 'HR-скринінг', '12.11 · 10:00', ''],
  ['МП', 'Марія Петренко', 'Офер', 'до 18.11', 'ok'],
  ['ДЛ', 'Дмитро Лисенко', 'HR-скринінг', '12.11 · 15:30', ''],
  ['АБ', 'Анна Бондар', 'Технічна', '13.11 · 10:30', 'y'],
]

// R3-08: `fine` (pointer: fine) reserves the «…» slot but draws the button only on the `hover` row (hover / focus / selected).
export function peopleList({ menu = false, omit = '', fine = false, hover = -1 } = {}) {
  return `<div class="sechead"><span class="t-over">Цього тижня</span></div><div class="group">${PEOPLE.filter(
    ([, n]) => n !== omit,
  )
    .map(
      ([i, n, s, p, k], idx) =>
        `<div class="lrow two" style="--inset:64px"><div class="lead av">${i}</div><div class="grow col" style="gap:2px"><div class="t-body clamp2" style="font-weight:500">${n}</div><div class="t-foot muted" style="overflow-wrap:anywhere">${s}<span class="nw-only"> · ${p}</span></div></div><span class="pill wide-only ${k}">${p}</span>${menu ? `<button type="button" class="iconbtn" aria-haspopup="menu" aria-label="Дії: ${n}" style="margin-right:-8px;flex:none${fine && idx !== hover ? ';visibility:hidden' : ''}">${icon('ellipsis', { size: 22 })}</button>` : icon('chevron-right', { size: 18, cls: 'chev' })}</div>`,
    )
    .join('')}</div>`
}

/** A tab-root screen: status bar, top bar, large title, scroll content, tab bar, «+». */
export function tabScreen({
  w = 375,
  h = 812,
  role,
  active,
  title,
  sub = '',
  body,
  banner = '',
  overlay = '',
  moreBadge = 3,
  showFab = true,
  scrolled = false,
}) {
  // Scrolled past the large title: it collapses into the inline 44 px bar (title centred, hairline below).
  const dockOn = createDock(role, active, w, h)
  // A modal layer (scrim, alert dialog, dialog) takes the dock out, as it does the FAB (shell-v2 §2): no yellow band peeks between the sheet groups. The list keeps its padding, so nothing shifts.
  const dock = /class="scrim"|role="(alert)?dialog"/.test(overlay) ? '' : dockOn
  const bar = scrolled
    ? topBar({ title, search: !NO_SEARCH.has(active) }).replace(
        '<div class="topbar">',
        '<div class="topbar" style="border-bottom:1px solid var(--separator)">',
      )
    : topBar({ search: !NO_SEARCH.has(active) })
  // Tab-root lists end with tab bar + FAB clearance (FAB 56 + 16), so «+» never covers a value; money lists have no FAB (R1-04).
  // Banners sit in the slot under the top bar (F0-15), above the large title.
  // R6-04: a scroll offset moves the title and everything under it as ONE scrollport, clipped by .content, so the outgoing
  // large title never paints over the chips. `scrolled` may be a number: the offset in px.
  const off = typeof scrolled === 'number' ? scrolled : 0
  const inner = `${bar}${banner}<div class="content">${off ? `<div style="transform:translateY(-${off}px)">` : ''}${largeTitle(title, sub)}${body}${off ? '</div>' : ''}<div style="height:${TABBAR_H + safeBottom(w) + (dockOn ? dockH(h) + 16 : 72)}px"></div></div>${tabBar(role, active, { w, moreBadge })}${dock}${showFab && !MONEY_LISTS.has(active) ? fab(role, w, active) : ''}`
  // The pill and the toast stack above the dock and span the width: no FAB slot beside them.
  if (dockOn)
    overlay = overlay.replace(
      /right:80px;bottom:(\d+)px/g,
      (_, b) => `right:12px;bottom:${Number(b) + dockH(h)}px`,
    )
  return phone({ w, h, inner, overlay })
}

// Role-plausible rows: a SENIOR sees only their own projects' money, a DROP only drop income and
// payouts, a JUNIOR only their own salary. ADMIN and ACCOUNTANT see the company-wide TXNS above.
const r = (day, t, s, a, time, ic, neg = false, att = false) => ({
  day,
  t,
  s,
  a,
  time,
  ic,
  neg,
  att,
})
const SENIOR_TXNS = [
  r(
    'Сьогодні',
    'Оплата від клієнта',
    'Дохід · Проєкт «Альфа»',
    '+4 800,00 USD',
    '11:05',
    'arrow-down-left',
  ),
  r(
    'Сьогодні',
    'Ліцензія IDE',
    'Витрата · Проєкт «Альфа»',
    '−24,90 USD',
    '09:40',
    'receipt',
    true,
    true,
  ),
  r(
    'Вчора',
    'Виплата за жовтень',
    'Виплата · Проєкт «Альфа»',
    '−2 400,00 USD',
    '18:10',
    'wallet',
    true,
  ),
  r(
    'Вчора',
    'Тестові пристрої',
    'Витрата · Проєкт «Альфа»',
    '−180,00 USD',
    '12:30',
    'receipt',
    true,
    true,
  ),
  r(
    '9 листопада',
    'Оплата від клієнта',
    'Дохід · Проєкт «Альфа»',
    '+3 900,00 USD',
    '10:00',
    'arrow-down-left',
  ),
  r(
    '9 листопада',
    'Хмарний хостинг',
    'Витрата · Проєкт «Альфа»',
    '−42,00 USD',
    '08:15',
    'receipt',
    true,
    true,
  ),
]
const DROP_TXNS = [
  r(
    'Сьогодні',
    'Надходження від клієнта',
    'Дохід · Проєкт «Бета»',
    '+2 600,00 USD',
    '10:20',
    'arrow-down-left',
  ),
  r('Вчора', 'Виплата частки', 'Виплата · Проєкт «Бета»', '−2 340,00 USD', '17:45', 'wallet', true),
  r(
    '6 листопада',
    'Надходження від клієнта',
    'Дохід · Проєкт «Бета»',
    '+2 600,00 USD',
    '09:30',
    'arrow-down-left',
  ),
  r(
    '6 листопада',
    'Виплата частки',
    'Виплата · Проєкт «Бета»',
    '−2 340,00 USD',
    '16:05',
    'wallet',
    true,
  ),
]
export const JUNIOR_TXNS = [
  r('Сьогодні', 'Зарплата за жовтень', 'Зарплата', '+1 200,00 USD', '12:00', 'wallet'),
  r('10 жовтня', 'Зарплата за вересень', 'Зарплата', '+1 200,00 USD', '12:00', 'wallet'),
  r('10 вересня', 'Зарплата за серпень', 'Зарплата', '+1 150,00 USD', '12:00', 'wallet'),
].map((x) => ({ ...x, tag: 'виплачено' })) // R3-23: the status leads the meta («виплачено · 12:00 · Зарплата»)
const ROLE_FINANCE = {
  SENIOR: [SENIOR_TXNS, ['Усі', 'Витрати', 'Доходи', 'Період ▾']],
  SENIOR_TEAMLESS: [SENIOR_TXNS, ['Усі', 'Витрати', 'Доходи', 'Період ▾']],
  DROP: [DROP_TXNS, ['Усі', 'Доходи', 'Виплати', 'Період ▾']],
  JUNIOR: [JUNIOR_TXNS, ['Усі', 'Період ▾']],
}

export function financeBody(role = 'ADMIN') {
  const [rows, chipList] = ROLE_FINANCE[role] ?? [
    TXNS,
    ['Усі', 'Витрати', 'Доходи', 'Проєкт ▾', 'Період ▾'],
  ]
  return `${searchField('Пошук транзакцій')}${chips(chipList)}${txnList(rows)}`
}

/** Interviews list body (HR): search, stage chips, people rows. */
export function interviewsBody() {
  return `${searchField('Пошук співбесід')}${chips(['Усі', 'HR-скринінг', 'Технічна', 'З клієнтом', 'Офер'])}${peopleList()}`
}
