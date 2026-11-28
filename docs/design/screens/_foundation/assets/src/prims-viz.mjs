// Primitives v2, part 2: ResponsiveSheet on tablet/desktop, toasts, upload indicator, skeletons,
// chart theme, pull-to-refresh, page-transition storyboard.
import { fileName, icon, phone, safeBottom, segmented } from './base.mjs'
// R5-30: the delta names the comparison in full (wrap allowed) and shows on every class (primitives-v2 §6).
const DELTA = '▲ 12% до попереднього періоду'
import {
  tabScreen,
  interviewsBody,
  peopleList,
  createDock,
  searchField,
  chips,
  txnList,
  txnRow,
  TXNS,
  topBar,
  largeTitle,
  tabBar,
  TABBAR_H,
  FLOAT_RIGHT,
} from './mobile.mjs'
import { skeletonList, skRow } from './mobile-overlays.mjs'
import { ACTIONS, QUICK_ADD } from './nav.mjs'
import { desktop, deskToolbar } from './desktop.mjs'
import { tablet } from './tablet.mjs'
import {
  moneyBody,
  errAlert,
  discardBtn,
  MATCH_ROW,
  SIMILAR_ROW,
  NEW_ROWS,
  AMOUNT,
  SENT_AT,
  DRAFT,
  pinnedRows,
} from './money-form.mjs'

// ---------- ResponsiveSheet ≥ 640: right side panel; confirm = centred dialog ----------

function sidePanel(width, { touch = false, modal = true, extra = {} } = {}) {
  // < 1440 modal over a scrim (focus trapped); ≥ 1440 non-modal: a landmark in the flex row, no scrim, the table stays usable.
  const shell = modal
    ? `<div style="position:absolute;inset:0;background:var(--scrim);z-index:60"></div>
  <aside role="dialog" aria-modal="true" aria-labelledby="sp-t" style="position:absolute;top:0;right:0;bottom:0;width:${width}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);display:flex;flex-direction:column">`
    : `<aside aria-labelledby="sp-t" style="width:${width}px;flex:none;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);display:flex;flex-direction:column">`
  return `${shell}
  <div class="row" style="height:60px;flex:none;padding:0 12px 0 24px;border-bottom:1px solid var(--border)"><div id="sp-t" class="grow t-head">Редагувати транзакцію</div>${touch ? '' : `<span class="kbdkey" style="margin-right:6px">Esc</span>`}<span class="iconbtn" aria-label="Закрити">${icon('x', { size: 18 })}</span></div>
  <div class="grow" style="min-height:0;overflow:hidden">${
    // R3-03: one money-form shape on every class: the canonical body (receipt, centred amount, currency pill, type segment, fields).
    moneyBody({
      amount: '1 200,00',
      receipt: 'done',
      expanded: true,
      note: 'Оренда офісу',
      project: 'Альфа',
      pad: '16px 24px 24px',
      ...extra,
    })
  }</div>
  <div class="row" style="gap:8px;justify-content:flex-end;padding:14px 24px;border-top:1px solid var(--border)"><span class="btn sm secondary" style="height:${touch ? 44 : 36}px;font-size:14px">Скасувати</span><span class="btn sm primary" style="height:${touch ? 44 : 36}px;font-size:14px">Зберегти${touch ? '' : `<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">⌘↵</span>`}</span></div></aside>`
}

export const panelDesktop = (w, h) =>
  w >= 1440
    ? desktop({ w, h, panel: sidePanel(480, { modal: false }), panelW: 480 })
    : desktop({ w, h, overlay: sidePanel(420) })
/** R4-31: a definite or offline save error at >= 640 stays in the open panel, as on the phone (foundation §11):
 * the alert tops the panel body and takes focus, a field error sits inline, the primary stays enabled; no toast,
 * no pill, the panel never closes on its own. Tablet: offline; desktop: a definite 422 on the date. */
export const saveErrorOfflineTablet = (w, h) =>
  tablet({
    w,
    h,
    overlay: sidePanel(400, {
      touch: true,
      extra: {
        alert: errAlert(
          'Транзакцію не надіслано',
          'Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.',
        ),
      },
    }),
  })
export const saveErrorDefiniteDesktop = (w, h) =>
  desktop({
    w,
    h,
    overlay: sidePanel(420, { extra: { dateError: true, focus: 'date' } }),
  })
/** 640–1023 touch (F0-07): the same panel body as desktop, 400 px, 44 px ✕ and controls, the scrim dims the rail too.
 * Dismiss: ✕, Esc, outside tap on the scrim, system back, or a drag from the panel's left edge to the right. */
export const panelTablet = (w, h) => tablet({ w, h, overlay: sidePanel(400, { touch: true }) })

// ---------- Money drafts off the phone (foundation §11; shell-v2 §4 «Money drafts per size») ----------
const DOT =
  '<i aria-hidden="true" style="position:absolute;top:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--bg)"></i>'

const WARN = (p) => `color-mix(in oklch, var(--warning) ${p}%, transparent)`
// R3-32: the pill's «Відкрити» is a visible tonal text button (one primary per context; never muted text).
const OPEN = `<span class="btn sm" role="button" style="flex:none;height:36px;padding:0 12px;font-size:14px;color:var(--primary);background:oklch(0.84 0.183 85.3 / 0.14);border:0">Відкрити</span>`

/**
 * The «+» menus off the phone (foundation §11): the «Чернетки» section on top. `role`: the rail quick-add
 * menu keeps the role's actions; without it, the compact header / `C` menu ends with «Нова транзакція»
 * (initial focus, so `C` then Enter still creates). ↑ / ↓ move, Esc closes and returns focus to «+».
 */
function chooserMenu({ drafts, pos, itemH, coarse = false, role = '' }) {
  const tone = { failed: 'var(--destructive)', unknown: 'var(--warning)' }
  const item = (d) =>
    `<div role="menuitem" tabindex="-1" class="row" aria-label="Відкрити чернетку −${d.amount} USD, ${d.state.replaceAll(' · ', ', ')}" style="gap:10px;min-height:${itemH}px;padding:0 10px;border-radius:8px"><span style="color:${tone[d.kind] || 'var(--muted-fg)'};display:grid">${icon('file-pen', { size: 18 })}</span><span class="grow col" style="gap:1px;min-width:0"><span class="num" style="font-size:14px;font-weight:600;white-space:nowrap">−${d.amount} USD</span><span class="muted num" style="font-size:${coarse ? 13 : 12}px;line-height:${coarse ? 18 : 16}px;overflow-wrap:anywhere">${d.state}</span></span><span aria-hidden="true" style="flex:none;padding:4px 10px;border-radius:8px;font-size:13px;font-weight:600;color:var(--primary);background:oklch(0.84 0.183 85.3 / 0.14)">Відкрити</span></div>`
  // At most 2 draft rows in any menu; from 3, the header's text button «Усі чернетки (N)» opens Фінанси (no extra row).
  const all =
    drafts.length > 2
      ? `<span role="menuitem" tabindex="-1" class="num" style="padding:12px 8px;margin:-12px -8px;font-size:12px;font-weight:600;color:var(--primary)">Усі чернетки (${drafts.length})</span>`
      : ''
  const items = `<div role="group" aria-labelledby="ch-drafts"><div class="row" style="justify-content:space-between;padding:6px 10px 4px"><span id="ch-drafts" class="t-over">Чернетки</span>${all}</div>${drafts.slice(0, 2).map(item).join('')}</div>`
  // Touch: the initial focus is real but drawn only on :focus-visible, so no ring under (pointer: coarse).
  const focus = coarse ? '' : 'background:var(--raised);box-shadow:inset 0 0 0 2px var(--primary)'
  const act = (a, i) =>
    `<div role="menuitem" tabindex="${i ? -1 : 0}" class="row" style="gap:10px;min-height:${itemH}px;padding:0 10px;border-radius:8px;${i ? '' : focus}"><span style="color:${i ? 'var(--muted-fg)' : 'var(--primary)'};display:grid">${icon(ACTIONS[a].icon, { size: 18 })}</span><span class="grow" style="font-size:14px;font-weight:600">${ACTIONS[a].label}</span></div>`
  const tail = role
    ? QUICK_ADD[role].map(act).join('')
    : `<div role="menuitem" tabindex="0" class="row" style="gap:10px;min-height:${itemH}px;padding:0 10px;border-radius:8px;${focus}"><span style="color:var(--primary);display:grid">${icon('plus', { size: 18, stroke: 2.4 })}</span><span class="grow" style="font-size:14px;font-weight:600">Нова транзакція</span>${coarse ? '' : '<span class="kbdkey">Enter</span>'}</div>`
  return `<div style="position:absolute;${pos};width:340px;z-index:90;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6)">
  <div id="ch-menu" role="menu" aria-label="${role ? 'Створити' : 'Нова транзакція або чернетка'}" style="padding:6px">${items}<div role="separator" style="height:1px;margin:6px 4px;background:var(--border)"></div>${tail}</div>
  ${coarse ? '' : '<div aria-hidden="true" class="t-cap muted" style="padding:8px 16px;border-top:1px solid var(--border)">↑ ↓ чернетки · Esc закрити</div>'}</div>`
}

