// Desktop (≥ 1024): grouped collapsible sidebar, header with ⌘K entry, dense table, Cmd+K, `?` sheet.
import { icon } from './base.mjs'
import { DEST, GROUPS, allowed, ROLE_LABEL, whoOf } from './nav.mjs'
import { brandMark } from './tablet.mjs'

export const ROWS = [
  ['11.11', 'Оренда офісу', 'Витрата', 'Альфа', true, '−1 200,00 USD', false],
  ['11.11', 'Оплата від клієнта', 'Дохід', 'Бета', false, '+4 800,00 USD', true],
  ['11.11', 'Хмарний хостинг', 'Витрата', 'Інфраструктура', true, '−86,40 USD', false, 'Очікує'],
  ['10.11', 'Зарплата · Розробник 4', 'Зарплата', 'Альфа', false, '−2 150,00 USD', false],
  ['10.11', 'Переказ на рахунок компанії', 'Переказ', '—', false, '−3 000,00 USDT', false],
  ['10.11', 'Оплата від клієнта', 'Дохід', 'Гамма', false, '+6 250,00 USD', true],
  ['09.11', 'Канцтовари', 'Витрата', 'Офіс', true, '−42,15 USD', false],
  ['09.11', 'Підписка на дизайн-інструмент', 'Витрата', 'Інструменти', false, '−29,00 USD', false],
  ['08.11', 'Зарплата · Розробник 2', 'Зарплата', 'Бета', false, '−1 980,00 USD', false],
  ['08.11', 'Оплата від клієнта', 'Дохід', 'Альфа', false, '+3 400,00 USD', true],
  ['07.11', 'Обладнання · монітор', 'Витрата', 'Офіс', true, '−12 400,00 UAH', false],
  ['07.11', 'Комісія банку', 'Витрата', '—', false, '−12,50 USD', false],
  ['06.11', 'Зарплата · Дизайнер 1', 'Зарплата', 'Гамма', false, '−1 640,00 USD', false],
  ['06.11', 'Оплата від клієнта', 'Дохід', 'Бета', false, '+2 900,00 USD', true],
  ['05.11', 'Таксі на зустріч', 'Витрата', 'Альфа', true, '−18,20 USD', false],
  ['05.11', 'Хмарний хостинг', 'Витрата', 'Інфраструктура', true, '−84,90 USD', false],
]

