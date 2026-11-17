// Finance list (Task 1.2): role variants and single interaction frames (pull-to-refresh, detail push,
// swipe, desktop row menu). Every name and amount below is invented seed-like data.
import { icon, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { tabScreen, topBar } from '../../../_foundation/assets/src/mobile.mjs'
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
} from './finance-list.mjs'

// ---------- Pull-to-refresh (refreshing stage; the list stays, it never blanks) ----------
const SPINNER = `<svg width="26" height="26" viewBox="0 0 24 24" role="progressbar" aria-label="Оновлення"><g stroke="var(--fg)" stroke-width="2.2" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => `<line x1="12" y1="3" x2="12" y2="7" opacity="${0.2 + i * 0.1}" transform="rotate(${i * 45} 12 12)"/>`).join('')}</g></svg>`
const ptrM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: `<div style="position:relative"><div style="position:absolute;left:0;right:0;top:4px;display:grid;place-items:center">${SPINNER}</div><div style="transform:translateY(48px)">${searchAndFilters()}${dayList(ROWS.slice(0, 5))}</div></div>`,
  })

// ---------- Detail push (tap on a row): every gated action lives here ----------
const kv = (k, v, { link = false } = {}) =>
  `<${link ? 'a href="#"' : 'div'} class="lrow" style="--inset:16px;min-height:52px"><div class="t-body muted" style="flex:none">${k}</div><div class="grow t-body" style="text-align:right;overflow-wrap:anywhere">${v}</div>${link ? icon('chevron-right', { size: 18, cls: 'chev' }) : ''}</${link ? 'a' : 'div'}>`
const detailM = (w, h) => {
  const x = ROWS[3]
  const head = `<div class="col" style="align-items:center;gap:6px;padding:8px 16px 18px;text-align:center"><h1 class="t-sub muted" style="margin:0;font-weight:400">${x.to}</h1><div class="num" style="font-size:40px;line-height:46px;font-weight:700;letter-spacing:-0.03em;white-space:nowrap">${x.a}</div>${pill(x.st).replace('vertical-align:middle', 'height:28px;padding:0 12px;font-size:13px')}</div>`
  const parts = `<div class="group">${kv('Тип', 'Зарплата')}${kv('Платник', x.from)}${kv('Отримувач', x.to, { link: true })}${kv('Дата', '16 листопада 2026, 18:40')}${kv('Проєкт', `Проєкт «${x.project}»`, { link: true })}${kv('Створив', 'Адмін Демо')}</div>`
  const receipt = `<div class="sechead"><span class="t-over">Чек</span></div><div class="group"><div class="lrow" role="button" style="min-height:52px;color:var(--primary)">${icon('paperclip', { size: 18 })}<span class="grow t-body">Прикріпити чек</span></div></div>`
  const actions = `<div class="col" style="gap:10px;padding:20px 0 8px"><span class="btn primary" style="width:100%">Розрахуватися</span><span class="btn secondary" style="width:100%">Додати частину зарплати</span></div>`
  const inner = `${topBar({ back: true, title: '', bell: false, search: false, trailing: detailActions })}<div class="content" style="padding:0 16px ${safeBottom(w) + 24}px">${head}${parts}${receipt}${actions}</div>`
  return phone({ w, h, inner })
}

// ---------- Swipe (ADMIN): trailing «Редагувати» / «Видалити»; delete opens the reason sheet ----------
const swipeM = (w, h) => {
  const swiped = `<div class="lrow two" style="padding:0;overflow:hidden;position:relative"><div class="row" style="position:absolute;right:0;top:0;bottom:0">
    <div class="col" role="button" style="width:84px;height:100%;background:oklch(0.42 0.02 250);justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('pencil', { size: 18 })}Редагувати</div>
    <div class="col" role="button" style="width:84px;height:100%;background:var(--destructive);color:#fff;justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('trash-2', { size: 18 })}Видалити</div></div>
    <div style="width:100%;transform:translateX(-168px);background:var(--card)">${row(ROWS[2]).replace('class="lrow two"', 'class="lrow two" style="background:var(--card)"')}</div></div>`
  const body = `${searchAndFilters()}<div class="sechead sticky" role="heading" aria-level="2"><span class="t-over">Сьогодні</span></div><div class="group" role="list">${row(ROWS[0])}${row(ROWS[1])}${swiped}</div>${dayList(ROWS.slice(3, 6))}`
  return tabScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', body })
}

