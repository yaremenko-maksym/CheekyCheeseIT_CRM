// Mobile (< 640) building blocks shared by the shell and primitive frames. Sample data is invented.
import { icon, phone, safeBottom } from './base.mjs'
import { DEST, TABS, QUICK_ADD } from './nav.mjs'

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

export function fab(role, w = 375, dim = false) {
  if (!QUICK_ADD[role].length) return ''
  return `<div class="fab" aria-label="Створити" ${dim ? 'aria-disabled="true"' : ''} style="bottom:${TABBAR_H + safeBottom(w) + 16}px;${dim ? 'opacity:0.4;box-shadow:none' : ''}">${icon('plus', { size: 26, stroke: 2.4 })}</div>`
}

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
  return `<div style="padding:4px 16px 10px"><div class="row" style="gap:8px;height:40px;border-radius:12px;background:var(--surface);padding:0 12px;color:var(--muted-fg);font-size:16px">${icon('search', { size: 18 })}<span>${ph}</span></div></div>`
}

export function chips(list, active = 0) {
  return `<div class="row" style="gap:8px;padding:0 16px 6px;overflow:hidden">${list
    .map(
      (c, i) =>
        `<span class="row" style="gap:4px;height:34px;padding:0 14px;border-radius:17px;font-size:14px;font-weight:500;white-space:nowrap;${i === active ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${c}${c.endsWith('▾') ? '' : ''}</span>`,
    )
    .join('')}</div>`
}

// Invented sample transactions — no real names or amounts.
export const TXNS = [
  {
    day: 'Сьогодні',
    t: 'Оренда офісу',
    s: 'Витрата · Проєкт «Альфа»',
    a: '−1 200,00 $',
    time: '14:20',
    ic: 'receipt',
    neg: true,
    att: true,
  },
  {
    day: 'Сьогодні',
    t: 'Оплата від клієнта',
    s: 'Дохід · Проєкт «Бета»',
    a: '+4 800,00 $',
    time: '11:05',
    ic: 'arrow-down-left',
    att: false,
  },
  {
    day: 'Сьогодні',
    t: 'Хмарний хостинг',
    s: 'Витрата · Інфраструктура',
    a: '−86,40 $',
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
    a: '−2 150,00 $',
    time: '18:40',
    ic: 'wallet',
    neg: true,
  },
  {
    day: 'Вчора',
    t: 'Переказ на рахунок компанії',
    s: 'Переказ · USDT',
    a: '−3 000,00 $',
    time: '16:02',
    ic: 'arrow-left-right',
    neg: true,
  },
  {
    day: 'Вчора',
    t: 'Оплата від клієнта',
    s: 'Дохід · Проєкт «Гамма»',
    a: '+6 250,00 $',
    time: '10:30',
    ic: 'arrow-down-left',
  },
  {
    day: '9 листопада',
    t: 'Канцтовари',
    s: 'Витрата · Офіс',
    a: '−42,15 $',
    time: '13:15',
    ic: 'receipt',
    neg: true,
    att: true,
  },
  {
    day: '9 листопада',
    t: 'Підписка на дизайн-інструмент',
    s: 'Витрата · Інструменти',
    a: '−29,00 $',
    time: '08:00',
    ic: 'receipt',
    neg: true,
  },
]

export function txnRow(x, { compact = false } = {}) {
  return `<div class="lrow two" style="--inset:64px"><div class="lead">${icon(x.ic, { size: 18 })}</div>
  <div class="grow col" style="gap:2px"><div class="t-body trunc" style="font-weight:500">${x.t}</div><div class="t-foot muted trunc row" style="gap:6px">${x.att ? icon('paperclip', { size: 13 }) : ''}<span class="trunc">${x.s}</span></div></div>
  <div class="trail"><span class="amount ${x.neg ? '' : 'pos'}">${x.a}</span>${x.pending ? '<span class="pill warn" style="height:18px;font-size:11px">Очікує</span>' : `<span class="t-cap muted num">${x.time}</span>`}</div>${compact ? '' : ''}</div>`
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
  fabDim = false,
}) {
  const inner = `${banner}${topBar()}<div class="content">${largeTitle(title, sub)}${body}<div style="height:${TABBAR_H + safeBottom(w) + 88}px"></div></div>${tabBar(role, active, { w, moreBadge })}${showFab ? fab(role, w, fabDim) : ''}`
  return phone({ w, h, inner, overlay })
}

export function financeBody() {
  return `${searchField('Пошук транзакцій')}${chips(['Усі', 'Витрати', 'Доходи', 'Проєкт ▾', 'Період ▾'])}${txnList()}`
}