function sidebar(role, active, collapsed) {
  const who = whoOf(role)
  const ok = new Set(allowed(role))
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((d) => ok.has(d)) })).filter(
    (g) => g.items.length,
  )
  if (collapsed) {
    return `<nav aria-label="Основна навігація" class="col" style="width:64px;flex:none;align-items:center;gap:2px;padding:14px 0 12px;overflow:hidden;border-right:1px solid var(--border);background:oklch(0.095 0.002 85)">
    ${brandMark(30)}<div style="height:10px"></div>
    <button type="button" class="iconbtn tgt ctl" aria-label="Пошук або команда (⌘K)" style="width:40px;height:40px;border-radius:10px;background:var(--surface);border:1px solid var(--border);color:var(--muted-fg);margin-bottom:8px;flex:none">${icon('search', { size: 18 })}</button>
    <div class="col" style="flex:1;min-height:0;width:100%;align-items:center;gap:2px;overflow-y:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 20px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 20px),transparent)">${groups
      .map(
        (g, gi) =>
          `${gi ? '<div style="width:24px;height:1px;background:var(--border);margin:6px 0"></div>' : ''}${g.items
            .map(
              (d) =>
                `<div class="tgt ctl" role="link" aria-label="${DEST[d].label}${d === '/pending' ? ', 3' : ''}" style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center;position:relative;${d === active ? 'background:var(--raised);color:var(--primary)' : 'color:var(--muted-fg)'}">${icon(DEST[d].icon, { size: 19 })}${d === '/pending' ? '<b class="num" aria-hidden="true" style="position:absolute;top:2px;right:0;min-width:17px;height:17px;border-radius:9px;background:var(--primary);color:var(--primary-fg);font-size:11px;line-height:17px;text-align:center;padding:0 4px">3</b>' : ''}</div>`,
            )
            .join('')}`,
      )
      .join('')}</div>
    <div class="col" style="flex:none;width:100%;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)"><div class="tgt ctl" role="button" style="width:40px;height:40px;display:grid;place-items:center;color:var(--muted-fg)" aria-label="Розгорнути бічну панель">${icon('panel-left-open', { size: 19 })}</div>
    <div class="tgt ctl" role="button" aria-haspopup="menu" aria-label="${who.name}, ${ROLE_LABEL[role]}. Меню профілю" style="width:32px;height:32px;border-radius:16px;background:var(--yellow-subtle);color:var(--primary);font-size:12px;font-weight:600;display:grid;place-items:center">${who.ini}</div></div></nav>
    <div role="tooltip" style="position:absolute;left:72px;top:207px;z-index:30;padding:6px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--border);font-size:13px;white-space:nowrap" class="row">Фінанси<span style="width:8px"></span><span class="kbdkey">G</span><span class="kbdkey" style="margin-left:3px">F</span></div>`
  }
  return `<nav aria-label="Основна навігація" class="col" style="width:248px;flex:none;border-right:1px solid var(--border);background:oklch(0.095 0.002 85);padding:12px 10px">
  <div class="row" style="gap:10px;height:40px;padding:0 6px">${brandMark(28)}<div class="grow"><div style="font-size:14px;font-weight:600;line-height:17px">Cheeky Cheese</div><div class="t-cap muted">CRM</div></div><button type="button" class="iconbtn tgt muted" style="width:32px;height:32px;border-radius:8px" aria-label="Згорнути бічну панель">${icon('panel-left-close', { size: 18 })}</button></div>
  <button type="button" class="row tgt ssearch" style="width:100%;text-align:left;gap:8px;height:36px;margin:12px 0 6px;padding:0 10px;border-radius:9px;background:var(--surface);border:1px solid var(--border);color:var(--muted-fg);font:inherit;font-size:13px">${icon('search', { size: 15 })}<span class="grow">Пошук або команда</span><span class="kbdkey">⌘K</span></button>
  <div class="col" style="flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;margin:0 -10px;padding:0 10px">${groups
    .map(
      (
        g,
      ) => `<div class="row shead" style="height:28px;margin-top:10px;padding:0 10px;justify-content:space-between"><span class="t-over" style="font-size:11px">${g.title}</span><span class="muted">${icon('chevron-down', { size: 13 })}</span></div>
    ${g.items
      .map((d) => {
        const on = d === active
        return `<a href="#" class="row srow" ${on ? 'aria-current="page"' : ''} style="gap:10px;height:36px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:${on ? 600 : 500};${on ? 'background:var(--raised);color:var(--fg);box-shadow:inset 2px 0 0 var(--primary)' : 'color:var(--muted-fg)'}"><span style="color:${on ? 'var(--primary)' : 'inherit'}">${icon(DEST[d].icon, { size: 17 })}</span><span class="grow trunc">${DEST[d].label}</span>${d === '/pending' ? '<span class="num" style="min-width:20px;height:20px;border-radius:10px;background:var(--yellow-subtle);color:var(--primary);font-size:12px;font-weight:700;display:grid;place-items:center;padding:0 6px">3</span>' : ''}</a>`
      })
      .join('')}`,
    )
    .join('')}</div>
  <button type="button" class="row tgt sprofile" aria-haspopup="menu" aria-label="${who.name}, ${ROLE_LABEL[role]}. Меню профілю" style="background:none;border-width:1px 0 0;flex:none;width:100%;text-align:left;gap:10px;height:52px;padding:8px 6px 0;border-top:1px solid var(--border);margin-top:8px;color:inherit;font:inherit"><span style="width:32px;height:32px;border-radius:16px;background:var(--yellow-subtle);color:var(--primary);font-size:12px;font-weight:600;display:grid;place-items:center">${who.ini}</span><span class="grow"><span style="display:block;font-size:13px;font-weight:600">${who.name}</span><span class="t-cap muted" style="display:block">${ROLE_LABEL[role]}</span></span><span class="muted">${icon('chevrons-up-down', { size: 15 })}</span></button></nav>`
}

// R2-31: the column widths are fixed (table-layout: fixed), so a skeleton, a footer or a banner frame draws the same grid.
const COLW = { Дата: 72, Тип: 96, Проєкт: 150, Чек: 56, Сума: 168 }
const colgroup = (head) =>
  `<colgroup>${head.map((h) => (h === 'Опис' ? '<col>' : `<col style="width:${COLW[h]}px">`)).join('')}<col style="width:48px"></colgroup>`