// ---------- Desktop row menu: every action of the row, the inline one first ----------
const rowMenuD = (w, h) => {
  const items = [
    ['arrow-up-right', 'Відкрити', 'Enter'],
    ['hand-coins', 'Розрахуватися'],
    ['plus', 'Додати частину зарплати'],
    ['paperclip', 'Прикріпити чек'],
    ['pencil', 'Редагувати', 'E'],
  ]
  const menu = `<div role="menu" aria-label="Дії з транзакцією" style="position:absolute;right:30px;top:${56 + 20 + 32 + 14 + 1 + 36 + 4 * 40 - 2}px;width:260px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px">${items
    .map(
      ([ic, t, k]) =>
        `<div role="menuitem" class="row" style="gap:10px;height:34px;padding:0 10px;border-radius:8px;font-size:13px">${icon(ic, { size: 15 })}<span class="grow">${t}</span>${k ? `<span class="kbdkey">${k}</span>` : ''}</div>`,
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
const PEND = [
  ROWS[1],
  { ...ROWS[3], act: 'Додати частину зарплати' },
  {
    day: '15 листопада',
    d: '15.11',
    time: '17:20',
    from: 'Клієнт «Схід»',
    to: 'Ігор Демо',
    type: 'SENIOR_INCOME',
    project: 'Гамма',
    st: 'PENDING',
    a: '+2 900,00 USD',
    act: 'Перевірити',
  },
  {
    day: '14 листопада',
    d: '14.11',
    time: '11:45',
    from: 'Клієнт «Захід»',
    to: 'Олег Демо',
    type: 'SENIOR_INCOME',
    project: 'Альфа',
    st: 'PENDING',
    a: '+1 750,00 USD',
    act: 'Перевірити',
  },
]
const accM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'ACCOUNTANT',
    active: '/finance',
    title: 'Фінанси',
    body: `${searchAndFilters({ active: ['Очікує валідації'], count: 1 })}${dayList(PEND)}`,
  })
const accD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'ACCOUNTANT',
    body: `${toolbar({ w, status: 'Очікує валідації', deleted: false, total: 4 }).replace('4 транзакції', '4 з 132')}${table(
      PEND,
      { w, sel: 0 },
    )}`,
  })

// ---------- SENIOR: own projects; company-share strip + batch payout ----------
const SEN = [
  {
    ...ROWS[1],
    st: 'VALIDATED',
    act: 'Виплатити',
  },
  {
    day: 'Вчора',
    d: '16.11',
    time: '12:00',
    from: 'Клієнт «Схід»',
    to: 'Олег Демо',
    type: 'SENIOR_INCOME',
    project: 'Гамма',
    st: 'VALIDATED',
    a: '+2 600,00 USD',
    act: 'Виплатити',
  },
  { ...ROWS[4], to: COMPANY, from: 'Олег Демо', act: 'Оплатити' },
  {
    day: '13 листопада',
    d: '13.11',
    time: '10:10',
    from: 'Клієнт «Північ»',
    to: 'Олег Демо',
    type: 'SENIOR_INCOME',
    project: 'Бета',
    st: 'PAID',
    a: '+3 100,00 USD',
  },
]
const strip = (wide = false) =>
  `<div class="row" style="gap:12px;${wide ? '' : 'margin:0 16px 10px;'}padding:12px 12px 12px 16px;border-radius:14px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);flex-wrap:wrap"><div class="grow col" style="gap:3px;min-width:180px"><div class="row" style="gap:8px;flex-wrap:wrap"><span style="font-size:${wide ? 14 : 15}px;font-weight:600">Частка CheekyCheeseIT до сплати</span><span class="pill warn" style="height:20px;font-size:11px">2 проєкти</span></div><span class="num" style="font-size:${wide ? 20 : 22}px;font-weight:700">1 440,00 USD</span><span class="t-foot muted">За перевіреними доходами, які ще не включено в заявку на виплату</span></div><span class="btn primary" style="height:44px;${wide ? '' : 'width:100%'}">Оплатити</span></div>`
const payBtn = `<div style="padding:0 16px 10px"><span class="btn secondary" style="width:100%;height:44px">${icon('wallet', { size: 18 })}Виплатити (2)</span></div>`
const senM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'SENIOR',
    active: '/finance',
    title: 'Фінанси',
    body: `${strip()}${payBtn}${searchAndFilters()}${dayList(SEN)}`,
  })
const senD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'SENIOR',
    actions: `<span class="btn secondary" style="height:36px;font-size:14px;padding:0 12px;border-radius:9px">${icon('wallet', { size: 16 })}Виплатити (2)</span><span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Нова транзакція<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span></span>`,
    body: `${strip(true)}${toolbar({ w, total: 4 })}${table(SEN, { w, sel: -1 })}`,
  })

// ---------- HR: own salary only, reached from «Ще» (pushed page, no create) ----------
const SAL = [
  ['Листопад 2026', '—', 'PENDING', '1 300,00 USD'],
  ['Жовтень 2026', '05.11.2026', 'PAID', '1 300,00 USD'],
  ['Вересень 2026', '06.10.2026', 'PAID', '1 300,00 USD'],
  ['Серпень 2026', '05.09.2026', 'PAID', '1 250,00 USD'],
  ['Липень 2026', '05.08.2026', 'PAID', '1 250,00 USD'],
]
const salRow = ([m, d, st, a], lead = 'Зарплата') =>
  `<div class="lrow two" role="link" style="--inset:64px"><div class="lead">${icon('wallet', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px"><div class="t-body grow" style="font-weight:500">${m}</div><span class="amount">${a}</span></div><div class="t-foot muted trunc">${lead} · ${d === '—' ? 'ще не виплачено' : `виплачено <span class="num">${d.slice(0, 5)}</span>`}</div>${st === 'PAID' ? '' : `<div style="margin-top:3px">${pill(st, { small: true })}</div>`}</div></div>`
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
      '<th>Місяць</th><th>Дата виплати</th><th>Статус</th><th class="r">Сума</th>',
      SAL.map(
        ([m, d, st, a], i) =>
          `<tr ${i === 1 ? 'class="hover"' : ''}><td>${m}</td><td class="num muted">${d}</td><td>${pill(st)}</td><td class="r"><span class="amount" style="font-size:14px">${a}</span></td></tr>`,
      ).join(''),
    ),
  })

