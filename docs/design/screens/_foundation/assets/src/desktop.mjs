// Desktop (≥ 1024): grouped collapsible sidebar, header with ⌘K entry, dense table, Cmd+K, `?` sheet.
import { icon } from './base.mjs'
import { DEST, GROUPS, allowed } from './nav.mjs'
import { brandMark } from './tablet.mjs'

const ROWS = [
  ['11.11', 'Оренда офісу', 'Витрата', 'Альфа', true, '−1 200,00 $', false],
  ['11.11', 'Оплата від клієнта', 'Дохід', 'Бета', false, '+4 800,00 $', true],
  ['11.11', 'Хмарний хостинг', 'Витрата', 'Інфраструктура', true, '−86,40 $', false, 'Очікує'],
  ['10.11', 'Зарплата · Розробник 4', 'Зарплата', 'Альфа', false, '−2 150,00 $', false],
  ['10.11', 'Переказ на рахунок компанії', 'Переказ', '—', false, '−3 000,00 $', false],
  ['10.11', 'Оплата від клієнта', 'Дохід', 'Гамма', false, '+6 250,00 $', true],
  ['09.11', 'Канцтовари', 'Витрата', 'Офіс', true, '−42,15 $', false],
  ['09.11', 'Підписка на дизайн-інструмент', 'Витрата', 'Інструменти', false, '−29,00 $', false],
  ['08.11', 'Зарплата · Розробник 2', 'Зарплата', 'Бета', false, '−1 980,00 $', false],
  ['08.11', 'Оплата від клієнта', 'Дохід', 'Альфа', false, '+3 400,00 $', true],
  ['07.11', 'Обладнання · монітор', 'Витрата', 'Офіс', true, '−310,00 $', false],
  ['07.11', 'Комісія банку', 'Витрата', '—', false, '−12,50 $', false],
  ['06.11', 'Зарплата · Дизайнер 1', 'Зарплата', 'Гамма', false, '−1 640,00 $', false],
  ['06.11', 'Оплата від клієнта', 'Дохід', 'Бета', false, '+2 900,00 $', true],
  ['05.11', 'Таксі на зустріч', 'Витрата', 'Альфа', true, '−18,20 $', false],
  ['05.11', 'Хмарний хостинг', 'Витрата', 'Інфраструктура', true, '−84,90 $', false],
]