const KEBAB_TH =
  '<th style="width:48px"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Дії</span></th>'
const kebab = (t) =>
  `<button type="button" class="iconbtn kb" aria-haspopup="menu" aria-label="Дії: ${t}" style="width:36px;height:36px">${icon('ellipsis', { size: 18 })}</button>`
// R2-10: the amount and its code sit in two parts: the number is right-aligned against a fixed 44 px code slot, so the
// commas line up whatever the code length (USD, UAH, USDT).
// R5-21: exported so a pinned draft row uses the same «Сума» slot (tabular grid, the code in its 38 px column).
export const amt = (a) => {
  const i = a.lastIndexOf(' ')
  return `<span style="display:inline-flex;justify-content:flex-end"><span>${a.slice(0, i)}</span><span style="width:38px;text-align:left;padding-left:6px">${a.slice(i + 1)}</span></span>`
}
function table(contentW, { skeleton = false, headOnly = false, rows = ROWS, touch = false } = {}) {
  // ≥ 1032 px of main (a 1280 viewport with the 248 sidebar) fits «Проєкт»; below, it rides in «Опис» as muted text.
  const wide = contentW >= 1032
  const head = ['Дата', 'Опис', 'Тип', ...(wide ? ['Проєкт'] : []), 'Чек', 'Сума']
  const th =
    head
      .map(
        (h, i) =>
          `<th style="text-align:${i === head.length - 1 ? 'right' : 'left'};${h === 'Чек' ? 'width:56px;text-align:center' : ''}"><span style="display:inline-flex;align-items:center;gap:4px">${h}${h === 'Дата' ? icon('arrow-down', { size: 12 }) : ''}</span></th>`,
      )
      .join('') + KEBAB_TH
  if (skeleton) {
    const wd = { Дата: 36, Опис: 150, Тип: 56, Проєкт: 70, Чек: 14, Сума: 84 }
    const bar = (h, i) =>
      `<td><div class="sk" style="height:12px;width:${h === 'Опис' ? [150, 110, 170, 130][i % 4] : wd[h]}px;${h === 'Сума' ? 'margin-left:auto' : h === 'Чек' ? 'margin:auto' : ''}"></div></td>`
    const rows = Array.from(
      { length: 16 },
      (_, i) =>
        `<tr>${head.map((h) => bar(h, i)).join('')}<td class="kcell">${touch ? '<div class="sk" style="width:24px;height:24px;border-radius:12px;margin:auto"></div>' : ''}</td></tr>`,
    ).join('')
    return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:14px">${colgroup(head)}<thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`
  }
  const tr = (headOnly ? [] : rows)
    .map(
      ([d, t, ty, p, att, a, pos, st], i) =>
        `<tr ${i === 0 ? 'aria-selected="true" style="background:var(--raised)"' : ''}><td class="num muted">${d}</td><td><span class="row" style="gap:8px">${
          // R4-28: the project is atomic: drawn whole after the description or not at all. Both sit in one
          // wrapping line of fixed height, so a project that does not fit whole wraps out of sight and the
          // description truncates alone (never «Опис · А…»). The project stays in the row's accessible name.
          !wide && p !== '—'
            ? `<span title="${t} · ${p}" aria-label="${t} · ${p}" style="display:flex;flex-wrap:wrap;min-width:0;height:20px;overflow:hidden"><span class="trunc" style="flex:0 1 auto;min-width:0">${t}</span><span class="muted" aria-hidden="true" style="flex:none;white-space:pre"> · ${p}</span></span>`
            : `<span class="trunc" title="${t}">${t}</span>`
        }${st ? `<span class="pill warn" style="height:20px;font-size:11px">${st}</span>` : ''}</span></td><td class="muted">${ty}</td>${wide ? `<td class="muted trunc">${p}</td>` : ''}<td style="text-align:center" class="muted">${att ? icon('paperclip', { size: 14 }) : ''}</td><td class="num" style="text-align:right;font-weight:600;${pos ? 'color:var(--positive)' : ''}">${amt(a)}</td><td class="kcell">${kebab(t)}</td></tr>`,
    )
    .join('')
  return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:14px">${colgroup(head)}<thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

const TABLE_CSS = `th svg{display:block}
th{position:sticky;top:0;background:var(--card);font-size:12px;font-weight:600;color:var(--muted-fg);height:36px;padding:0 12px;border-bottom:1px solid var(--border);white-space:nowrap}
td{height:40px;padding:0 12px;border-bottom:1px solid var(--separator);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
tbody tr:last-child td{border-bottom:0}
tr[aria-selected="true"] td:first-child{box-shadow:inset 2px 0 0 var(--primary)}
.srow,.shead{flex:none}
a.srow{text-decoration:none}
.touch .srow{height:44px !important;font-size:15px !important}
.touch .shead{height:44px !important;margin-top:4px !important}
.touch .ssearch{height:44px !important;font-size:15px !important}
.touch .sprofile{height:56px !important}
.touch [role="tooltip"]{display:none}
.touch .ctl{width:44px !important;height:44px !important;flex:none}
.touch nav .iconbtn.tgt{width:44px !important;height:44px !important}
.kb{visibility:hidden}
tr[aria-selected="true"] .kb,.touch .kb{visibility:visible}
.touch .kb{width:44px !important;height:44px !important}
.kcell{width:48px;padding:0 6px !important;text-align:center}
.touch td{height:52px;font-size:15px}
.touch th{height:44px}
.touch .dsearch{height:48px !important;font-size:16px !important}`

/** The one desktop toolbar: search, the unset-filter chips (dashed «+»), the count. Every state keeps it (R1-06). */
export const deskToolbar = ({
  touch = false,
  mainW = 1200,
  count = '312 транзакцій',
  ph = 'Пошук транзакцій',
  filters = ['Тип', 'Проєкт', 'Період'],
  openFilter = {},
} = {}) =>
  `<div class="row" style="gap:8px"><span class="row dsearch" style="gap:8px;height:${touch ? 44 : 32}px;width:${mainW >= 1032 ? 300 : 220}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:var(--muted-fg);font-size:${touch ? 15 : 13}px">${icon('search', { size: 14 })}<span class="grow">${ph}</span><span class="kbdkey">/</span></span>${filters
    .map((f) =>
      openFilter[f]
        ? `<button type="button" aria-haspopup="dialog" aria-expanded="true" class="row" style="appearance:none;font-family:inherit;gap:6px;height:${touch ? 44 : 32}px;padding:0 ${touch ? 14 : 10}px;border-radius:8px;border:1px solid var(--primary);background:var(--yellow-subtle);font-size:${touch ? 15 : 13}px;color:var(--fg)">${openFilter[f]}${icon('chevron-down', { size: 13 })}</button>`
        : `<button type="button" aria-haspopup="dialog" aria-expanded="false" class="row" style="appearance:none;background:none;font-family:inherit;gap:6px;height:${touch ? 44 : 32}px;padding:0 ${touch ? 14 : 10}px;border-radius:8px;border:1px dashed var(--input-border);font-size:${touch ? 15 : 13}px;color:var(--muted-fg)">${icon('plus', { size: 13 })}${f}</button>`,
    )
    .join(
      '',
    )}<span class="grow"></span>${count ? `<span class="t-foot muted num">${count}</span>` : ''}</div>`

/** Profile menu from the sidebar / rail avatar (R1-12): identity, profile, sign-out. `rowH`: 44 on touch, 36 on a pointer. */
export const accountMenu = ({ place, role = 'ADMIN', rowH = 36 }) => {
  const who = whoOf(role)
  const it = (ic, t, ink = '') =>
    `<div role="menuitem" class="row" style="gap:12px;height:${rowH}px;padding:0 14px;font-size:${rowH >= 44 ? 16 : 14}px;${ink ? `color:${ink}` : ''}"><span style="display:grid;${ink ? '' : 'color:var(--muted-fg)'}">${icon(ic, { size: 18 })}</span>${t}</div>`
  return `<div role="menu" aria-label="Акаунт: ${who.name}" style="position:absolute;${place};z-index:70;width:260px;padding:4px 0;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:14px;box-shadow:0 24px 64px oklch(0 0 0 / 0.6)"><div class="col" style="padding:10px 14px 8px;gap:2px"><div style="font-size:14px;font-weight:600">${who.name}</div><div class="t-cap muted">${ROLE_LABEL[role]}</div></div><div style="height:1px;background:var(--border);margin:4px 0"></div>${it('circle-user', DEST['/profile'].label)}<div style="height:1px;background:var(--border);margin:4px 0"></div>${it('log-out', 'Вийти з акаунта', 'var(--destructive)')}</div>`
}

// `content` replaces the page body under the header (skeleton / other screens); `active` + `crumb` follow it.
export { table as deskTable, kebab, KEBAB_TH }
export function desktop({
  w,
  h,
  collapsed = false,
  touch = false,
  overlay = '',
  content = '',
  active = '/finance',
  crumb = ['Гроші', 'Фінанси'],
  cta = 'Нова транзакція',
  panel = '',
  panelW = 0,
  role = 'ADMIN',
  skeleton = false,
  openFilter = {},
  rows = ROWS,
  count = '312 транзакцій',
}) {
  // ≥ 1440 the side panel is non-modal: it sits in the flex row, main gives up its width and the table reflows.
  const mainW = w - (collapsed ? 64 : 248) - panelW
  const main = `<main class="grow col" style="min-width:0">
  <header class="row" style="height:56px;flex:none;padding:0 20px 0 24px;gap:12px;border-bottom:1px solid var(--border)">
    <div class="grow row" style="gap:8px;font-size:14px"><span class="muted">${crumb[0]}</span><span class="muted">${icon('chevron-right', { size: 14 })}</span><span style="font-weight:600">${crumb[1]}</span></div>
    <span class="iconbtn" style="width:${touch ? 44 : 36}px;height:${touch ? 44 : 36}px" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 18 })}<i class="dot" style="top:7px;right:7px"></i></span>
    <span class="btn primary" style="height:${touch ? 44 : 36}px;font-size:${touch ? 16 : 14}px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}${cta}<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span></span></header>
  <div class="col grow" style="min-height:0;padding:20px 24px 24px;gap:14px;${w >= 1440 ? 'max-width:1280px' : ''}">
    ${
      content ||
      (skeleton
        ? `<div role="status" aria-label="Завантаження транзакцій" class="col grow" style="gap:14px;min-height:0">${deskToolbar({ touch, mainW, count: '<span class="sk" style="display:block;width:96px;height:12px"></span>' })}<div class="grow" aria-hidden="true" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)">${table(mainW, { skeleton: true, touch })}</div></div>`
        : `${deskToolbar({ touch, mainW, count, openFilter })}
    <div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)">${table(mainW, { rows })}</div>`)
    }</div></main>`
  return `<style>${TABLE_CSS}</style><div class="device${touch ? ' touch' : ''}" style="width:${w}px;height:${h}px;flex-direction:row;position:relative">${sidebar(role, active, collapsed)}${main}${panel}${overlay}</div>`
}

const SCRIM = '<div style="position:absolute;inset:0;background:var(--scrim);z-index:60"></div>'

/**
 * F0-26: only matching rows stay (a group with no match is dropped); «Дії» carries the page action and the
 * role's quick-add actions; the match is bold. `empty`: no result — one line and the way out, never a blank box.
 * Opened by ⌘K on macOS and Ctrl+K elsewhere (one registry, shell-v2 §4).
 */
// R4-05: under a coarse pointer (touch at >= 1024) options are 44 px and their text 16 px; the query is 16 px always.
// R5-12: the iPad on-screen keyboard (drawn OS chrome, `.kbd`: measure and strings skip it).
const padKeyboard = (hgt) => {
  const key = (k) =>
    `<span style="flex:1;height:64px;border-radius:8px;background:oklch(0.36 0 0);display:grid;place-items:center;font-size:22px;color:#fff">${k}</span>`
  const row = (keys, pad = 0) =>
    `<div style="display:flex;gap:8px;padding:0 ${pad}px">${[...keys].map(key).join('')}</div>`
  return `<div class="kbd" aria-hidden="true" style="height:${hgt}px;padding:14px 8px;gap:10px;align-content:start;background:oklch(0.22 0 0)">${row('йцукенгшщзхї')}${row('фівапролджє', 30)}${row('ячсмитьбю', 70)}<div style="display:flex;gap:8px;padding:0 180px"><span style="flex:1;height:64px;border-radius:8px;background:oklch(0.36 0 0)"></span></div></div>`
}
// R5-11: under a coarse pointer the footer is one focusable 44 px button «Клавіатурні скорочення» (no key hints:
// the keys may not exist); it opens the help sheet, which keeps every binding for a hardware keyboard.
// R5-12 / R5-13: the dialog is bounded by the visual viewport (an on-screen keyboard shrinks it): `kbd` draws the
// keyboard open; only the results body scrolls, the query row and the footer stay.
export function cmdk({ compact = false, empty = false, coarse = false, kbd = 0 } = {}) {
  const q = empty ? 'квартальний звіт' : 'нов'
  const hl = (s) => s.replace(/^(Нов)/, '<b style="color:var(--fg)">$1</b>')
  const item = (ic, label, keys = [], on = false, sub = '') =>
    `<div class="row" role="option" aria-selected="${on}" style="gap:12px;height:${coarse ? 44 : 40}px;padding:0 12px;margin:0 6px;border-radius:8px;font-size:${coarse ? 16 : 14}px;${on ? 'background:var(--raised)' : ''}"><span class="${on ? '' : 'muted'}" style="${on ? 'color:var(--primary)' : ''}">${icon(ic, { size: 16 })}</span><span class="grow trunc" style="color:var(--muted-fg)">${hl(label)}${sub ? ` <span class="muted">· ${sub}</span>` : ''}</span>${keys.length ? `<span style="display:inline-flex;gap:4px">${keys.map((k) => `<span class="kbdkey">${k}</span>`).join('')}</span>` : ''}</div>`
  const grp = (t) => `<div class="t-over" style="font-size:11px;padding:10px 18px 4px">${t}</div>`
  const list = empty
    ? `<div role="status" class="col" style="align-items:center;gap:4px;padding:28px 24px 24px;text-align:center"><div style="font-size:15px;font-weight:600">Нічого не знайдено за «${q}»</div><div class="t-foot muted">Палітра шукає дії, розділи й рядки, завантажені на цій сторінці.</div></div>`
    : `${grp('Дії')}${item('receipt', 'Нова транзакція', ['C'], true, 'ця сторінка')}${item('user-plus', 'Новий користувач')}${item('square-kanban', 'Нова співбесіда')}${item('briefcase', 'Нова вакансія')}`
  // All four ADMIN create actions start with «Нов…», so the «нов» filter keeps all four.
  const top = kbd ? 24 : compact ? 72 : 110
  const foot = coarse
    ? `<div class="row" style="flex:none;height:56px;padding:0 6px;border-top:1px solid var(--border)"><button type="button" class="btn ghost" aria-haspopup="dialog" style="height:44px;padding:0 12px;font-size:15px;color:var(--muted-fg)">${icon('keyboard', { size: 18 })}Клавіатурні скорочення</button></div>`
    : `<div class="row" style="flex:none;gap:16px;height:40px;padding:0 18px;border-top:1px solid var(--border);font-size:12px;color:var(--muted-fg)"><span class="row" style="gap:5px"><span class="kbdkey">↑</span><span class="kbdkey">↓</span>вибір</span><span class="row" style="gap:5px"><span class="kbdkey">↵</span>виконати</span><span class="row" style="gap:5px"><span class="kbdkey">Esc</span>закрити</span><span class="grow"></span><span class="row" style="gap:5px"><span class="kbdkey">⌘</span><span class="kbdkey">/</span>усі скорочення</span></div>`
  return `${SCRIM}<div role="dialog" aria-modal="true" aria-label="Палітра команд" style="position:absolute;left:50%;top:${top}px;transform:translateX(-50%);width:${compact ? 560 : 640}px;max-height:calc(100% - ${top + kbd + 16}px);display:flex;flex-direction:column;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);overflow:hidden">
  <div class="row" style="flex:none;gap:10px;height:54px;padding:0 18px;border-bottom:1px solid var(--border)"><span class="muted">${icon('search', { size: 18 })}</span><span role="combobox" aria-expanded="true" style="font-size:16px">${q}<span class="caret" style="height:18px"></span></span><span class="grow"></span>${
    // R6-25: a typed query has a clear button; focus stays in the field. R6-27: a coarse pointer gets a named 44 px close.
    empty || coarse
      ? `<button type="button" class="iconbtn" aria-label="Очистити запит" style="width:${coarse ? 44 : 32}px;height:${coarse ? 44 : 32}px;color:var(--muted-fg)">${icon('circle-x', { size: 18 })}</button>`
      : ''
  }<span class="pill" style="height:24px">Фінанси</span>${
    coarse
      ? '<button type="button" class="btn ghost" style="height:44px;padding:0 10px;margin-right:-10px;font-size:15px">Закрити</button>'
      : ''
  }</div>
  <div role="listbox" aria-label="Результати" style="flex:1;min-height:0;overflow:hidden auto;overscroll-behavior:contain;padding:4px 0 8px">${list}</div>
  ${foot}</div>${kbd ? padKeyboard(kbd) : ''}`
}

// R4-06: the «Перехід» column, the G-chord handler and the sidebar read ONE role-aware destination list
// (allowed(role)); a chord to a destination the role lacks is neither drawn nor bound.
const CHORDS = [
  ['/finance', 'F'],
  ['/stats', 'S'],
  ['/users', 'U'],
  ['/vacancies', 'V'],
  ['/', 'H'],
]
// R4-05: under a coarse pointer the switch keeps its 44 × 26 track inside a 52 × 44 hit box.
export function shortcuts({ role = 'ADMIN', coarse = false } = {}) {
  const row = (label, keys) =>
    `<div class="row" style="height:36px;gap:10px;font-size:14px;border-bottom:1px solid var(--separator)"><span class="grow">${label}</span><span style="display:inline-flex;gap:4px;align-items:center">${keys.map((k) => (k === 'потім' || k === 'або' ? `<span class="t-cap muted">${k}</span>` : `<span class="kbdkey keep">${k}</span>`)).join('')}</span></div>`
  const col = (t, rows) =>
    `<div class="grow"><div class="t-over" style="font-size:11px;margin-bottom:4px">${t}</div>${rows.join('')}</div>`
  return `${SCRIM}<div role="dialog" aria-modal="true" aria-labelledby="sc-t" style="position:absolute;left:50%;top:80px;transform:translateX(-50%);width:880px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7)">
  <div class="row" style="height:60px;padding:0 12px 0 24px;gap:12px;border-bottom:1px solid var(--border)"><div id="sc-t" class="grow t-head">Клавіатурні скорочення</div>
  <span class="iconbtn" aria-label="Закрити">${icon('x', { size: 18 })}</span></div>
  <div class="row" style="gap:14px;margin:16px 24px 4px;padding:12px 14px;border-radius:12px;background:var(--card);border:1px solid var(--border)">
    <div class="grow"><div style="font-size:14px;font-weight:600">Односимвольні скорочення</div><div class="t-foot muted">Клавіші без ⌘/Ctrl. Ніколи не спрацьовують у текстовому полі. Налаштування зберігається на цьому пристрої.</div></div>
    <span role="switch" aria-checked="true" aria-label="Односимвольні скорочення" style="${coarse ? 'width:52px;height:44px;' : 'width:44px;height:26px;'}display:grid;place-items:center;flex:none"><span style="width:44px;height:26px;border-radius:13px;background:var(--primary);position:relative"><i style="position:absolute;right:3px;top:3px;width:20px;height:20px;border-radius:10px;background:var(--primary-fg)"></i></span></span></div>
  <div class="row" style="gap:32px;padding:12px 24px 24px;align-items:flex-start">
  ${col('Загальні', [row('Палітра команд', ['⌘ / Ctrl', 'K']), row('Пошук на сторінці', ['/']), row('Клавіатурні скорочення', ['⌘ / Ctrl', '/', 'або', '?']), row('Закрити панель або діалог', ['Esc']), row('Згорнути бічну панель', ['[']), row('Зберегти форму', ['⌘ / Ctrl', '↵']), row('Скасувати останню дію', ['⌘ / Ctrl', 'Z'])])}
  ${col(
    'Перехід',
    CHORDS.filter(([d]) => allowed(role).includes(d)).map(([d, k]) =>
      row(DEST[d].label, ['G', 'потім', k]),
    ),
  )}
  ${col('Списки', [row('Наступний рядок', ['J']), row('Попередній рядок', ['K']), row('Відкрити рядок', ['↵']), row('Створити', ['C']), row('Фільтр', ['F']), row('Змінити етап картки', ['M'])])}</div></div>`
}