// ---------- JUNIOR: own salary with project; the tx hash is copyable ----------
const JUN = SAL.map((s, i) => [
  ...s,
  ['Альфа', 'Альфа', 'Бета', 'Бета', 'Бета'][i],
  i === 0 ? '' : `0x7f3a${i}c9e1b2d4…`,
])
const junM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'JUNIOR',
    active: '/finance',
    title: 'Фінанси',
    body: `<div class="group" role="list" style="margin-top:4px">${JUN.map((s) => salRow(s, `Проєкт «${s[4]}»`)).join('')}</div>`,
  })
const copyBtn = `<span class="iconbtn" aria-label="Копіювати хеш" style="width:28px;height:28px">${icon('copy', { size: 14 })}</span>`
const junD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'JUNIOR',
    actions: '',
    body: simpleTable(
      '<th>Місяць</th><th>Проєкт</th><th>Дата виплати</th><th>Статус</th><th>Хеш транзакції</th><th class="r">Сума</th>',
      JUN.map(
        ([m, d, st, a, p, hash]) =>
          `<tr><td>${m}</td><td class="muted">${p}</td><td class="num muted">${d}</td><td>${pill(st)}</td><td>${hash ? `<span class="row" style="gap:4px"><span class="num muted" style="font-family:ui-monospace,monospace;font-size:12px">${hash}</span>${copyBtn}</span>` : '<span class="muted">—</span>'}</td><td class="r"><span class="amount" style="font-size:14px">${a}</span></td></tr>`,
      ).join(''),
    ),
  })