function sidebar(role, active, collapsed) {
  const ok = new Set(allowed(role))
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((d) => ok.has(d)) })).filter(
    (g) => g.items.length,
  )
  if (collapsed) {
    return `<nav aria-label="Основна навігація" class="col" style="width:64px;flex:none;align-items:center;gap:2px;padding:14px 0;border-right:1px solid var(--border);background:oklch(0.095 0.002 85)">
    ${brandMark(30)}<div style="height:14px"></div>
    ${groups
      .map(
        (g, gi) =>
          `${gi ? '<div style="width:24px;height:1px;background:var(--border);margin:6px 0"></div>' : ''}${g.items
            .map(
              (d) =>
                `<div aria-label="${DEST[d].label}" style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center;position:relative;${d === active ? 'background:var(--raised);color:var(--primary)' : 'color:var(--muted-fg)'}">${icon(DEST[d].icon, { size: 19 })}${d === '/pending' ? '<i style="position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:4px;background:var(--primary)"></i>' : ''}</div>`,
            )
            .join('')}`,
      )
      .join('')}
    <div style="flex:1"></div><div style="width:40px;height:40px;display:grid;place-items:center;color:var(--muted-fg)" aria-label="Розгорнути бічну панель">${icon('panel-left-open', { size: 19 })}</div></nav>
    <div role="tooltip" style="position:absolute;left:72px;top:164px;z-index:30;padding:6px 10px;border-radius:8px;background:var(--surface);border:1px solid var(--border);font-size:13px;white-space:nowrap" class="row">Фінанси<span style="width:8px"></span><span class="kbdkey">G</span><span class="kbdkey" style="margin-left:3px">F</span></div>`
  }
  return `<nav aria-label="Основна навігація" class="col" style="width:248px;flex:none;border-right:1px solid var(--border);background:oklch(0.095 0.002 85);padding:12px 10px">
  <div class="row" style="gap:10px;height:40px;padding:0 6px">${brandMark(28)}<div class="grow"><div style="font-size:14px;font-weight:600;line-height:17px">Cheeky Cheese</div><div class="t-cap muted">CRM</div></div><span class="muted" aria-label="Згорнути бічну панель">${icon('panel-left-close', { size: 18 })}</span></div>
  <div class="row" style="gap:8px;height:36px;margin:12px 0 6px;padding:0 10px;border-radius:9px;background:var(--surface);border:1px solid var(--border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 15 })}<span class="grow">Пошук або команда</span><span class="kbdkey">⌘K</span></div>
  ${groups
    .map(
      (
        g,
      ) => `<div class="row" style="height:28px;margin-top:10px;padding:0 10px;justify-content:space-between"><span class="t-over" style="font-size:11px">${g.title}</span><span class="muted">${icon('chevron-down', { size: 13 })}</span></div>
    ${g.items
      .map((d) => {
        const on = d === active
        return `<div class="row" ${on ? 'aria-current="page"' : ''} style="gap:10px;height:34px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:${on ? 600 : 500};${on ? 'background:var(--raised);color:var(--fg);box-shadow:inset 2px 0 0 var(--primary)' : 'color:var(--muted-fg)'}"><span style="color:${on ? 'var(--primary)' : 'inherit'}">${icon(DEST[d].icon, { size: 17 })}</span><span class="grow trunc">${DEST[d].label}</span>${d === '/pending' ? '<span class="num" style="min-width:20px;height:20px;border-radius:10px;background:var(--yellow-subtle);color:var(--primary);font-size:12px;font-weight:700;display:grid;place-items:center;padding:0 6px">3</span>' : ''}</div>`
      })
      .join('')}`,
    )
    .join('')}
  <div style="flex:1"></div>
  <div class="row" style="gap:10px;height:48px;padding:0 6px;border-top:1px solid var(--border);margin-top:8px;padding-top:8px"><div style="width:32px;height:32px;border-radius:16px;background:var(--yellow-subtle);color:var(--primary);font-size:12px;font-weight:600;display:grid;place-items:center">ВК</div><div class="grow"><div style="font-size:13px;font-weight:600">Віктор Кравець</div><div class="t-cap muted">Адміністратор</div></div><span class="muted">${icon('chevrons-up-down', { size: 15 })}</span></div></nav>`
}

