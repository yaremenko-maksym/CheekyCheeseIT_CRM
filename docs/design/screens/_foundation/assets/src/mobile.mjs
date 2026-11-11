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

export function topBar({
  back = false,
  title = '',
  bell = true,
  search = true,
  trailing = '',
} = {}) {
  return `<div class="topbar">${back ? `<div class="iconbtn" style="margin-left:-12px" aria-label="Назад">${icon('chevron-left', { size: 28, stroke: 2 })}</div>` : '<div style="width:44px"></div>'}
  <div class="title">${title}</div>${trailing}${search ? `<div class="iconbtn" aria-label="Пошук">${icon('search', { size: 22 })}</div>` : ''}${bell ? `<div class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></div>` : ''}</div>`
}

export function largeTitle(t, sub = '') {
  return `<div class="largetitle"><div class="t-large">${t}</div>${sub ? `<div class="t-foot muted" style="margin-top:2px">${sub}</div>` : ''}</div>`
}

export function searchField(ph = 'Пошук') {
  return `<div style="padding:4px 16px 10px"><div class="row" role="searchbox" style="gap:8px;height:44px;border-radius:12px;background:var(--surface);padding:0 12px;color:var(--placeholder);font-size:16px">${icon('search', { size: 18 })}<span>${ph}</span></div></div>`
}

export function chips(list, active = 0) {
  return `<div class="row" style="gap:8px;padding:0 16px 6px;overflow:hidden">${list
    .map(
      (c, i) =>
        `<span class="row" role="button" style="gap:4px;height:44px;padding:0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;${i === active ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${c}${c.endsWith('▾') ? '' : ''}</span>`,
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
    s: 'Переказ · USDT',
    a: '−3 000,00 USD',
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

export function txnRow(x, { compact = false } = {}) {
  // match: amount, currency and type equal the draft (full highlight + «збіг»); isNew: created after the send («нова» only)
  const hl = x.match
    ? ';background:oklch(0.84 0.183 85.3 / 0.1);box-shadow:inset 3px 0 0 var(--primary)'
    : ''
  return `<div class="lrow two" style="--inset:64px${hl}"><div class="lead">${icon(x.ic, { size: 18 })}</div>
  <div class="grow col" style="gap:2px"><div class="t-body trunc" style="font-weight:500">${x.t}</div><div class="t-foot muted trunc row" style="gap:6px">${x.att ? icon('paperclip', { size: 13 }) : ''}<span class="trunc">${x.s}</span></div></div>
  <div class="trail"><span class="amount ${x.neg ? '' : 'pos'}">${x.a}</span>${x.pending ? '<span class="pill warn" style="height:18px;font-size:11px">Очікує</span>' : x.match || x.isNew ? `<span class="t-cap num" style="color:var(--primary);font-weight:600">${x.match ? 'збіг' : 'нова'} · ${x.time}</span>` : `<span class="t-cap muted num">${x.time}</span>`}</div>${compact ? '' : ''}</div>`
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

export const PEOPLE = [
  ['ОК', 'Олена Коваль', 'Співбесіда з клієнтом', 'Етап 2', 'y'],
  ['ІМ', 'Ігор Мельник', 'Технічна співбесіда', 'Етап 3', 'y'],
  ['ТС', 'Тарас Савчук', 'Скринінг', 'Етап 1', ''],
  ['МП', 'Марія Петренко', 'Офер', 'Найнято', 'ok'],
  ['ДЛ', 'Дмитро Лисенко', 'Скринінг', 'Етап 1', ''],
  ['АБ', 'Анна Бондар', 'Технічна співбесіда', 'Етап 3', 'y'],
]

export function peopleList() {
  return `<div class="sechead"><span class="t-over">Цього тижня</span></div><div class="group">${PEOPLE.map(
    ([i, n, s, p, k]) =>
      `<div class="lrow two" style="--inset:64px"><div class="lead av">${i}</div><div class="grow col" style="gap:2px"><div class="t-body trunc" style="font-weight:500">${n}</div><div class="t-foot muted trunc">${s}<span class="nw-only"> · ${p}</span></div></div><span class="pill wide-only ${k}">${p}</span>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`,
  ).join('')}</div>`
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
  const bar = scrolled
    ? topBar({ title }).replace(
        '<div class="topbar">',
        '<div class="topbar" style="border-bottom:1px solid var(--separator)">',
      )
    : topBar()
  // Tab-root lists end with tab bar + FAB clearance (56 + 16 + 8 above the bar) so «+» never covers a trailing value.
  const inner = `${banner}${bar}<div class="content">${largeTitle(title, sub)}${body}<div style="height:${TABBAR_H + safeBottom(w) + 80}px"></div></div>${tabBar(role, active, { w, moreBadge })}${showFab ? fab(role, w, active) : ''}`
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
const JUNIOR_TXNS = [
  r('Сьогодні', 'Зарплата за жовтень', 'Зарплата · виплачено', '+1 200,00 USD', '12:00', 'wallet'),
  r(
    '10 жовтня',
    'Зарплата за вересень',
    'Зарплата · виплачено',
    '+1 200,00 USD',
    '12:00',
    'wallet',
  ),
  r(
    '10 вересня',
    'Зарплата за серпень',
    'Зарплата · виплачено',
    '+1 150,00 USD',
    '12:00',
    'wallet',
  ),
]
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
  return `${searchField('Пошук кандидатів')}${chips(['Усі', 'Скринінг', 'Технічна', 'Клієнт', 'Офер'])}${peopleList()}`
}