/** Desktop with one unknown draft: the pill bottom-right, a pinned row in the 40 px table, the header dot. */
export function draftsDesktop(w, h, { chooser = false } = {}) {
  const pill = `<div role="button" aria-label="Результат невідомий: −${AMOUNT} USD, надіслано о\u00a0${SENT_AT}. Відкрити" class="row" style="position:absolute;right:24px;bottom:24px;z-index:80;width:320px;height:52px;gap:10px;padding:0 14px 0 12px;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.42 0.09 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5)"><span style="color:var(--primary);display:grid">${icon('circle-help', { size: 20 })}</span><span class="grow col" style="gap:1px;min-width:0"><span style="font-size:13px;font-weight:600">Результат невідомий</span><span class="t-cap muted num" style="white-space:nowrap">−${AMOUNT} USD · ${SENT_AT}</span></span>${OPEN}</div>`
  // R4-08: the pinned draft row keeps the table's column grid: the state in «Опис» with a tonal «Відкрити» text
  // button, the type in «Тип», the amount in «Сума», and the fine-pointer «…» in the action slot (its menu:
  // «Відкрити» · «Відкинути чернетку»). A click on the row opens the draft too; «…» is the only other way in.
  const cell = (inner, extra = '') => `<td style="background:${WARN(7)};${extra}">${inner}</td>`
  const row = (wide) =>
    `<tr aria-label="Чернетка −${AMOUNT} USD, результат невідомий, надіслано о\u00a0${SENT_AT}">${cell(`<span class="row num" style="gap:6px;color:var(--warning)">${icon('file-pen', { size: 16 })}<span class="muted">${SENT_AT}</span></span>`, 'box-shadow:inset 2px 0 0 var(--warning)')}${cell(`<span class="row" style="gap:8px;min-width:0"><span class="trunc muted">Результат невідомий</span><button type="button" class="btn sm" aria-label="Відкрити чернетку −${AMOUNT} USD" style="flex:none;height:28px;padding:0 10px;font-size:13px;color:var(--primary);background:oklch(0.84 0.183 85.3 / 0.14);border:0">Відкрити</button></span>`)}${cell('<span class="muted">Витрата</span>')}${wide ? cell('<span class="muted">—</span>') : ''}${cell('')}${cell(`<span class="num" style="font-weight:600;white-space:nowrap;display:block;text-align:right">−${AMOUNT} USD</span>`)}<td class="kcell" style="background:${WARN(7)}"><button type="button" class="iconbtn" aria-haspopup="menu" aria-label="Дії: чернетка −${AMOUNT} USD" style="width:32px;height:32px;margin:auto">${icon('ellipsis', { size: 18 })}</button></td></tr>`
  const menu = chooser
    ? chooserMenu({ drafts: [DRAFT.unknown], pos: 'right:20px;top:52px', itemH: 40 })
    : ''
  // On Фінанси every «+» opens a new form directly; the chooser lives on the other pages (Статистика).
  const page = chooser
    ? {
        active: '/stats',
        crumb: ['Гроші', 'Статистика'],
        content: `<div style="padding:18px 20px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-foot muted" style="font-size:13px">Чистий прибуток · 6 міс</div><div class="num" style="font-size:26px;font-weight:700;letter-spacing:-0.02em">+${usd(NET_K)} USD</div><div class="t-foot" style="color:var(--positive);margin-top:2px">${DELTA}</div><div style="margin-top:10px">${netBars(1100, 300, { labelSize: 12, pad: 34 })}</div>${legend(
          [
            ['var(--chart-1)', 'Прибуток'],
            ['', 'Збиток', 'hatch'],
          ],
        )}</div>`,
      }
    : {}
  const html = desktop({ w, h, overlay: pill + menu, ...page })
  return (
    html
      // The scroller pads by the stack height + 24 (52 + 24 + 24), so the pill never covers the last row.
      .replace('padding:20px 24px 24px;', 'padding:20px 24px 100px;')
      .replace('<tr aria-selected="true" style="background:var(--raised)">', '<tr>')
      .replace('<tbody>', `<tbody>${row(/>Проєкт</.test(html))}`)
      .replace(
        '<span class="btn primary" style="height:36px',
        `<span class="btn primary" aria-label="Нова транзакція, 1 чернетка потребує уваги"${chooser ? ' aria-haspopup="menu" aria-expanded="true" aria-controls="ch-menu"' : ''} style="position:relative;height:36px`,
      )
      .replace('C</span></span></header>', `C</span>${DOT}</span></header>`)
  )
}