function table(w) {
  const wide = w >= 1280
  const head = ['Дата', 'Опис', 'Тип', ...(wide ? ['Проєкт'] : []), 'Чек', 'Сума']
  const th = head
    .map(
      (h, i) =>
        `<th style="text-align:${i === head.length - 1 ? 'right' : 'left'};${h === 'Чек' ? 'width:56px;text-align:center' : ''}"><span style="display:inline-flex;align-items:center;gap:4px">${h}${h === 'Дата' ? icon('arrow-down', { size: 12 }) : ''}</span></th>`,
    )
    .join('')
  const tr = ROWS.map(
    ([d, t, ty, p, att, a, pos, st], i) =>
      `<tr ${i === 0 ? 'aria-selected="true" style="background:var(--raised)"' : ''}><td class="num muted">${d}</td><td><span class="row" style="gap:8px"><span class="trunc">${t}</span>${st ? `<span class="pill warn" style="height:20px;font-size:11px">${st}</span>` : ''}</span></td><td class="muted">${ty}</td>${wide ? `<td class="muted trunc">${p}</td>` : ''}<td style="text-align:center" class="muted">${att ? icon('paperclip', { size: 14 }) : ''}</td><td class="num" style="text-align:right;font-weight:600;${pos ? 'color:var(--positive)' : ''}">${a}</td></tr>`,
  ).join('')
  return `<table style="width:100%;border-collapse:separate;border-spacing:0;font-size:14px"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

const TABLE_CSS = `th svg{display:block}
th{position:sticky;top:0;background:var(--card);font-size:12px;font-weight:600;color:var(--muted-fg);height:36px;padding:0 12px;border-bottom:1px solid var(--border);white-space:nowrap}
td{height:40px;padding:0 12px;border-bottom:1px solid var(--separator);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
tbody tr:last-child td{border-bottom:0}`

export function desktop({ w, h, collapsed = false, overlay = '' }) {
  const role = 'ADMIN'
  const filters = ['Тип', 'Проєкт', 'Період']
    .map(
      (f) =>
        `<span class="row" style="gap:6px;height:32px;padding:0 10px;border-radius:8px;border:1px dashed var(--input-border);font-size:13px;color:var(--muted-fg)">${icon('plus', { size: 13 })}${f}</span>`,
    )
    .join('')
  const main = `<main class="grow col" style="min-width:0">
  <header class="row" style="height:56px;flex:none;padding:0 20px 0 24px;gap:12px;border-bottom:1px solid var(--border)">
    <div class="grow row" style="gap:8px;font-size:14px"><span class="muted">Гроші</span><span class="muted">${icon('chevron-right', { size: 14 })}</span><span style="font-weight:600">Фінанси</span></div>
    <span class="iconbtn" style="width:36px;height:36px" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 18 })}<i class="dot" style="top:7px;right:7px"></i></span>
    <span class="btn primary" style="height:36px;font-size:14px;padding:0 14px;border-radius:9px">${icon('plus', { size: 16, stroke: 2.4 })}Нова транзакція<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span></span></header>
  <div class="col grow" style="min-height:0;padding:20px 24px 24px;gap:14px;${w >= 1440 ? 'max-width:1280px' : ''}">
    <div class="row" style="gap:8px"><span class="row" style="gap:8px;height:32px;width:${w >= 1280 ? 300 : 220}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 14 })}<span class="grow">Пошук транзакцій</span><span class="kbdkey">/</span></span>${filters}<span class="grow"></span><span class="t-foot muted num">312 транзакцій</span></div>
    <div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)">${table(w)}</div></div></main>`
  return `<style>${TABLE_CSS}</style><div class="device" style="width:${w}px;height:${h}px;flex-direction:row;position:relative">${sidebar(role, '/finance', collapsed)}${main}${overlay}</div>`
}

const SCRIM =
  '<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.55);z-index:60"></div>'

export function cmdk({ compact = false } = {}) {
  const item = (ic, label, keys = [], on = false, sub = '') =>
    `<div class="row" ${on ? 'aria-selected="true"' : ''} style="gap:12px;height:40px;padding:0 12px;margin:0 6px;border-radius:8px;font-size:14px;${on ? 'background:var(--raised)' : ''}"><span class="${on ? '' : 'muted'}" style="${on ? 'color:var(--primary)' : ''}">${icon(ic, { size: 16 })}</span><span class="grow trunc">${label}${sub ? ` <span class="muted">· ${sub}</span>` : ''}</span>${keys.length ? `<span style="display:inline-flex;gap:4px">${keys.map((k) => `<span class="kbdkey">${k}</span>`).join('')}</span>` : ''}</div>`
  const grp = (t) => `<div class="t-over" style="font-size:11px;padding:10px 18px 4px">${t}</div>`
  return `${SCRIM}<div role="dialog" aria-modal="true" aria-label="Палітра команд" style="position:absolute;left:50%;top:${compact ? 72 : 110}px;transform:translateX(-50%);width:${compact ? 560 : 640}px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);overflow:hidden">
  <div class="row" style="gap:10px;height:54px;padding:0 18px;border-bottom:1px solid var(--border)"><span class="muted">${icon('search', { size: 18 })}</span><span style="font-size:16px">нов<span class="caret" style="height:18px"></span></span><span class="grow"></span><span class="pill" style="height:24px">Фінанси</span></div>
  <div style="padding:4px 0 8px">${grp('Дії')}${item('plus', 'Нова транзакція', ['C'], true)}${item('funnel', 'Фільтр: тип', ['F', 'T'])}
  ${grp('Перейти')}${item('dollar-sign', 'Фінанси', ['G', 'F'])}${item('user-plus', 'Вакансії', ['G', 'V'])}${item('square-kanban', 'Співбесіди · нова співбесіда', [])}
  ${grp('На цій сторінці')}${item('receipt', 'Підписка на дизайн-інструмент', [], false, '−29,00 $')}${item('receipt', 'Канцтовари', [], false, '−42,15 $')}</div>
  <div class="row" style="gap:16px;height:40px;padding:0 18px;border-top:1px solid var(--border);font-size:12px;color:var(--muted-fg)"><span class="row" style="gap:5px"><span class="kbdkey">↑</span><span class="kbdkey">↓</span>вибір</span><span class="row" style="gap:5px"><span class="kbdkey">↵</span>виконати</span><span class="row" style="gap:5px"><span class="kbdkey">Esc</span>закрити</span><span class="grow"></span><span class="row" style="gap:5px"><span class="kbdkey">?</span>усі скорочення</span></div></div>`
}

