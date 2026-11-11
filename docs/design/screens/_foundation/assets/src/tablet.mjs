// Tablet (640–1023): slim rail + one pane with push below 900, list/detail from 900. Touch rules (44 px), desktop-like layout.
import { icon } from './base.mjs'
import { DEST, TABS, GROUPS, allowed } from './nav.mjs'
import { TXNS, txnRow, searchField, chips } from './mobile.mjs'

export const brandMark = (s = 32) =>
  `<div aria-label="Cheeky Cheese CRM" style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.28)}px;background:var(--primary);display:grid;place-items:center;flex:none"><svg width="${s * 0.56}" height="${s * 0.56}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6l9 6-9 6z" fill="oklch(0.08 0 0)"/><rect x="15" y="15" width="5" height="3" rx="1" fill="oklch(0.08 0 0)"/></svg></div>`

// Rail order: the role's tab-bar destinations, then the rest in sidebar group order (Профіль = the avatar).
function railItems(role) {
  const rest = GROUPS.flatMap((g) => g.items).filter(
    (d) => allowed(role).includes(d) && !TABS[role].includes(d),
  )
  return [...TABS[role], ...rest]
}
const itemH = (d) => 16 + 24 + 4 + 13 * Math.ceil(DEST[d].label.length / 10) + 2
// Height budget: status 24 + brand / «+» 120 + avatar 64 + home indicator 20.
function railFit(role, h) {
  const all = railItems(role)
  const budget = h - 24 - 120 - 64 - 20
  const sum = (xs) => xs.reduce((a, d) => a + itemH(d), 0)
  if (sum(all) <= budget) return { shown: all, overflow: [] }
  const shown = []
  for (const d of all) if (sum([...shown, d]) + 58 <= budget) shown.push(d)
  return { shown, overflow: all.filter((d) => !shown.includes(d)) }
}

function rail(role, active, h) {
  const { shown, overflow } = railFit(role, h)
  const item = (d, on, label, ic, badge = 0) =>
    `<div class="col" style="align-items:center;gap:4px;width:68px;padding:8px 0;border-radius:14px;position:relative;${on ? 'background:var(--raised)' : ''};color:${on ? 'var(--fg)' : 'var(--muted-fg)'}">
    <span style="color:${on ? 'var(--primary)' : 'inherit'}">${icon(ic, { size: 24, stroke: on ? 2.1 : 1.75 })}</span><span style="font-size:11px;line-height:13px;font-weight:500;text-align:center;max-width:66px">${label}</span>${badge ? `<b class="num" style="position:absolute;top:4px;right:14px;min-width:17px;height:17px;border-radius:9px;background:var(--primary);color:var(--primary-fg);font-size:11px;line-height:17px;text-align:center;padding:0 4px">${badge}</b>` : ''}</div>`
  return `<nav aria-label="Основна навігація" class="col" style="width:80px;flex:none;align-items:center;gap:2px;padding:12px 0 20px;border-right:1px solid var(--border);background:oklch(0.095 0.002 85)">
  ${brandMark(36)}<div style="height:10px"></div>
  <div aria-label="Створити" style="width:52px;height:52px;border-radius:16px;background:var(--primary);color:var(--primary-fg);display:grid;place-items:center;margin-bottom:10px">${icon('plus', { size: 24, stroke: 2.4 })}</div>
  ${shown.map((d) => item(d, d === active, DEST[d].label, DEST[d].icon, d === '/pending' ? 3 : 0)).join('')}
  ${overflow.length ? item('more', active === 'more', 'Ще', 'ellipsis', overflow.includes('/pending') ? 3 : 0) : ''}
  <div style="flex:1"></div><div class="lead av" style="width:40px;height:40px;border-radius:20px;display:grid;place-items:center;background:var(--yellow-subtle);color:var(--primary);font-size:14px;font-weight:600">ВК</div></nav>`
}

function detailPane() {
  const f = (k, v) =>
    `<div class="lrow"><div class="muted t-sub" style="flex:none">${k}</div><div class="grow t-sub trunc" style="text-align:right">${v}</div></div>`
  return `<section aria-label="Деталі транзакції" class="grow col" style="background:var(--bg)">
  <div class="row" style="height:56px;padding:0 16px;gap:8px;border-bottom:1px solid var(--border)"><div class="grow t-foot muted">Транзакція</div>
  <span class="btn sm secondary">${icon('pencil', { size: 15 })}Редагувати</span><span class="iconbtn" aria-label="Ще дії">${icon('ellipsis', { size: 20 })}</span></div>
  <div style="padding:24px 24px 8px"><div class="t-title">Оренда офісу</div><div class="t-foot muted" style="margin-top:2px">Витрата · сьогодні, 14:20</div><div class="num" style="font-size:40px;line-height:48px;font-weight:700;letter-spacing:-0.03em;margin-top:4px">−1 200,00 $</div>
  <div class="row" style="gap:8px;margin-top:10px"><span class="pill ok">${icon('check', { size: 13, stroke: 2.4 })}Оплачено</span><span class="pill">Проєкт «Альфа»</span></div></div>
  <div class="sechead"><span class="t-over">Подробиці</span></div>
  <div class="group" style="margin:0 20px">${f('Тип', 'Витрата')}${f('Проєкт', 'Проєкт «Альфа»')}${f('Контрагент', 'Офісний центр «Сигма»')}${f('Дата', '11 листопада 2026')}${f('Додав', 'Віктор Кравець')}</div>
  <div class="sechead"><span class="t-over">Чек</span></div>
  <div style="margin:0 24px" class="row"><div style="width:120px;height:150px;border-radius:12px;background:linear-gradient(170deg,oklch(0.9 0 0),oklch(0.74 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;padding:14px;display:grid;gap:7px;align-content:start">${'<i style="height:4px;background:oklch(0.5 0 0);border-radius:2px"></i>'.repeat(8)}</div></div></section>`
}