// ---------- DROP: balance, own incomes (status + period filters), payments to the company ----------
const stat = (k, v, tone = '') =>
  `<div class="col" style="gap:2px;min-width:0"><span class="t-foot muted">${k}</span><span class="num" style="font-size:18px;font-weight:700;${tone}">${v}</span></div>`
const balance = (wide = false) =>
  `<section aria-label="Мій баланс" style="${wide ? '' : 'margin:0 16px 12px;'}padding:14px 16px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-head" style="font-size:15px;margin-bottom:10px">Мій баланс</div><div style="display:grid;grid-template-columns:repeat(${wide ? 4 : 2},minmax(0,1fr));gap:12px 16px">${stat('Виплачено', '8 400,00 USD')}${stat('Очікує виплати', '1 250,00 USD')}${stat('Частка', '30%')}${stat('У роботі', '2 доходи')}</div>
  <div class="row" style="gap:10px;margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border)"><span style="color:var(--warning);display:grid">${icon('circle-alert', { size: 16 })}</span><div class="grow col" style="gap:1px"><span style="font-size:14px;font-weight:600">Ви маєте сплатити компанії <span class="num">300,00 USD</span></span><span class="t-foot muted">Підтверджені доходи, які ви ще не перерахували</span></div></div></section>`
const DINC = [
  ['14.11', 'Клієнт «Захід»', '+3 400,00 USD', 'Ваша частка', 'Дохід', 'VALIDATED'],
  ['12.11', 'Клієнт «Північ»', '+1 250,00 USD', 'Валовий дохід', 'Нарахування', 'PENDING'],
  ['08.11', 'Клієнт «Захід»', '+2 100,00 USD', 'Ваша частка', 'Дохід', 'PAID'],
  ['02.11', 'Клієнт «Схід»', '+900,00 USD', 'Ваша частка', 'Дохід', 'PAID'],
]
const DPAY = [
  ['16.11', '300,00 USD', 'Очікує', 'warn'],
  ['01.11', '640,00 USD', 'Підтверджено', 'ok'],
  ['20.10', '210,00 USD', 'Не пройшов', 'err'],
]
const dropIncRow = ([d, c, a, al, t, st]) =>
  `<div class="lrow two" role="link" style="--inset:64px"><div class="lead">${icon('arrow-down-left', { size: 18 })}</div><div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:12px;align-items:flex-start"><div class="t-body grow" style="font-weight:500">${c}</div><span class="col" style="align-items:flex-end"><span class="amount pos">${a}</span><span class="t-cap muted">${al}</span></span></div><div class="t-foot muted trunc"><span class="num">${d}</span> · ${t}</div>${st === 'PAID' ? '' : `<div style="margin-top:3px">${pill(st === 'PENDING' ? 'PENDING' : st, { small: true })}</div>`}</div></div>`
const dropPayRow = ([d, a, s, tone]) =>
  `<div class="lrow" style="--inset:64px;min-height:56px"><div class="lead">${icon('arrow-up-right', { size: 18 })}</div><div class="grow col" style="gap:2px"><span class="t-body">Переказ на рахунок компанії</span><span class="t-foot muted num">${d}</span></div><span class="col" style="align-items:flex-end;gap:4px"><span class="amount">${a}</span><span class="pill ${tone}" style="height:18px;font-size:11px;padding:0 6px"${tone === 'err' ? ' title="Переказ не пройшов — зверніться до адміністратора"' : ''}>${s}</span></span></div>`