export function shortcuts() {
  const row = (label, keys) =>
    `<div class="row" style="height:36px;gap:10px;font-size:14px;border-bottom:1px solid var(--separator)"><span class="grow">${label}</span><span style="display:inline-flex;gap:4px;align-items:center">${keys.map((k) => (k === 'потім' ? '<span class="t-cap muted">потім</span>' : `<span class="kbdkey">${k}</span>`)).join('')}</span></div>`
  const col = (t, rows) =>
    `<div class="grow"><div class="t-over" style="font-size:11px;margin-bottom:4px">${t}</div>${rows.join('')}</div>`
  return `${SCRIM}<div role="dialog" aria-modal="true" aria-labelledby="sc-t" style="position:absolute;left:50%;top:80px;transform:translateX(-50%);width:880px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7)">
  <div class="row" style="height:60px;padding:0 12px 0 24px;gap:12px;border-bottom:1px solid var(--border)"><div id="sc-t" class="grow t-head">Клавіатурні скорочення</div>
  <span class="row" style="gap:8px;height:32px;width:220px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 14 })}Пошук скорочення</span><span class="iconbtn" aria-label="Закрити">${icon('x', { size: 18 })}</span></div>
  <div class="row" style="gap:14px;margin:16px 24px 4px;padding:12px 14px;border-radius:12px;background:var(--card);border:1px solid var(--border)">
    <div class="grow"><div style="font-size:14px;font-weight:600">Односимвольні скорочення</div><div class="t-foot muted">Клавіші без ⌘/Ctrl. Ніколи не спрацьовують у текстовому полі. Налаштування зберігається на цьому пристрої.</div></div>
    <span role="switch" aria-checked="true" aria-label="Односимвольні скорочення" style="width:44px;height:26px;border-radius:13px;background:var(--primary);position:relative;flex:none"><i style="position:absolute;right:3px;top:3px;width:20px;height:20px;border-radius:10px;background:var(--primary-fg)"></i></span></div>
  <div class="row" style="gap:32px;padding:12px 24px 24px;align-items:flex-start">
  ${col('Загальні', [row('Палітра команд', ['⌘', 'K']), row('Пошук на сторінці', ['/']), row('Ця довідка', ['?']), row('Закрити панель / діалог', ['Esc']), row('Згорнути бічну панель', ['⌘', '\\'])])}
  ${col('Перехід', [row('Фінанси', ['G', 'потім', 'F']), row('Статистика', ['G', 'потім', 'S']), row('Користувачі', ['G', 'потім', 'U']), row('Дашборд', ['G', 'потім', 'H'])])}
  ${col('Списки', [row('Наступний рядок', ['J']), row('Попередній рядок', ['K']), row('Відкрити рядок', ['↵']), row('Створити', ['C']), row('Фільтр', ['F'])])}</div></div>`
}