function morePanel(role, h) {
  const items = railFit(role, h).overflow
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((d) => items.includes(d)),
  })).filter((g) => g.items.length)
  return `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.45);z-index:60"></div>
  <div role="dialog" aria-label="Ще" style="position:absolute;left:96px;bottom:24px;width:320px;z-index:70;background:var(--popover);border:1px solid var(--border);border-radius:18px;box-shadow:0 20px 60px oklch(0 0 0 / 0.6);padding:8px 0 10px">
  <div class="row" style="height:48px;padding:0 16px"><div class="grow t-head">Ще</div><span class="kbdkey">Esc</span></div>
  ${groups
    .map(
      (g) =>
        `<div class="t-over" style="padding:10px 16px 4px">${g.title}</div>${g.items
          .map(
            (d) =>
              `<div class="row" style="gap:12px;height:44px;padding:0 16px;${d === '/pending' ? '' : ''}"><span class="muted">${icon(DEST[d].icon, { size: 18 })}</span><span class="grow t-sub trunc">${DEST[d].label}</span>${d === '/pending' ? '<span class="pill y num" style="font-weight:700">3</span>' : ''}</div>`,
          )
          .join('')}`,
    )
    .join('')}
  <div style="height:1px;background:var(--border);margin:8px 0"></div>
  <div class="row" style="gap:12px;height:44px;padding:0 16px"><span class="muted">${icon('circle-user', { size: 18 })}</span><span class="grow t-sub">Профіль</span></div>
  <div class="row" style="gap:12px;height:44px;padding:0 16px;color:var(--destructive)">${icon('log-out', { size: 18 })}<span class="t-sub">Вийти</span></div></div>`
}

// `list` / `detail` replace the two panes (skeleton / other screens); `active` follows them.
export function tablet({
  w,
  h,
  more = false,
  overlay = '',
  list: listPane = '',
  detail = '',
  active = '/finance',
}) {
  const role = 'ADMIN'
  // 640–899: one pane, detail pushes; ≥ 900: list + detail side by side.
  const twoPane = w >= 900
  const list =
    listPane ||
    `<section aria-label="Транзакції" class="col" style="width:360px;flex:none;border-right:1px solid var(--border)">
  <div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Фінанси</div><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  ${searchField('Пошук транзакцій')}${chips(['Усі', 'Витрати', 'Доходи', 'Проєкт ▾'])}
  <div class="sechead"><span class="t-over">Сьогодні</span></div>
  <div class="group" style="margin:0 12px">${TXNS.slice(0, 3)
    .map((x, i) =>
      i === 0 && twoPane
        ? txnRow(x).replace(
            'class="lrow two"',
            'class="lrow two" aria-current="true" style="--inset:64px;background:var(--raised)"',
          )
        : txnRow(x),
    )
    .join('')}</div>
  <div class="sechead"><span class="t-over">Вчора</span></div><div class="group" style="margin:0 12px">${TXNS.slice(
    3,
    6,
  )
    .map((x) => txnRow(x))
    .join('')}</div>
  <div class="sechead"><span class="t-over">9 листопада</span></div><div class="group" style="margin:0 12px">${TXNS.slice(
    6,
  )
    .map((x) => txnRow(x))
    .join('')}</div></section>`
  const listHtml = twoPane
    ? list
    : list.replace('style="width:360px;flex:none;', 'style="flex:1;min-width:0;')
  return `<div class="device touch" style="width:${w}px;height:${h}px">
  <div class="row" style="height:24px;padding:0 20px;justify-content:space-between;font-size:13px;font-weight:600;flex:none"><span>9:41 вт 11 лист.</span><span class="row" style="gap:6px">${icon('wifi', { size: 14, stroke: 2.2 })}100%</span></div>
  <div class="row grow" style="align-items:stretch;min-height:0;position:relative">${rail(role, more ? 'more' : active, h)}${listHtml}${twoPane ? detail || detailPane() : ''}${more ? morePanel(role, h) : ''}${overlay}</div>
  <div class="homebar" style="width:180px"></div></div>`
}