/** Tablet: the rail «+» with the dot opens its quick-add menu (drafts on top, then the role's actions); 44 px items. */
export function draftsChooserTablet(w, h) {
  const menu = chooserMenu({
    drafts: [DRAFT.unknown, DRAFT.failed2],
    pos: 'left:88px;top:86px',
    itemH: 44,
    coarse: true,
    role: 'ADMIN',
  })
  const pill = `<div role="button" aria-label="2 чернетки потребують перевірки. Відкрити" class="row" style="position:absolute;right:24px;bottom:24px;z-index:80;width:320px;height:52px;gap:10px;padding:0 14px 0 12px;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.38 0.09 22);box-shadow:0 10px 30px oklch(0 0 0 / 0.5)"><span style="color:var(--destructive);display:grid">${icon('file-pen', { size: 20 })}</span><span class="grow col" style="gap:1px;min-width:0"><span style="font-size:13px;font-weight:600">2 потребують перевірки</span></span>${OPEN}</div>`
  // The list pads by the pill height + 48 (52 + 24 + 24), so the corner never covers the last row.
  const list = `<section aria-label="Співбесіди" class="col" style="width:360px;flex:none;border-right:1px solid var(--border)">
  <div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Співбесіди</div></div>
  <div style="flex:1;min-height:0;overflow:hidden;padding-bottom:100px">${searchField('Пошук співбесід')}${chips(['Усі', 'HR-скринінг', 'Технічна', 'З клієнтом', 'Офер'])}${peopleList({ menu: true })}</div></section>`
  return (
    tablet({ w, h, overlay: menu + pill, list, active: '/interviews' })
      .replace(
        / aria-haspopup="dialog"/,
        ' aria-haspopup="menu" aria-expanded="true" aria-controls="ch-menu"',
      )
      .replace(/aria-label="Створити"/, 'aria-label="Створити, 2 чернетки потребують уваги"')
      .replace(/style="width:52px;height:52px;/, 'style="position:relative;width:52px;height:52px;')
      // R3-06: from two drafts needing attention the rail «+» carries the 18 px count badge (§12 Drafts), never the plain dot.
      .replace(/(style="position:relative;width:52px[^>]*><svg[\s\S]*?<\/svg>)/, `$1${COUNT(2)}`)
  )
}
const COUNT = (n) =>
  `<i aria-hidden="true" class="num" style="position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;border-radius:9px;background:var(--destructive-solid);color:#fff;font:700 12px/18px var(--font);font-style:normal;text-align:center;box-shadow:0 0 0 2px var(--bg)">${n}</i>`

/** «Перевірити список» at ≥ 640: a centred 560 px dialog over the side panel, which stays mounted. */
// `touch`: 400 px panel, 44 px controls, no key hints (tablet); otherwise the 420 px panel and 36 px controls.
function checkPanel(touch) {
  return `<div style="position:absolute;inset:0;background:var(--scrim);z-index:60"></div>
  <aside role="dialog" aria-modal="true" aria-labelledby="dp-t" style="position:absolute;top:0;right:0;bottom:0;width:${touch ? 400 : 420}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);display:flex;flex-direction:column">
  <div class="row" style="height:56px;flex:none;padding:0 12px 0 8px;border-bottom:1px solid var(--border)"><button type="button" class="btn ghost" style="height:${touch ? 44 : 36}px;font-size:15px;font-weight:400;padding:0 12px">Згорнути</button><div id="dp-t" class="grow t-head" style="text-align:center">Нова транзакція</div><span style="width:96px"></span></div>
  <div class="grow" style="min-height:0;overflow:hidden">${moneyBody({
    receipt: 'done',
    locked: true,
    pad: '16px 20px 24px',
    alert: errAlert(
      'Невідомо, чи транзакцію збережено',
      'Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.',
      85,
    ),
  })}</div>
  <div style="padding:12px 20px 16px;border-top:1px solid var(--border)"><button type="button" class="btn primary" style="width:100%">${icon('list', { size: 18 })}Перевірити список</button>${discardBtn}</div></aside>`
}
function checkBox(touch) {
  const rows = [MATCH_ROW, ...NEW_ROWS, SIMILAR_ROW].map((r) => txnRow(r)).join('')
  const bh = touch ? 44 : 36
  return `<div style="position:absolute;inset:0;background:var(--scrim);z-index:80"></div>
  <div role="dialog" aria-modal="true" aria-labelledby="ck-t" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${touch ? 600 : 560}px;z-index:90;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);overflow:hidden">
  <div class="row" style="height:56px;padding:0 ${touch ? 6 : 12}px 0 20px;border-bottom:1px solid var(--border)"><div id="ck-t" class="grow t-head">Нові записи</div>${touch ? '' : '<span class="kbdkey" style="margin-right:6px">Esc</span>'}<button type="button" class="iconbtn" aria-label="Закрити" style="width:${touch ? 44 : 32}px;height:${touch ? 44 : 32}px">${icon('x', { size: 18 })}</button></div>
  <div class="col" style="gap:8px;padding:14px 20px 10px">
    <div class="t-sub num" style="font-weight:600">Шукаємо: −${AMOUNT} USD · Витрата · без опису · надіслано ${SENT_AT}</div>
    <div class="t-foot muted num">Лише ваші записи з 14:27</div>
    <div class="row" style="gap:8px"><div role="status" class="grow t-foot muted row num" style="gap:6px">${icon('rotate-cw', { size: 14 })}Оновлено о\u00a014:34:01. Знайдено збіг</div><button type="button" class="btn sm secondary" style="height:${touch ? 44 : 32}px;font-size:13px">${icon('refresh-cw', { size: 14 })}Оновити</button></div>
    <div class="t-foot" style="padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)">Схоже, це ваша транзакція: −${AMOUNT} USD, створена о\u00a014:33. Перевірте її, перш ніж створювати ще раз.</div>
  </div>
  <div class="group" style="margin:0 20px">${rows}</div>
  <div class="row" style="gap:8px;justify-content:flex-end;padding:14px 20px;margin-top:14px;border-top:1px solid var(--border)"><button type="button" class="btn sm secondary" style="height:${bh}px;font-size:14px">${icon('plus', { size: 16 })}Немає — створити ще раз</button><button type="button" class="btn sm primary" style="height:${bh}px;font-size:14px">${icon('check', { size: 16 })}Є в списку — закрити чернетку</button></div></div>`
}
export const checkDialog = (w, h) => desktop({ w, h, overlay: checkPanel(false) + checkBox(false) })
/** R1-08: the same two layers on a tablet (640–1023): panel 400 px + a centred dialog, 44 px controls, no key hints. */
export const checkDialogTablet = (w, h) =>
  tablet({ w, h, overlay: checkPanel(true) + checkBox(true) })

/**
 * R3-01, overlay depth ≥ 640: «Немає — створити ще раз» REPLACES the check dialog with the 440 px confirm, so the
 * page holds two layers (the panel and the confirm), never three. «Скасувати» (initial focus) returns to the check dialog.
 */
function recreateBox(touch) {
  const bh = touch ? 'height:44px;font-size:16px;padding:0 18px' : 'height:36px;font-size:14px'
  return `<div style="position:absolute;inset:0;background:var(--scrim);z-index:80"></div>
  <div role="alertdialog" aria-modal="true" aria-labelledby="cr-t" aria-describedby="cr-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;z-index:90;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:20px 20px 16px">
  <div id="cr-t" class="t-head num">Створити −${AMOUNT.replace(' ', ' ')} USD ще раз?</div>
  <div id="cr-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">У списку є збіг о\u00a014:33. Буде створено одну нову транзакцію: витрата, сьогодні, без проєкту.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><button type="button" class="btn sm secondary" style="${bh};box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Скасувати</button><button type="button" class="btn sm primary" style="${bh}">Створити ще раз</button></div></div>`
}
export const confirmRecreateTablet = (w, h) =>
  tablet({ w, h, overlay: checkPanel(true) + recreateBox(true) })
export const confirmRecreateDesktop = (w, h) =>
  desktop({ w, h, overlay: checkPanel(false) + recreateBox(false) })
/** R1-08: an unknown result on a tablet: the locked panel with the alert and «Перевірити список» as the one primary. */
export const saveFailureTablet = (w, h) => tablet({ w, h, overlay: checkPanel(true) })
/** R1-08: an unresolved draft on a tablet: the pill bottom-right and the pinned row at the top of the list; the rail «+» carries the dot. */
export function unresolvedDraftTablet(w, h) {
  const pill = `<div role="button" aria-label="Результат невідомий: −${AMOUNT} USD, надіслано о\u00a0${SENT_AT}. Відкрити" class="row" style="position:absolute;right:24px;bottom:24px;z-index:80;width:340px;min-height:52px;gap:10px;padding:0 14px 0 12px;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.42 0.09 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5)"><span style="color:var(--primary);display:grid">${icon('circle-help', { size: 20 })}</span><span class="grow col" style="gap:1px;min-width:0"><span style="font-size:13px;font-weight:600">Результат невідомий</span><span class="t-cap muted num" style="white-space:nowrap">−${AMOUNT} USD · ${SENT_AT}</span></span>${OPEN}</div>`
  return tablet({ w, h, overlay: pill })
    .replace(
      '<div class="sechead"><span class="t-over">Сьогодні</span></div>',
      `${pinnedRows([DRAFT.unknown])}<div class="sechead"><span class="t-over">Сьогодні</span></div>`,
    )
    .replace(/aria-label="Створити"/, 'aria-label="Створити, 1 чернетка потребує уваги"')
    .replace(/style="width:52px;height:52px;/, 'style="position:relative;width:52px;height:52px;')
    .replace(/(style="position:relative;width:52px[^>]*><svg[\s\S]*?<\/svg>)/, `$1${DOT}`)
}

// Focus lands on «Скасувати» first (drawn as the ring); Enter on it is safe, Esc = «Скасувати».
const confirmBox = (touch) => {
  const bh = touch ? 'height:44px;font-size:16px;padding:0 18px' : 'height:36px;font-size:14px'
  return `<div style="position:absolute;inset:0;background:var(--scrim);z-index:60"></div>
  <div role="alertdialog" aria-modal="true" aria-labelledby="cd-t" aria-describedby="cd-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">
  <div id="cd-t" class="t-head">Видалити транзакцію «Оренда офісу»?</div>
  <div id="cd-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">−1 200,00 USD · 11.11.2026. Цю дію не можна скасувати; чек теж буде видалено.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><button type="button" class="btn sm secondary" style="${bh};box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Скасувати</button><button type="button" class="btn sm" style="${bh};background:var(--destructive-solid);color:#fff">Видалити</button></div></div>`
}
export const confirmDialog = (w, h) => desktop({ w, h, overlay: confirmBox(false) })
/** 640–1023 (F0-08): the same centred alertdialog over the dimmed rail and list, 44 px buttons, no key hints. */
export const confirmDialogTablet = (w, h) => tablet({ w, h, overlay: confirmBox(true) })

/**
 * Desktop table row states, top to bottom: default (with a status pill), hover, selected, keyboard focus,
 * write pending (F0-37). Columns match the real table below 1032 px of main: Дата · Опис · Тип · Чек · Сума.
 * The state names live in the spec (primitives-v2 §12), never inside the UI.
 */
// R2-31: the same widths as the full-page table (desktop.mjs COLW) and a reserved 48 px «…» column.
export const TABLE_COLS = { d: 72, ty: 96, rc: 56, a: 150, k: 48 }
export function tableRows() {
  const C = TABLE_COLS
  const clip = `<span class="muted" style="width:${C.rc}px;display:grid;place-items:center" aria-label="Чек додано">${icon('paperclip', { size: 15 })}</span>`
  const noClip = `<span style="width:${C.rc}px"></span>`
  const amt = (a) => {
    const i = a.lastIndexOf(' ')
    return `<span style="display:inline-flex;justify-content:flex-end"><span>${a.slice(0, i)}</span><span style="width:38px;text-align:left;padding-left:6px">${a.slice(i + 1)}</span></span>`
  }
  const r = (state, d, t, ty, a, { pos = false, extra = '', rc = true } = {}) => {
    const st = {
      default: '',
      hover: 'background:oklch(0.15 0.004 85)',
      selected: 'background:var(--raised);box-shadow:inset 2px 0 0 var(--primary)',
      focus: 'outline:2px solid var(--primary);outline-offset:-2px',
      pending: '',
    }[state]
    const ink = state === 'pending' ? 'color:var(--muted-fg);' : ''
    return `<div class="row" ${state === 'pending' ? 'aria-busy="true"' : ''} ${state === 'selected' ? 'aria-selected="true"' : ''} style="height:40px;padding:0 16px;gap:16px;font-size:14px;border-bottom:1px solid var(--separator);${st}"><span class="num muted" style="width:${C.d}px">${d}</span><span class="grow row" style="gap:8px;min-width:0;${ink}"><span class="trunc" title="${t}">${t}</span>${extra}</span><span class="muted" style="width:${C.ty}px">${ty}</span>${rc ? clip : noClip}<span class="num" style="width:${C.a}px;text-align:right;font-weight:600;${ink}${pos ? 'color:var(--positive)' : ''}">${amt(a)}</span><span style="width:${C.k}px;flex:none;display:grid;place-items:center;margin-right:-16px">${state === 'default' || state === 'pending' ? '' : `<span class="iconbtn" role="button" aria-haspopup="menu" aria-label="Дії: ${t}" style="width:36px;height:36px">${icon('ellipsis', { size: 18 })}</span>`}</span></div>`
  }
  const saving = `<span class="row t-cap muted" role="status" style="gap:4px">${icon('loader-circle', { size: 13 })}Зберігаємо…</span>`
  return `<div style="padding:24px;background:var(--bg);width:960px"><div style="border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden">
  <div class="row" style="height:36px;padding:0 16px;gap:16px;font-size:12px;font-weight:600;color:var(--muted-fg);border-bottom:1px solid var(--border)"><span aria-sort="descending" style="width:${C.d}px;display:inline-flex;align-items:center;gap:2px;color:var(--fg)">Дата${icon('arrow-down', { size: 14 })}</span><span class="grow">Опис</span><span style="width:${C.ty}px">Тип</span><span style="width:${C.rc}px;text-align:center">Чек</span><span style="width:${C.a}px;text-align:right">Сума</span><span style="width:${C.k}px;margin-right:-16px;flex:none"><span class="sr">Дії</span></span></div>
  ${r('default', '11.11', 'Хмарний хостинг', 'Витрата', '−86,40 USD', { extra: '<span class="pill warn" style="height:20px;font-size:11px">Очікує</span>' })}${r('hover', '11.11', 'Оплата від клієнта', 'Дохід', '+4 800,00 USD', { pos: true, rc: false })}${r('selected', '10.11', 'Зарплата · Розробник 4', 'Зарплата', '−2 150,00 USD', { rc: false })}${r('focus', '10.11', 'Переказ на рахунок компанії', 'Переказ', '−3 000,00 USDT', { rc: false })}${r('pending', '09.11', 'Оренда офісу', 'Витрата', '−1 250,50 USD', { extra: saving })}</div></div>`
}

// ---------- Toasts ----------
export function toastUndo(
  w,
  h,
  { text = 'Архівовано: Богдан Ткач', ic = 'archive', body = interviewsBody() } = {},
) {
  // < 360 (F0-19): the 228 px slot beside «+» is too narrow, so the toast spans the width and sits above «+»;
  // the subject wraps to two lines at most, the action never wraps or shrinks.
  const narrow = w < 360
  const pos = narrow
    ? `right:12px;bottom:${TABBAR_H + safeBottom(w) + 16 + 56 + 8}px`
    : `right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16}px`
  const t = `<div class="toast" role="status" style="${pos};min-height:56px;overflow:hidden"><span style="color:var(--positive)">${icon(ic, { size: 18 })}</span><span class="grow" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:20px">${text}</span><span class="btn ghost" style="color:var(--primary);height:44px;padding:0 10px;font-size:15px">Скасувати</span><i style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--primary);opacity:0.7"></i></div>`
  return tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body,
    overlay: t,
    showFab: true,
  })
}

// Money create failed (spec §4.5b + Master ruling): definite = 4xx + app 500/503 (+ offline before send),
// unknown = 502/504/524, a drop after send, a client timeout. Drawn on the canonical money form.
export {
  failure422 as toastErrorDefinite,
  failureOffline as toastErrorOffline,
  failureUnknown as toastErrorUnknown,
  failureUnknownList as toastErrorUnknownList,
  uploadPillArmed,
  uploadPillSaved,
  uploadPillFailed,
  uploadPillMulti,
  uploadPillUnknown,
  draftsTwo,
  draftsTwoUnresolved,
  draftsFourCollapsed,
  toastPillStack,
  pageKillAlert,
  checkSheetBoot,
  listrowDraft,
  confirmRecreate,
  confirmDiscardDraft,
} from './money-form.mjs'

// ---------- Upload indicator ----------
const ring = (pct, size = 36) => {
  const c = 2 * Math.PI * 15
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Завантаження чека"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.14)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
}
export function uploadStates(w, h) {
  const thumb = `<div style="width:44px;height:52px;border-radius:8px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;flex:none"></div>`
  const row = (title, sub, trail, subStyle = '') =>
    `<div class="lrow two" style="--inset:72px">${thumb}<div class="grow col" style="gap:2px;min-width:0">${/\.\w{3,4}$/.test(title) ? fileName(title, 't-body', 'font-weight:500') : `<div class="t-body clamp2" style="font-weight:500">${title}</div>`}<div class="t-foot num" style="overflow-wrap:anywhere;${subStyle || 'color:var(--muted-fg)'}">${sub}</div></div>${trail}</div>`
  const inner = `${topBar({ back: true, title: 'Чеки', bell: false, search: false })}<div class="content">
  <div class="sechead"><span class="t-over">Стани завантаження</span></div><div class="group">
  ${row('receipt-office.jpg', 'Завантаження · 62% · 0,9 з 1,4 МБ', `<span class="row" style="gap:6px">${ring(62)}<span class="iconbtn" aria-label="Скасувати завантаження">${icon('x', { size: 18 })}</span></span>`)}
  ${row('receipt-taxi.jpg', 'Стискаємо фото…', `<span class="row" style="gap:6px">${ring(8)}<span class="iconbtn" aria-label="Скасувати завантаження">${icon('x', { size: 18 })}</span></span>`)}
  ${row('receipt-hosting.pdf', 'Завантажено · 220 КБ', `<span class="row" style="gap:4px;color:var(--positive);font-size:14px;font-weight:500">${icon('circle-check', { size: 18 })}Готово</span>`)}
  ${row('receipt-monitor.jpg', 'Не вдалося завантажити: файл більший за 10 МБ', `<span class="btn sm secondary">Інший файл</span>`, 'color:var(--destructive)')}
  ${row('receipt-stationery.jpg', 'Зв’язок перервано на 45%', `<span class="btn sm secondary">${icon('rotate-cw', { size: 14 })}Повторити</span>`, 'color:var(--destructive)')}</div>
  <div class="sechead"><span class="t-over">Глобальний індикатор</span></div>
  <div style="padding:0 16px"><div class="t-foot muted">Поки є активні завантаження, над панеллю вкладок видно один компактний рядок. Навігація не блокується.</div></div></div>
  <div class="row" style="position:absolute;left:12px;right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16}px;z-index:40;gap:10px;height:52px;padding:0 4px 0 12px;border-radius:26px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5);font-size:14px">${ring(40, 26)}<span class="grow num" style="white-space:nowrap" aria-hidden="true">2 чеки · 40%</span><span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Почалося завантаження 2 чеків</span><span class="iconbtn" aria-label="Показати завантаження">${icon('chevron-up', { size: 18 })}</span></div>
  ${tabBar('ADMIN', '/finance', { w })}`
  return phone({ w, h, inner })
}

// ---------- Skeletons ----------
export function skeletonMobile(w, h) {
  const kpi = `<div style="padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="sk" style="height:11px;width:60%"></div><div class="sk" style="height:24px;width:80%;margin-top:12px"></div><div class="sk" style="height:10px;width:40%;margin-top:10px"></div></div>`
  const chart = `<div style="margin:16px;padding:14px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="sk" style="height:12px;width:45%"></div><div class="row" style="align-items:flex-end;gap:10px;height:120px;margin-top:16px">${[60, 85, 40, 95, 70, 55].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div></div>`
  const body = `<div role="status" aria-label="Завантаження дашборда" style="display:contents"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:4px 16px 0">${kpi.repeat(4)}</div>${chart}${skeletonList(2)}</div>`
  return tabScreen({ w, h, role: 'ADMIN', active: 'more', title: 'Дашборд', body })
}

export function skeletonTable() {
  // The same columns and widths as tableRows() (F0-37), so the first paint does not reflow. R4-17: the fine-pointer
  // «…» slot is empty (the loaded row shows «…» only on hover / focus), so the skeleton draws nothing there.
  const C = TABLE_COLS
  const row = (i) =>
    `<div class="row" style="height:40px;padding:0 16px;gap:16px;border-bottom:1px solid var(--separator)"><div style="width:${C.d}px"><div class="sk" style="width:40px;height:11px"></div></div><div class="grow"><div class="sk" style="width:${[56, 40, 66, 46, 52, 34, 60, 44][i % 8]}%;height:12px"></div></div><div style="width:${C.ty}px"><div class="sk" style="width:60px;height:11px"></div></div><div style="width:${C.rc}px;display:grid;place-items:center">${i % 3 ? '' : '<div class="sk" style="width:14px;height:14px;border-radius:4px"></div>'}</div><div style="width:${C.a}px;display:flex;justify-content:flex-end"><div class="sk" style="width:90px;height:12px"></div></div><div style="width:${C.k}px;flex:none;margin-right:-16px"></div></div>`
  return `<div style="padding:24px;background:var(--bg);width:960px" role="status" aria-label="Завантаження транзакцій"><div style="margin-bottom:14px">${deskToolbar({ mainW: 912, count: '<span class="sk" style="display:block;width:96px;height:12px"></span>' })}</div>
  <div style="border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden"><div class="row" style="height:36px;padding:0 16px;gap:16px;font-size:12px;font-weight:600;color:var(--muted-fg);border-bottom:1px solid var(--border)"><span style="width:${C.d}px">Дата</span><span class="grow">Опис</span><span style="width:${C.ty}px">Тип</span><span style="width:${C.rc}px;text-align:center">Чек</span><span style="width:${C.a}px;text-align:right">Сума</span><span style="width:${C.k}px;margin-right:-16px;flex:none"><span class="sr">Дії</span></span></div>${Array.from({ length: 8 }, (_, i) => row(i)).join('')}</div></div>`
}

// ---------- Chart theme ----------
const MONTHS = ['черв', 'лип', 'серп', 'вер', 'жовт', 'лист']
const NET = [4.2, 6.8, -1.4, 5.1, 7.9, 3.3] // k USD, invented
const PART = [
  [3.1, 2.4],
  [2.2, 3.6],
  [4.0, 1.8],
  [2.8, 3.0],
] // partners ВК / ОШ (invented: Віктор Кравець, Олена Шевчук), k USD
// R1-23: a headline is derived from its parts and asserted, never typed (single currency: USD).
const sumK = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 10) / 10
const usd = (k) => String(Math.round(k * 1000)).replace(/\B(?=(\d{3})+$)/g, ' ') + ',00'
const kFmt = (v) => v.toFixed(1).replace('.', ',')
const NET_K = sumK(NET)
const PART_K = sumK(PART.flat())
if (NET_K !== 25.9 || PART_K !== 22.9)
  throw new Error(`chart fixture drift: net ${NET_K}, partners ${PART_K}`)
// October (NET[4]) as the tooltip shows it: income − expenses = net, and net is the bar's value.
export const OCT = { income: 18400, expenses: 10500, net: 7900 }
if (OCT.income - OCT.expenses !== OCT.net || OCT.net !== Math.round(NET[4] * 1000))
  throw new Error(`october tooltip drift: ${JSON.stringify(OCT)} vs bar ${NET[4]}`)
const money = (n) => usd(n / 1000)

// R3-20: `selected` (a tapped or focused bar) keeps full ink with a 2 px ring; the other bars dim to 45 %.
export function netBars(W, H, { labelSize = 11, pad = 28, selected = -1 } = {}) {
  const max = 8,
    min = -3.2,
    top = 18,
    bottom = H - 22
  const y = (v) => top + ((max - v) / (max - min)) * (bottom - top)
  const bw = (W - pad * 2) / NET.length
  const grid = [8, 4, 0]
    .map(
      (g) =>
        `<line x1="${pad}" x2="${W - 4}" y1="${y(g)}" y2="${y(g)}" stroke="var(--chart-grid)" ${g ? 'stroke-dasharray="2 4"' : ''}/><text x="${pad - 6}" y="${y(g) + 4}" text-anchor="end" font-size="${labelSize}" fill="var(--muted-fg)">${g}</text>`,
    )
    .join('')
  const bars = NET.map((v, i) => {
    const x = pad + i * bw + bw * 0.2,
      w = bw * 0.6,
      y0 = y(0),
      y1 = y(v)
    const neg = v < 0
    const dim = selected >= 0 && i !== selected ? ' opacity="0.45"' : ''
    const ring = i === selected ? ' stroke="var(--fg)" stroke-width="2"' : ''
    return `<rect${dim}${ring} x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.abs(y1 - y0)}" rx="3" fill="${neg ? 'url(#hatch)' : 'var(--chart-1)'}" ${neg ? 'stroke="var(--chart-1)" stroke-width="1.2"' : ''}/>
    <text x="${x + w / 2}" y="${neg ? y1 + 13 : y1 - 5}" text-anchor="middle" font-size="${labelSize}" font-weight="600" fill="var(--fg)" style="font-variant-numeric:tabular-nums">${neg ? '−' : '+'}${Math.abs(v).toFixed(1).replace('.', ',')}</text>
    <text x="${x + w / 2}" y="${H - 6}" text-anchor="middle" font-size="${labelSize}" fill="var(--muted-fg)">${MONTHS[i]}</text>`
  }).join('')
  return `<svg width="${W}" height="${H}" role="img" aria-label="Чистий прибуток за 6 місяців: найбільший у жовтні, +7,9 тис. USD; збиток у серпні, −1,4 тис. USD"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="oklch(0.84 0.183 85.3 / 0.12)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-1)" stroke-width="1.4"/></pattern></defs>${grid}${bars}</svg>`
}

function partnerBars(W, H, { labelSize = 11, pad = 8 } = {}) {
  const max = 4.5,
    top = 14,
    bottom = H - 38
  const y = (v) => top + ((max - v) / max) * (bottom - top)
  const gw = (W - pad * 2) / PART.length
  const q = ['I кв', 'II кв', 'III кв', 'IV кв']
  return `<svg width="${W}" height="${H}" role="img" aria-label="Виплати партнерам по кварталах, тис. USD: Віктор Кравець — 3,1; 2,2; 4,0; 2,8. Олена Шевчук — 2,4; 3,6; 1,8; 3,0."><line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--chart-grid)"/>${PART.map(
    ([a, b], i) => {
      const x = pad + i * gw + gw * 0.16,
        bw = gw * 0.32
      const one = (v, xx, c) =>
        `<rect x="${xx}" y="${y(v)}" width="${bw - 2}" height="${y(0) - y(v)}" rx="3" fill="${c}"/><text x="${xx + (bw - 2) / 2}" y="${y(v) - 4}" text-anchor="middle" font-size="${labelSize - 1}" font-weight="600" fill="var(--fg)">${v.toFixed(1).replace('.', ',')}</text>`
      // Series named by initials directly under each bar: no legend lookup; full names in the aria-label.
      const ab = (t, xx) =>
        `<text x="${xx + (bw - 2) / 2}" y="${H - 24}" text-anchor="middle" font-size="${labelSize - 1}" font-weight="600" fill="var(--fg)">${t}</text>`
      return `${one(a, x, 'var(--chart-1)')}${one(b, x + bw, 'var(--chart-2)')}${ab('ВК', x)}${ab('ОШ', x + bw)}<text x="${x + bw}" y="${H - 6}" text-anchor="middle" font-size="${labelSize}" fill="var(--muted-fg)">${q[i]}</text>`
    },
  ).join('')}</svg>`
}

// The unit is stated once, in the caption row; bars and ticks carry bare numbers.
export const legend = (items, unit = 'тис. USD') =>
  `<div class="row" style="gap:14px;font-size:13px"><span class="muted">${unit}</span>${items.map(([c, t, shape]) => `<span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:${shape === 'hatch' ? '2px' : '2px'};background:${c};${shape === 'hatch' ? 'background:repeating-linear-gradient(45deg,var(--chart-1) 0 1.5px,transparent 1.5px 4px);outline:1px solid var(--chart-1)' : ''}"></i>${t}</span>`).join('')}</div>`

// R5-09: the tapped month's value line is exact (the signed net, then income and expenses, as the >= 640
// tooltip), and two 44 px buttons step to the previous / next month, so exact months are reachable where the
// bands are under 44 px and drag-scrub replaces a tap.
const STEP = (dir, label) =>
  `<button type="button" class="iconbtn" aria-label="${label}" style="flex:none;width:44px;height:44px;border-radius:12px;background:var(--secondary);color:var(--fg)">${icon(dir, { size: 20 })}</button>`
const monthStepper = () =>
  `<div class="row" style="flex-basis:100%;gap:8px;margin-top:6px;color:var(--fg);font-weight:400">${STEP('chevron-left', 'Попередній місяць')}<div class="grow col" style="gap:2px;min-width:0;align-items:center"><div class="t-foot" style="font-weight:600">Жовтень 2026</div><div class="row num" style="gap:6px 12px;flex-wrap:wrap;justify-content:center;font-size:13px"><span class="muted">Дохід</span><span style="white-space:nowrap">${money(OCT.income)} USD</span><span class="muted">Витрати</span><span style="white-space:nowrap">${money(OCT.expenses)} USD</span></div></div>${STEP('chevron-right', 'Наступний місяць')}</div>`
// R4-19: `tapped` — a tapped bar (жовт) keeps full ink with its ring, the others dim; the card's value line
// reads that month (a polite status), a second tap on it or a tap outside the plot clears it.
export function chartMobile(w, h, { scrolled = 0, tapped = false } = {}) {
  const card = (title, value, sub, chart, leg) =>
    `<div style="margin:0 16px 12px;padding:14px 14px 10px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-foot muted">${title}</div><div class="row" style="gap:2px 8px;flex-wrap:wrap;align-items:baseline;margin-top:2px"><span class="num" style="font-size:24px;font-weight:700;letter-spacing:-0.02em;white-space:nowrap">${value}</span><span class="t-foot num" style="color:var(--positive);white-space:nowrap">${sub}</span></div><div style="margin-top:8px">${chart}</div>${leg}</div>`
  const body = `<div style="padding:0 16px 10px">${segmented(['3 міс', '6 міс', 'Рік'], 1, { fit: true })}</div>
  ${card(
    'Чистий прибуток · 6 міс',
    tapped ? `<span role="status">+${money(OCT.net)} USD</span>` : `+${kFmt(NET_K)} тис. USD`,
    tapped ? monthStepper() : DELTA,
    netBars(w - 60, w <= 320 ? 200 : 380, tapped ? { selected: 4 } : {}),
    legend([
      ['var(--chart-1)', 'Прибуток'],
      ['', 'Збиток', 'hatch'],
    ]),
  )}
  ${card('Виплати партнерам · 2026', `${kFmt(PART_K)} тис. USD`, '', partnerBars(w - 60, 150), legend([]))}`
  return tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/stats',
    title: 'Статистика',
    body,
    showFab: true, // R5-29: 320 draws the FAB too (§6)
  })
    .replace(
      '<div class="content">',
      `<div class="content"><div style="transform:translateY(-${scrolled}px)">`,
    )
    .replace('</div><nav class="tabbar"', '</div></div><nav class="tabbar"')
}

export const chartTip = (pos, role = 'tooltip') =>
  `<div role="${role}" style="position:absolute;${pos};z-index:5;padding:8px 10px;border-radius:10px;background:var(--popover);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5);font-size:13px;min-width:176px;white-space:nowrap"><div style="font-weight:600">Жовтень 2026</div><div class="row" style="justify-content:space-between;gap:12px;margin-top:4px"><span class="muted">Дохід</span><span class="num" style="white-space:nowrap">${money(OCT.income)} USD</span></div><div class="row" style="justify-content:space-between;gap:12px"><span class="muted">Витрати</span><span class="num" style="white-space:nowrap">${money(OCT.expenses)} USD</span></div><div class="row" style="justify-content:space-between;gap:12px;margin-top:2px;font-weight:600"><span>Чистий</span><span class="num" style="white-space:nowrap">+${money(OCT.net)} USD</span></div></div>`

export function chartDesktop() {
  // No room right of «жовт», so the tooltip flips to its left, clear of every bar and label.
  const tooltip = chartTip('left:321px;top:46px')
  // F0-39: the period control and the active filter sit above the charts they drive; a filter is a removable chip.
  const seg = ['3 міс', '6 міс', 'Рік']
    .map(
      (s, i) =>
        `<span role="radio" aria-checked="${i === 1}" style="display:grid;place-items:center;height:28px;padding:0 12px;border-radius:7px;font-size:13px;font-weight:500;${i === 1 ? 'background:var(--raised);color:var(--fg)' : 'color:var(--muted-fg)'}">${s}</span>`,
    )
    .join('')
  const controls = `<div class="row" style="gap:10px;margin-bottom:16px"><span role="radiogroup" aria-label="Період графіка" class="row" style="gap:2px;padding:2px;border-radius:9px;background:var(--surface);border:1px solid var(--border)">${seg}</span><span class="row btn sm secondary" style="gap:6px;height:32px">${icon('calendar', { size: 14 })}Червень – листопад 2026</span><span class="row" style="gap:6px;height:32px;padding:0 6px 0 10px;border-radius:8px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);font-size:13px">Проєкт: Альфа<span class="iconbtn" aria-label="Прибрати фільтр «Проєкт: Альфа»" style="width:24px;height:24px">${icon('x', { size: 13 })}</span></span><span class="grow"></span><span class="t-foot muted">Дані на 12.11.2026, 09:00</span></div>`
  return `<div style="padding:24px;background:var(--bg);width:1200px">${controls}<div class="row" style="gap:16px;align-items:stretch">
  <div style="position:relative;flex:2;padding:18px 20px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="row"><div class="grow"><div class="t-foot muted" style="font-size:13px">Чистий прибуток</div><div class="num" style="font-size:26px;font-weight:700;letter-spacing:-0.02em">+${usd(NET_K)} USD</div><div class="t-foot" style="color:var(--positive);margin-top:2px">${DELTA}</div></div>${legend(
    [
      ['var(--chart-1)', 'Прибуток'],
      ['', 'Збиток', 'hatch'],
    ],
  )}</div><div style="margin-top:10px">${netBars(720, 260, { labelSize: 12, pad: 34 })}</div>${tooltip}</div>
  <div style="flex:1;padding:18px 20px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="t-foot muted" style="font-size:13px">Виплати партнерам · 2026</div><div class="num" style="font-size:26px;font-weight:700;letter-spacing:-0.02em">${usd(PART_K)} USD</div><div style="margin:10px 0 8px">${partnerBars(330, 252, { labelSize: 12 })}</div><div class="t-cap muted">тис. USD · ВК — Віктор Кравець · ОШ — Олена Шевчук</div></div></div>
  <div class="row" style="gap:10px;margin-top:16px;flex-wrap:wrap">${[
    ['--chart-1', 'chart-1 · primary'],
    ['--chart-2', 'chart-2'],
    ['--chart-3', 'chart-3'],
    ['--chart-4', 'chart-4'],
    ['--chart-5', 'chart-5 · нейтральний'],
    ['--positive', 'positive'],
    ['--warning', 'warning'],
    ['--destructive', 'destructive'],
  ]
    .map(
      ([v, t]) =>
        `<span class="row" style="gap:8px;height:32px;padding:0 12px 0 6px;border-radius:8px;background:var(--card);border:1px solid var(--border);font-size:12px"><i style="width:20px;height:20px;border-radius:5px;background:var(${v})"></i>${t}</span>`,
    )
    .join('')}</div></div>`
}

// ---------- Pull-to-refresh ----------
export function ptr(w, h, stage) {
  const off = { pulling: 40, armed: 76, refreshing: 56, done: 0 }[stage]
  const spinner =
    stage === 'refreshing'
      ? `<svg width="26" height="26" viewBox="0 0 24 24" role="progressbar" aria-label="Оновлення"><g stroke="var(--fg)" stroke-width="2.2" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => `<line x1="12" y1="3" x2="12" y2="7" opacity="${0.2 + i * 0.1}" transform="rotate(${i * 45} 12 12)"/>`).join('')}</g></svg>`
      : `<span style="display:inline-block;transform:rotate(${stage === 'armed' ? 180 : 0}deg);color:${stage === 'armed' ? 'var(--primary)' : 'var(--muted-fg)'}">${icon('arrow-down', { size: 22, stroke: 2.2 })}</span>`
  const ind =
    stage === 'done'
      ? ''
      : `<div style="position:absolute;left:0;right:0;top:${50 + off / 2 - 13}px;display:grid;place-items:center;z-index:2">${spinner}</div>`
  const doneNote =
    stage === 'done'
      ? `<div role="status" class="t-cap muted" style="text-align:center;margin-top:-4px;margin-bottom:4px">Оновлено щойно</div>`
      : ''
  const inner = `${topBar()}<div class="content">${largeTitle('Фінанси')}${ind}<div style="transform:translateY(${off}px)">${doneNote}${searchField('Пошук транзакцій')}${chips(['Усі', 'Витрати', 'Доходи', 'Проєкт ▾', 'Період ▾'])}${txnList(TXNS.slice(0, 3))}</div></div>${tabBar('ADMIN', '/finance', { w })}${createDock('ADMIN', '/finance', w)}`
  return phone({ w, h, inner })
}

// ---------- Page transition storyboard ----------
const mini = (inner, cap, { x = 0, op = 1, scale = 1, extra = '' } = {}) =>
  `<div class="col" style="gap:8px;align-items:center"><div style="width:188px;height:406px;border-radius:22px;overflow:hidden;border:1px solid oklch(0.25 0 0);position:relative;background:var(--bg)"><div style="zoom:0.5;width:375px;height:812px;position:relative">${inner(x, op, scale)}${extra}</div></div><div class="t-cap muted" style="text-align:center;max-width:188px">${cap}</div></div>`

const listScr = () =>
  `<div style="position:absolute;inset:0">${phone({ w: 375, h: 812, inner: `${topBar()}<div class="content">${largeTitle('Фінанси')}${txnList(TXNS.slice(0, 5))}</div>${tabBar('ADMIN', '/finance')}` })}</div>`
const detailScr = (x, op) =>
  `<div style="position:absolute;inset:0;transform:translateX(${x}%);opacity:${op};box-shadow:-20px 0 40px oklch(0 0 0 / 0.5)">${phone({ w: 375, h: 812, inner: `${topBar({ back: true, title: '', bell: false, search: false })}<div class="content" style="padding:8px 20px"><div class="t-title">Оренда офісу</div><div class="num" style="font-size:40px;font-weight:700;margin-top:6px">−1 200,00 USD</div><div class="t-foot muted" style="margin-top:4px">Витрата · сьогодні, 14:20</div></div>` })}</div>`
const sheetScr = (y, op) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / ${0.6 * op});z-index:5"></div><div style="position:absolute;left:0;right:0;bottom:0;height:420px;transform:translateY(${y}%);z-index:6;background:var(--popover);border-radius:20px 20px 0 0;border-top:1px solid var(--border)"><div class="grabber"></div><div class="t-head" style="text-align:center;margin-top:16px">Фільтри</div></div>`