const dropM = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'DROP',
    active: '/finance',
    title: 'Фінанси',
    body: `${balance()}<div class="sechead" role="heading" aria-level="2"><span class="t-over">Мої доходи</span></div>${searchAndFilters({ active: ['Поточний місяць'], count: 1 }).replace(/^<div style="padding:4px 16px 10px">[\s\S]*?<\/div><\/div>\s*/, '')}<div class="group" role="list" style="margin-top:6px">${DINC.map(dropIncRow).join('')}</div><div class="sechead" role="heading" aria-level="2"><span class="t-over">Платежі на компанію</span></div><div class="group" role="list">${DPAY.map(dropPayRow).join('')}</div>`,
  }).replace(/(<div class="fab" role="button" aria-label=")[^"]*"/, '$1Зареєструвати дохід"')
const dropD = (w, h) =>
  desktopFrame({
    w,
    h,
    role: 'DROP',
    actions: `<span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Зареєструвати дохід</span>`,
    body: `${balance(true)}<div class="row" style="gap:8px;flex:none"><h2 class="t-over grow" style="margin:0">Мої доходи</h2><span class="row" role="button" style="gap:6px;height:32px;padding:0 10px;border-radius:8px;font-size:13px;border:1px solid var(--input-border);color:var(--muted-fg)">Усі статуси${icon('chevron-down', { size: 13 })}</span><span class="row" role="button" style="gap:6px;height:32px;padding:0 10px;border-radius:8px;font-size:13px;background:var(--yellow-subtle);border:1px solid oklch(0.32 0.06 85)">Поточний місяць${icon('x', { size: 13 })}</span></div>${simpleTable(
      '<th>Дата</th><th>Компанія</th><th>Тип</th><th>Статус</th><th class="r">Сума</th>',
      DINC.map(
        ([d, c, a, al, t, st]) =>
          `<tr><td class="num muted">${d}</td><td>${c}</td><td class="muted">${t}</td><td>${pill(st)}</td><td class="r"><span class="amount pos" style="font-size:14px">${a}</span><div class="t-cap muted" style="line-height:12px">${al}</div></td></tr>`,
      ).join(''),
      'Мої доходи',
    ).replace(
      'class="grow"',
      'style="flex:none"',
    )}<h2 class="t-over" style="margin:6px 0 0">Платежі на компанію</h2>${simpleTable(
      '<th>Дата</th><th>Призначення</th><th>Статус</th><th class="r">Сума</th>',
      DPAY.map(
        ([d, a, s, tone]) =>
          `<tr><td class="num muted">${d}</td><td>Переказ на рахунок компанії</td><td><span class="pill ${tone}">${s}</span></td><td class="r num">${a}</td></tr>`,
      ).join(''),
      'Платежі на компанію',
    ).replace('class="grow"', 'style="flex:none"')}`,
  })

export function roleFrames() {
  const pair = (name, m, d) => [
    M(`${name}-375`, 375, 812, m(375, 812)),
    D(`${name}-1440`, 1440, 900, d(1440, 900)),
  ]
  return [
    M('ptr-375', 375, 812, ptrM(375, 812)),
    M('detail-375', 375, 812, detailM(375, 812)),
    M('swipe-375', 375, 812, swipeM(375, 812)),
    D('row-menu-1440', 1440, 900, rowMenuD(1440, 900)),
    ...pair('role-accountant', accM, accD),
    ...pair('role-senior', senM, senD),
    ...pair('role-hr', hrM, hrD),
    ...pair('role-junior', junM, junD),
    ...pair('role-drop', dropM, dropD),
  ]
}
