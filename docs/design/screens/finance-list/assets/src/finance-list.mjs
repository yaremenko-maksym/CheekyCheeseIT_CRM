// Finance list (Task 1.2) HTML prototypes on the foundation v2 tokens and helpers.
// Every name and amount below is invented seed-like data: no real people, companies or money.
import { icon, page, phone, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { DEST, GROUPS, TABS, allowed } from '../../../_foundation/assets/src/nav.mjs'
import { tabScreen, topBar, tabBar, TABBAR_H } from '../../../_foundation/assets/src/mobile.mjs'
import { brandMark } from '../../../_foundation/assets/src/tablet.mjs'

// ---------- Data ----------
// st: PENDING | VALIDATED | PENDING_PAYMENT | REJECTED | PAID | LOCKED | PENDING_CASH_CONFIRM
export const ROWS = [
  {
    day: 'Сьогодні',
    d: '17.11',
    time: '14:20',
    from: 'Рахунок компанії',
    to: 'Оренда офісу',
    type: 'EXPENSE',
    project: 'Альфа',
    st: 'PAID',
    a: '−1 200,00 USD',
    att: true,
  },
  {
    day: 'Сьогодні',
    d: '17.11',
    time: '11:05',
    from: 'Клієнт «Північ»',
    to: 'Олег Демо',
    type: 'SENIOR_INCOME',
    project: 'Бета',
    st: 'PENDING',
    a: '+4 800,00 USD',
    act: 'Перевірити',
  },
  {
    day: 'Сьогодні',
    d: '17.11',
    time: '09:12',
    from: 'Рахунок компанії',
    to: 'Хмарний хостинг',
    type: 'EXPENSE',
    project: 'Інфраструктура',
    st: 'PAID',
    a: '−86,40 USD',
    att: true,
  },
  {
    day: 'Вчора',
    d: '16.11',
    time: '18:40',
    from: 'Рахунок компанії',
    to: 'Розробник 4',
    type: 'SALARY',
    project: 'Альфа',
    st: 'PENDING',
    a: '−2 150,00 USD',
    act: 'Розрахуватися',
  },
  {
    day: 'Вчора',
    d: '16.11',
    time: '16:02',
    from: 'Олег Демо',
    to: 'Рахунок компанії',
    type: 'PAYOUT',
    project: 'Бета',
    st: 'PENDING_PAYMENT',
    a: '−3 000,00 USD',
    act: 'Підтвердити оплату',
  },
  {
    day: 'Вчора',
    d: '16.11',
    time: '10:30',
    from: 'Клієнт «Схід»',
    to: 'Адмін Демо',
    type: 'ADMIN_INCOME',
    project: 'Гамма',
    st: 'VALIDATED',
    a: '+6 250,00 USD',
    orig: '257 800,00 UAH',
  },
  {
    day: '15 листопада',
    d: '15.11',
    time: '13:15',
    from: 'Рахунок компанії',
    to: 'Канцтовари',
    type: 'EXPENSE',
    project: '—',
    st: 'PAID',
    a: '−42,15 USD',
    att: true,
  },
  {
    day: '15 листопада',
    d: '15.11',
    time: '08:00',
    from: 'Рахунок компанії',
    to: 'Дизайн-інструмент',
    type: 'EXPENSE',
    project: '—',
    st: 'REJECTED',
    a: '−29,00 USD',
  },
  {
    day: '14 листопада',
    d: '14.11',
    time: '17:45',
    from: 'Рахунок компанії',
    to: 'Розробник 2',
    type: 'SALARY',
    project: 'Бета',
    st: 'PAID',
    a: '−1 980,00 USD',
  },
  {
    day: '14 листопада',
    d: '14.11',
    time: '12:10',
    from: 'Клієнт «Захід»',
    to: 'Дроп Демо',
    type: 'DROP_INCOME',
    project: 'Альфа',
    st: 'VALIDATED',
    a: '+3 400,00 USD',
  },
  {
    day: '13 листопада',
    d: '13.11',
    time: '15:30',
    from: 'Рахунок компанії',
    to: 'Обладнання',
    type: 'EXPENSE',
    project: '—',
    st: 'PAID',
    a: '−310,00 USD',
    att: true,
  },
  {
    day: '13 листопада',
    d: '13.11',
    time: '09:00',
    from: 'Рахунок компанії',
    to: 'Банк',
    type: 'EXPENSE',
    project: '—',
    st: 'PAID',
    a: '−12,50 USD',
  },
]

export const TYPE = {
  EXPENSE: ['Витрата', 'receipt'],
  SENIOR_INCOME: ['Дохід сеньйора', 'arrow-down-left'],
  ADMIN_INCOME: ['Дохід адміна', 'arrow-down-left'],
  DROP_INCOME: ['Дохід дропа', 'arrow-down-left'],
  SALARY: ['Зарплата', 'wallet'],
  PAYOUT: ['Виплата', 'arrow-up-right'],
  ADMIN_TRANSFER: ['Переказ', 'arrow-left-right'],
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

export function row(x, { sel = false } = {}) {
  const [typeLabel, ic] = TYPE[x.type]
  const neg = x.a.startsWith('−')
  const clip = x.att
    ? ` · <span aria-label="Чек прикріплено" style="display:inline-flex;vertical-align:-2px">${icon('paperclip', { size: 13 })}</span>`
    : ''
  const meta = `<span class="num">${x.time}</span> · ${typeLabel}${x.project && x.project !== '—' ? ` · Проєкт «${x.project}»` : ''}${clip}`
  const status = FINAL.has(x.st) ? '' : pill(x.st, { small: true })
  // Foundation anatomy: title + amount, then the meta line across the full width; a status that needs
  // attention takes its own third line (it wraps, never truncates).
  const del = x.deleted
    ? '<span class="pill" style="height:18px;font-size:11px;padding:0 6px;vertical-align:middle;margin-right:6px">Видалено</span>'
    : ''
  const trail = `<span class="col" style="align-items:flex-end;flex:none"><span class="amount ${neg ? '' : 'pos'}">${x.a}</span>${x.orig ? `<span class="t-cap muted num">${x.orig}</span>` : ''}</span>`
  const stLine = status
    ? `<div style="margin-top:3px">${status.replace('height:18px;', 'height:auto;min-height:20px;white-space:normal;line-height:15px;padding:2px 7px;')}</div>`
    : ''
  // An amount over 14 characters (7+ digits) would squeeze the title to a word: it drops under the title.
  const stack = x.a.length > 14
  const head = stack
    ? `<div class="t-body" style="font-weight:500;${CLAMP2}">${del}${title(x)}</div><div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap"><span class="amount ${neg ? '' : 'pos'}">${x.a}</span>${x.orig ? `<span class="t-cap muted num">${x.orig}</span>` : ''}</div>`
    : `<div class="row" style="align-items:flex-start;gap:12px"><div class="t-body grow" style="font-weight:500;${CLAMP2}">${del}${title(x)}</div>${trail}</div>`
  // Deleted rows: muted text (>= 4.5:1), never opacity (opacity drops contrast below AA).
  return `${x.deleted ? `<style>${DEL_CSS}</style>` : ''}<div class="lrow two${x.deleted ? ' del' : ''}" role="link" style="--inset:64px;${sel ? 'background:var(--raised);' : ''}"><div class="lead">${icon(ic, { size: 18 })}</div>
  <div class="grow col" style="gap:2px;min-width:0">${head}<div class="t-foot muted trunc">${meta}</div>${stLine}</div></div>`
}

// The title names the party that is not the company account; a third-party flow shows both sides.
export const COMPANY = 'Рахунок компанії'
export const title = (x) =>
  x.from === COMPANY ? x.to : x.to === COMPANY ? x.from : `${x.from} → ${x.to}`

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

// Search + the filter entry: «Фільтри» opens the bottom sheet; active filters show as removable chips.
export function searchAndFilters({ active = [], count = 0, q = '' } = {}) {
  const chip = (label, on = false, x = false) =>
    `<span class="row" role="button" style="gap:6px;height:44px;padding:0 ${x ? 10 : 14}px 0 14px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;flex:none;${on ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${label}${x ? `<span aria-label="Прибрати фільтр" style="display:grid;place-items:center;width:24px;height:24px">${icon('x', { size: 15, stroke: 2.2 })}</span>` : ''}</span>`
  const filterBtn = chip(
    `${icon('sliders-horizontal', { size: 17 })}Фільтри${count ? `<b class="num" style="min-width:20px;height:20px;border-radius:10px;background:var(--primary);color:var(--primary-fg);font-size:12px;line-height:20px;text-align:center">${count}</b>` : ''}`,
  )
  return `<div style="padding:4px 16px 10px"><div class="row" role="searchbox" style="gap:8px;height:44px;border-radius:12px;background:var(--surface);padding:0 12px;color:${q ? 'var(--fg)' : 'var(--placeholder)'};font-size:16px">${icon('search', { size: 18 })}<span>${q || 'Пошук транзакцій'}</span></div></div>
  <div class="row" style="gap:8px;padding:0 16px 6px;overflow:hidden">${filterBtn}${active.map((a) => chip(a, true, true)).join('')}${active.length ? '' : chip(`${icon('arrow-down', { size: 15 })}Дата`)}</div>`
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
export function tabletFrame({ w, h, role = 'ADMIN', body, title = 'Фінанси', canCreate = true }) {
  return `<div class="device touch" style="width:${w}px;height:${h}px">
  <div class="row" style="height:24px;padding:0 20px;justify-content:space-between;font-size:13px;font-weight:600;flex:none"><span>9:41 вт 17 лист.</span><span class="row" style="gap:6px">${icon('wifi', { size: 14, stroke: 2.2 })}100%</span></div>
  <div class="row grow" style="align-items:stretch;min-height:0;position:relative">${rail(role, '/finance', h, { canCreate })}
  <section aria-label="Транзакції" class="col grow" style="min-width:0">
  <div class="row" style="height:56px;padding:0 8px 0 16px;flex:none"><h1 class="grow t-title" style="margin:0">${title}</h1><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  <div style="flex:1;min-height:0;overflow:hidden">${body}</div></section></div>
  <div class="homebar" style="width:180px"></div></div>`
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

const dBtn = (label, { on = false, x = false } = {}) =>
  `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:32px;padding:0 10px;border-radius:8px;font-size:13px;white-space:nowrap;${on ? 'background:var(--yellow-subtle);color:var(--fg);border:1px solid oklch(0.32 0.06 85)' : 'border:1px solid var(--input-border);color:var(--muted-fg)'}">${label}${x ? `<span aria-label="Прибрати фільтр" style="display:grid">${icon('x', { size: 13 })}</span>` : icon('chevron-down', { size: 13 })}</span>`
const dToggle = (on) =>
  `<span class="row" role="switch" aria-checked="${on}" style="gap:8px;height:32px;padding:0 6px;font-size:13px;color:var(--muted-fg)"><span style="width:30px;height:18px;border-radius:9px;position:relative;background:${on ? 'var(--primary)' : 'var(--secondary)'};border:1px solid var(--border)"><i style="position:absolute;top:2px;left:${on ? 14 : 2}px;width:12px;height:12px;border-radius:6px;background:${on ? 'var(--primary-fg)' : 'var(--fg)'}"></i></span>Показати видалені</span>`

export function toolbar({ w, type = '', status = '', deleted = null, total = 132, q = '' }) {
  return `<div class="row" style="gap:8px;flex:none"><span class="row" role="searchbox" style="gap:8px;height:32px;width:${w >= 1280 ? 300 : 220}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:${q ? 'var(--fg)' : 'var(--muted-fg)'};font-size:13px">${icon('search', { size: 14 })}<span class="grow trunc">${q || 'Пошук транзакцій'}</span><span class="kbdkey">/</span></span>
  ${dBtn(type ? `Тип: ${type}` : 'Усі типи', { on: !!type, x: !!type })}${dBtn(status ? `Статус: ${status}` : 'Усі статуси', { on: !!status, x: !!status })}${deleted === null ? '' : dToggle(deleted)}${type || status || deleted ? '<span class="btn ghost sm" style="color:var(--muted-fg)">Скинути</span>' : ''}
  <span class="grow"></span><span class="t-foot muted num">${total} транзакції</span></div>`
}

const sortTh = (label, dir, cls = '') =>
  `<th class="${cls}" aria-sort="${dir === 'down' ? 'descending' : dir ? 'ascending' : 'none'}"><span style="display:inline-flex;align-items:center;gap:4px">${label}${dir ? icon(dir === 'down' ? 'arrow-down' : 'arrow-up', { size: 12 }) : `<span style="opacity:0.45;display:grid">${icon('chevrons-up-down', { size: 12 })}</span>`}</span></th>`

export function table(rows, { w, sel = 0, hover = -1, menuFor = -1, canAct = true } = {}) {
  const wide = w >= 1280
  const head = `<tr>${sortTh('Дата', 'down')}<th>Учасник</th><th>${wide ? 'Тип' : 'Тип · проєкт'}</th>${wide ? '<th>Проєкт</th>' : ''}<th>Статус</th>${sortTh('Сума', '', 'r')}<th><span class="sr">Дії</span></th></tr>`
  // Fixed layout: long parties and projects ellipsize (full value in the tooltip); actions never clip.
  // Below 1280 the inline action does not fit: it becomes the first item of the «…» menu.
  const inline = canAct && wide
  const cols = `<colgroup><col style="width:76px"><col><col style="width:${wide ? 140 : 150}px">${wide ? '<col style="width:130px">' : ''}<col style="width:${wide ? 180 : 150}px"><col style="width:${wide ? 176 : 140}px"><col style="width:${inline ? 236 : 52}px"></colgroup>`
  const tr = rows
    .map((x, i) => {
      const [typeLabel] = TYPE[x.type]
      const neg = x.a.startsWith('−')
      const clip = x.att
        ? `<span aria-label="Чек прикріплено" class="muted" style="display:inline-flex;flex:none">${icon('paperclip', { size: 13 })}</span>`
        : ''
      const long = STATUS[x.st][0].length > 24
      const act =
        inline && x.act
          ? `<span class="btn secondary sm rowact" style="opacity:1">${x.act}</span>`
          : ''
      const more = `<span class="iconbtn rowact" aria-label="Інші дії" aria-haspopup="menu" style="width:28px;height:28px;${i === menuFor ? 'opacity:1;background:var(--surface)' : !inline && x.act ? 'opacity:1' : ''}">${icon('ellipsis', { size: 16 })}</span>`
      return `<tr ${i === sel ? 'aria-selected="true"' : ''} class="${i === hover ? 'hover' : ''}${x.deleted ? ' del' : ''}"><td class="num muted">${x.d}</td><td title="${x.from} → ${x.to}"><span class="row" style="gap:6px;min-width:0">${x.deleted ? '<span class="pill" style="height:18px;font-size:11px;flex:none">Видалено</span>' : ''}<span class="trunc">${title(x)}</span>${clip}</span></td><td class="muted">${typeLabel}${wide ? '' : x.project !== '—' ? ` · ${x.project}` : ''}</td>${wide ? `<td class="muted">${x.project}</td>` : ''}<td class="${long ? 'wrap' : ''}" style="${long ? 'padding-top:6px;padding-bottom:6px' : ''}">${long ? `<span class="pill warn" style="height:auto;min-height:22px;white-space:normal;line-height:16px;padding:3px 8px">${STATUS[x.st][0]}</span>` : pill(x.st)}</td><td class="r"><span class="amount ${neg ? '' : 'pos'}" style="font-size:14px">${x.a}</span>${x.orig ? `<div class="t-cap muted num" style="line-height:12px">${x.orig}</div>` : ''}</td><td class="r"><span class="row" style="gap:6px;justify-content:flex-end">${act}${more}</span></td></tr>`
    })
    .join('')
  return `<div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"><table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0" aria-label="Транзакції">${cols}<thead>${head}</thead><tbody>${tr}</tbody></table></div>`
}

export const pager = (from = 1, to = 50, total = 132) =>
  `<div class="row" style="gap:8px;justify-content:flex-end;flex:none;font-size:13px"><span class="muted num">${from}–${to} з ${total}</span><span class="btn secondary sm" aria-label="Попередня сторінка" style="width:32px;padding:0">${icon('chevron-left', { size: 15 })}</span><span class="btn secondary sm" aria-label="Наступна сторінка" style="width:32px;padding:0">${icon('chevron-right', { size: 15 })}</span></div>`

// ---------- Frames ----------
export const M = (name, w, h, body) => ({ name, w, h, dpr: 2, html: page(body, { width: w }) })
export const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })

const mobileMain = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: `${searchAndFilters()}${dayList(ROWS)}`,
  })
const tabletMain = (w, h) =>
  tabletFrame({ w, h, body: `${searchAndFilters()}${dayList(ROWS.slice(0, 9))}` })
const desktopMain = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false })}${table(ROWS, { w, sel: 1, hover: 3 })}${pager()}`,
  })

export function frames() {
  return [
    M('main-320', 320, 568, mobileMain(320, 568)),
    M('main-375', 375, 812, mobileMain(375, 812)),
    M('main-768', 768, 1024, tabletMain(768, 1024)),
    D('main-1024', 1024, 768, desktopMain(1024, 768)),
    D('main-1440', 1440, 900, desktopMain(1440, 900)),
  ]
}