export function transitions() {
  const arrow = `<div style="align-self:center;color:var(--muted-fg);margin-top:-30px">${icon('arrow-right', { size: 22 })}</div>`
  const rowOf = (title, spec, cells) =>
    `<div class="col" style="gap:12px;width:100%"><div class="row" style="gap:12px;align-items:baseline"><span class="t-head">${title}</span><span class="t-foot muted">${spec}</span></div><div class="row" style="gap:18px;align-items:flex-start">${cells.join(arrow)}</div></div>`
  const push = (x, cap) => mini((xx) => listScr() + detailScr(xx, 1), cap, { x })
  const tabCell = (active, cap) =>
    mini(
      () =>
        `<div style="position:absolute;inset:0">${phone({ w: 375, h: 812, inner: `${topBar()}<div class="content">${largeTitle(active === '/finance' ? 'Фінанси' : 'Статистика')}${active === '/finance' ? txnList(TXNS.slice(0, 5)) : ''}</div>${tabBar('ADMIN', active)}` })}</div>`,
      cap,
    )
  const sh = (y, op, cap) => mini(() => listScr() + sheetScr(y, op), cap)
  // F0-23: tablet schematics (rail · list · detail / panel), 256 × 180, the same tokens as the frames.
  const box = (inner, cap) =>
    `<div class="col" style="gap:8px;align-items:center"><div class="row" style="width:256px;height:180px;border-radius:14px;overflow:hidden;border:1px solid oklch(0.25 0 0);background:var(--bg);position:relative;align-items:stretch">${inner}</div><div class="t-cap muted" style="text-align:center;max-width:256px">${cap}</div></div>`
  const rail =
    '<div style="width:22px;flex:none;border-right:1px solid var(--border);background:oklch(0.095 0.002 85)"></div>'
  const lines = (n, sel = -1) =>
    Array.from(
      { length: n },
      (_, i) =>
        `<div style="height:14px;margin:6px 8px;border-radius:4px;background:${i === sel ? 'var(--raised)' : 'var(--surface)'};${i === sel ? 'box-shadow:inset 2px 0 0 var(--primary)' : ''}"></div>`,
    ).join('')
  const tab2 = (s) =>
    box(
      `${rail}<div style="width:96px;flex:none;border-right:1px solid var(--border);padding-top:8px">${lines(6, s === 'detail' ? 1 : -1)}</div><div class="grow" style="padding:14px 12px;opacity:${s === 'detail' ? 1 : 0.35}">${s === 'detail' ? '<div style="height:12px;width:60%;border-radius:4px;background:var(--fg)"></div><div style="height:22px;width:80%;margin-top:10px;border-radius:5px;background:var(--surface)"></div>' : '<div class="t-cap muted">Оберіть рядок</div>'}</div>`,
      s === 'detail' ? '150 мс · деталі рядка' : '0 мс · дотик по рядку',
    )
  const tab1 = (s) =>
    box(
      `${rail}<div class="grow" style="position:relative;padding-top:8px">${lines(7)}<div style="position:absolute;inset:0;transform:translateX(${s ? 0 : 100}%);background:var(--bg);box-shadow:-12px 0 24px oklch(0 0 0 / 0.5);padding:14px 12px"><div style="height:12px;width:60%;border-radius:4px;background:var(--fg)"></div></div></div>`,
      s ? '280 мс · деталі на місці списку' : '0 мс',
    )
  const tabPanel = (s) =>
    box(
      `${rail}<div class="grow" style="position:relative;padding-top:8px">${lines(7)}<div style="position:absolute;inset:0 -22px 0 -22px;background:${s ? 'var(--scrim)' : 'transparent'}"></div><div style="position:absolute;top:0;bottom:0;right:0;width:120px;transform:translateX(${s ? 0 : 100}%);background:var(--popover);border-left:1px solid var(--border)"></div></div>`,
      s ? '280 мс · фокус у панелі' : '0 мс',
    )
  // R4-26: the desktop side panel. 1024–1439 modal: the tablet motion over the --scrim. ≥ 1440 non-modal: no
  // scrim; the panel slides in at the right edge and the main column narrows to make room, in the same 280 ms.
  const deskPanel = (s, modal) =>
    box(
      `<div class="grow" style="position:relative;padding-top:8px"><div style="margin-right:${!modal && s ? 120 : 0}px">${lines(7)}</div>${modal ? `<div style="position:absolute;inset:0 -22px 0 -22px;background:${s ? 'var(--scrim)' : 'transparent'}"></div>` : ''}<div style="position:absolute;top:0;bottom:0;right:0;width:120px;transform:translateX(${s ? 0 : 100}%);background:var(--popover);border-left:1px solid var(--border)"></div></div>`,
      s
        ? modal
          ? '280 мс · scrim · фокус у панелі'
          : '280 мс · без scrim · таблиця звужується'
        : '0 мс',
    )
  // R3-11: dialog and popover enter / exit, the same scrim token as every overlay.
  const dlgBox = (s) =>
    box(
      `${rail}<div class="grow" style="position:relative;padding-top:8px">${lines(7)}<div style="position:absolute;inset:0 -22px 0 -22px;background:${s ? 'var(--scrim)' : 'transparent'}"></div><div style="position:absolute;left:50%;top:50%;width:120px;height:64px;transform:translate(-50%,-50%) scale(${s ? 1 : 0.96});opacity:${s ? 1 : 0};border-radius:8px;background:var(--popover);border:1px solid var(--border)"></div></div>`,
      s ? '200 мс · фокус на кнопці відповіді' : '0 мс',
    )
  const popBox = (s) =>
    box(
      `${rail}<div class="grow" style="position:relative;padding-top:8px">${lines(7, 2)}<div style="position:absolute;right:10px;top:${s ? 66 : 70}px;width:90px;height:60px;opacity:${s ? 1 : 0};border-radius:8px;background:var(--popover);border:1px solid var(--border)"></div></div>`,
      s ? '200 мс · фокус на першому пункті' : '0 мс · дотик по «…»',
    )
  return `<div class="board" style="width:900px;gap:28px">
  <h2>Переходи між сторінками · мобільні</h2>
  ${rowOf('Push: список → деталі', 'View Transitions · 280 мс · cubic-bezier(0.2, 0, 0, 1) · попередній екран зсувається на −30%', [push(100, '0 мс'), push(45, '140 мс'), push(0, '280 мс · фокус на заголовок')])}
  ${rowOf('Назад: кнопка або свайп від краю', 'та сама крива у зворотний бік · 240 мс · свайп керує прогресом, відпускання — пружина', [push(0, 'палець біля лівого краю'), push(55, 'жест 55% · напівпрозорий список'), push(100, 'відпущено → повернення')])}
  ${rowOf('Вкладки', 'без анімації: миттєве перемикання, позиція прокрутки кожної вкладки зберігається', [tabCell('/finance', 'Фінанси'), tabCell('/stats', 'Статистика · 0 мс')])}
  ${rowOf('Аркуш', 'scrim 0→60% 200 мс + translateY 100%→0 280 мс · закриття 150 мс · drag-to-dismiss — m.* spring', [sh(100, 0, '0 мс'), sh(35, 0.6, '160 мс'), sh(0, 1, '280 мс · фокус у аркуші')])}
  <h2>Планшет (640–1023)</h2>
  ${rowOf('Дві панелі: вибір рядка', '≥ 900 · деталі — crossfade 150 мс, список і рейка нерухомі · фокус на заголовок деталей', [tab2('list'), tab2('detail')])}
  ${rowOf('Одна панель: список → деталі', '640–899 · той самий push, що на телефоні (280 мс); рейка нерухома', [tab1(0), tab1(1)])}
  ${rowOf('Бічна панель', 'translateX 100%→0 280 мс + scrim 0→60% (--scrim) 200 мс · закриття 150 мс, як аркуш · рейка під scrim', [tabPanel(0), tabPanel(1)])}
  <h2>Діалог і поповер (усі класи ≥ 640)</h2>
  ${rowOf('Бічна панель на комп’ютері', '1024–1439: як на планшеті, модальна, над --scrim · ≥ 1440: немодальна, без scrim, основна колонка звужується · закриття 150 мс', [deskPanel(1, true), deskPanel(1, false)])}
  ${rowOf('Діалог (alertdialog, «Нові записи»)', 'scrim 0→60% + opacity 0→1, scale 0.96→1 · 200 мс · закриття: opacity 1→0 · 150 мс, scale без змін', [dlgBox(0), dlgBox(1)])}
  ${rowOf('Поповер і меню', 'opacity 0→1 + translateY 4 px→0 від якоря · 200 мс · закриття: opacity · 150 мс, без зсуву', [popBox(0), popBox(1)])}
  <div class="t-foot muted" style="width:100%">prefers-reduced-motion: усі зсуви й масштаб (аркуш, панель, діалог, поповер, push) замінено на crossfade 120 мс; scrim теж лише crossfade; пружини вимкнено. Десктоп: зміна маршруту — crossfade вмісту 150 мс, бічна панель і заголовок нерухомі.</div></div>`
}

/** List footer: the next page loading (3 skeleton rows) and failing (an inline retry; the loaded rows stay). */
export function listFooter(w = 375, { menu = false } = {}) {
  const rows = TXNS.slice(0, 2)
    .map((r) => txnRow(r, { menu }))
    .join('')
  const cap = (t) => `<div class="t-over" style="padding:14px 16px 6px">${t}</div>`
  const loading = `<div class="group">${rows}<div role="status" aria-label="Завантаження ще транзакцій" style="display:contents"><div aria-hidden="true" style="display:contents">${skRow(menu).repeat(3)}</div></div></div>`
  const failed = `<div class="group">${rows}<div class="lrow" role="alert" style="--inset:16px;gap:10px"><span style="color:var(--destructive);display:grid">${icon('circle-alert', { size: 18 })}</span><span class="grow col" style="gap:1px;min-width:0"><span class="t-foot">Не вдалося завантажити ще</span><span class="t-cap muted num">Показано 50 з 312</span></span><span class="btn sm secondary" role="button" style="height:44px;flex:none">Повторити</span></div></div>`
  // R4-27: one 320 rule: under 360 no card inset (full-bleed groups, `.narrow`), as every phone frame at 320.
  return `<div class="${w < 360 ? 'narrow' : ''}" style="width:${w}px;padding:4px 0 16px;background:var(--bg)">${cap('Наступна сторінка · завантаження')}${loading}${cap('Наступна сторінка · помилка')}${failed}</div>`
}

/** Search on a paged list: a client-side filter says what it covered while more pages exist. */
export function searchPaged(w, h) {
  const rows = [
    TXNS.find((r) => r.t === 'Хмарний хостинг'),
    {
      t: 'Хостинг серверів',
      s: 'Витрата · 10.11.2026',
      a: '−45,00 USD',
      time: '09:10',
      ic: 'receipt',
      neg: true,
    },
  ]
  const search = `<div style="padding:4px 16px 10px"><div class="row" role="searchbox" aria-label="Пошук транзакцій" style="gap:8px;height:44px;border-radius:12px;background:var(--surface);padding:0 4px 0 12px;font-size:16px"><span style="color:var(--placeholder);display:grid">${icon('search', { size: 18 })}</span><span class="grow">хостинг</span><span role="button" aria-label="Очистити пошук" style="width:44px;height:44px;display:grid;place-items:center;color:var(--muted-fg)">${icon('x', { size: 18 })}</span></div></div>`
  const covered = `<div class="row" style="gap:12px;padding:12px 16px;justify-content:space-between"><span class="t-foot muted num" style="min-width:0">Шукали серед завантажених, з 9.11</span><span class="btn sm secondary" role="button" style="height:44px;flex:none">Шукати далі</span></div>`
  const body = `${search}<div class="t-over" style="padding:6px 20px 8px">Результати</div><div class="group">${rows.map((r) => txnRow(r)).join('')}</div>${covered}`
  return tabScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', body })
}

export { usd, NET_K }
