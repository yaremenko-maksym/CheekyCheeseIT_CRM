// Mobile overlays: More sheet, quick-add, first transaction step (keyboard open), shell states.
import { icon, phone, safeBottom } from './base.mjs'
import { DEST, GROUPS, ACTIONS, QUICK_ADD, ROLE_LABEL, moreItems, whoOf } from './nav.mjs'
import {
  tabScreen,
  financeBody,
  searchField,
  chips,
  peopleList,
  largeTitle,
  topBar,
  tabBar,
  TABBAR_H,
} from './mobile.mjs'

const safeTop = (w) => (w <= 320 ? 20 : 54)

function sheet({ w, h, top, title, lead = '', trail = '', body, footer = '', scroll = '' }) {
  return `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${title}" style="${top == null ? 'max-height:calc(100% - 62px)' : `top:${top}px`}">
  <div class="grabber" aria-hidden="true"></div>
  <div class="sheethead"><div class="a">${lead}</div><div class="t">${title}</div><div class="a r">${trail}</div></div>
  <div ${scroll} style="flex:1;min-height:0;overflow:${scroll ? 'hidden auto' : 'hidden'};${scroll ? `scroll-padding-bottom:16px;${footer ? '' : `margin-bottom:${safeBottom(w)}px;`}` : ''}overscroll-behavior:contain">${body}</div>${footer}</div>`
}
// R4-01: a drawn «scrolled to the end» state; render and measure both run it before they look.
const SCROLL_END = `<script>document.querySelectorAll('[data-scroll-end]').forEach((e) => (e.scrollTop = e.scrollHeight))</script>`

const closeBtn = `<span class="iconbtn" aria-label="Закрити" style="width:44px;height:44px;margin-left:auto"><span style="width:30px;height:30px;border-radius:15px;background:var(--secondary);display:grid;place-items:center;color:var(--muted-fg)">${icon('x', { size: 16, stroke: 2.4 })}</span></span>`

function navRow(d, { badge = 0 } = {}) {
  return `<div class="lrow" data-dest="${d}" style="--inset:60px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon(DEST[d].icon, { size: 18 })}</div>
  <div class="grow t-body trunc">${DEST[d].label}</div>${badge ? `<span class="pill y num" style="font-weight:700">${badge}</span>` : ''}${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
}

// R4-01: the body is its own vertical scroller, so every permitted destination and «Вийти з акаунта» reach the
// thumb at 320 × 568; measure.mjs `reach` asserts it per frame. R5-03: the scrollport ends above the bottom safe
// area (the sheet background continues below it), so no row is ever painted under the home indicator.
export function moreSheet(role, w, h, { end = false } = {}) {
  const items = moreItems(role)
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((d) => items.includes(d)),
  })).filter((g) => g.items.length)
  const user = `<div class="group" style="margin-top:4px"><div class="lrow two"><div class="lead av" style="width:44px;height:44px;border-radius:22px;font-size:15px">${whoOf(role).ini}</div>
    <div class="grow col" style="gap:2px"><div class="t-head trunc">${whoOf(role).name}</div><div class="t-foot muted" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere">${DEST['/profile'].label} · ${ROLE_LABEL[role]}</div></div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div></div>`
  const body = `${user}${groups
    .map(
      (g) =>
        `<div class="sechead" style="padding-top:18px"><span class="t-over">${g.title}</span></div><div class="group">${g.items.map((d) => navRow(d, { badge: d === '/pending' ? 3 : 0 })).join('')}</div>`,
    )
    .join(
      '',
    )}<div class="group" style="margin:24px 0 16px"><div class="lrow" data-dest="sign-out"><div class="lead" style="width:32px;height:32px;border-radius:9px;color:var(--destructive)">${icon('log-out', { size: 18 })}</div><div class="grow t-body" style="color:var(--destructive)">Вийти з акаунта</div></div></div>`
  const want = items.length + 1 // every permitted destination (moreItems) + sign-out, not what the groups kept
  const overlay =
    sheet({
      w,
      h,
      top: safeTop(w) + 10,
      title: 'Ще',
      trail: closeBtn,
      body,
      scroll: `data-reach="${want}"${end ? ' data-scroll-end' : ''}`,
    }) + (end ? SCROLL_END : '')
  return tabScreen({
    w,
    h,
    role,
    active: 'more',
    title: 'Фінанси',
    body: financeBody(),
    overlay,
    showFab: false,
  })
}

/** The role's quick-add rows (icon, label, one-line hint); the drafts sheet reuses them. */
export const quickAddRows = (role) =>
  QUICK_ADD[role]
    .map((a, i) => {
      const x = ACTIONS[a]
      const hero = i === 0
      return `<div class="lrow two" style="--inset:68px"><div class="lead" style="width:40px;height:40px;border-radius:12px;${hero ? 'background:var(--yellow-subtle);color:var(--primary)' : ''}">${icon(x.icon, { size: 20 })}</div>
      <div class="grow col" style="gap:2px"><div class="t-body" style="font-weight:600">${x.label}</div><div class="t-foot muted" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere">${x.sub}</div></div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
    })
    .join('')
export function quickAddSheet(role, w, h) {
  const acts = QUICK_ADD[role]
  const rows = quickAddRows(role)
  const listH = 52 + acts.length * 64 + 40 + safeBottom(w) + 16
  const body = `<div class="group" style="margin-bottom:16px">${rows}</div>`
  // R5-02: one sheet shape — the body scrolls if it ever outgrows the viewport, the scrollport ends above the safe area.
  const overlay = sheet({
    w,
    h,
    top: Math.max(h - listH, safeTop(w) + 10),
    title: 'Створити',
    trail: closeBtn,
    body,
    scroll: 'data-scroll-body',
  })
  // Context «+»: Фінанси / Користувачі / Співбесіди / Вакансії open their own create directly, so the
  // menu is drawn from a tab that owns no create action (ADMIN → Статистика, HR → Дашборд).
  const active = role === 'HR' ? '/' : '/stats'
  const kpi = (k, v, c = '') =>
    `<div class="lrow"><div class="grow t-body">${k}</div><span class="amount ${c}">${v}</span></div>`
  const hub = (k, v) =>
    `<div class="lrow"><div class="grow t-body">${k}</div><span class="num t-body" style="font-weight:600">${v}</span></div>`
  // HR's `/` is the recruiting hub (route-access.ts: HR is not in /stats); company money is ADMIN + ACCOUNTANT.
  const hrContent = `<div class="sechead"><span class="t-over">Цього тижня</span></div><div class="group">${hub('Співбесіди', '5')}${hub('Відкриті вакансії', '3')}${hub('Нові у черзі зовнішніх вакансій', '7')}</div>`
  const content =
    role === 'HR'
      ? hrContent
      : `<div class="sechead"><span class="t-over">Цей місяць</span></div><div class="group">${kpi('Дохід', '+18 400,00 USD', 'pos')}${kpi('Витрати', '−10 500,00 USD')}${kpi('Чистий прибуток', '+7 900,00 USD', 'pos')}</div>`
  return tabScreen({
    w,
    h,
    role,
    active,
    title: DEST[active].label,
    body: content,
    overlay,
    showFab: false,
  })
}

// R3-25: `value` draws the trailing amount blocks; a row without a value (a notification) draws none.
// R4-17: slots follow the loaded row anatomy (§12.0): title + meta on the left, ONE trailing value (the amount
// alone, no second line), the «…» slot only where the loaded row has one (touch).
function skRow(menu = false, value = true) {
  return `<div class="lrow two" style="--inset:64px"><div class="sk" style="width:36px;height:36px;border-radius:10px"></div><div class="grow col" style="gap:8px"><div class="sk" style="height:14px;width:62%"></div><div class="sk" style="height:11px;width:40%"></div></div>${value ? '<div class="sk" style="height:14px;width:72px;flex:none;align-self:flex-start;margin-top:3px"></div>' : ''}${menu ? '<div class="sk" aria-hidden="true" style="width:24px;height:24px;border-radius:12px;flex:none;margin-right:10px"></div>' : ''}</div>`
}
export function skeletonList(n = 4) {
  return `<div class="sechead"><div class="sk" style="height:11px;width:70px"></div></div><div class="group" aria-hidden="true">${skRow().repeat(n)}</div>`
}

/** The real toolbar (search + chips) every Фінанси state keeps; a read-only role has no Витрати/Доходи split. */
export const financeToolbar = (role = '') =>
  `${searchField('Пошук транзакцій')}${chips(role === 'JUNIOR' ? ['Усі', 'Період ▾'] : ['Усі', 'Витрати', 'Доходи', 'Проєкт ▾', 'Період ▾'])}`

export function loadingScreen(role, w, h) {
  // F0-21: the top bar, search and chips are real from the first paint; only the rows are skeleton, so nothing jumps.
  const body = `${financeToolbar()}<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${skeletonList(3)}${skeletonList(3)}</div>`
  return tabScreen({ w, h, role, active: '/finance', title: 'Фінанси', body })
}

/** Centred empty / error block for a tab root. Only one action; never a decorative illustration. */
export function stateBlock({ ic, tone = 'var(--muted-fg)', title, text, action = '', role = '' }) {
  return `<div ${role ? `role="${role}"` : ''} class="col" style="align-items:center;text-align:center;gap:6px;padding:56px 32px 0">
  <span style="width:52px;height:52px;border-radius:16px;background:var(--surface);border:1px solid var(--border);display:grid;place-items:center;color:${tone}">${icon(ic, { size: 24 })}</span>
  <div class="t-head" style="margin-top:10px">${title}</div>${text ? `<div class="t-foot muted" style="max-width:280px">${text}</div>` : ''}${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`
}

/**
 * F0-31: the next step names the entry point that exists for this role on this class; a role without
 * create gets no instruction at all. `cls`: 'touch' (the «+» FAB) or 'desktop' (header button + C).
 */
export function emptyCopy({ create = true } = {}) {
  // The action sits in the block (create roles); the text never points at a button elsewhere. A read-only role
  // (JUNIOR) sees only its own received payments, so its copy names those, not company money.
  return create
    ? 'Тут з’являться доходи, витрати й перекази компанії.'
    : 'Тут з’являться виплати, які надійшли вам. Щойно вони будуть, ви побачите їх у цьому списку.'
}
export const emptyAction = (cls = 'touch') =>
  `<span class="btn primary" role="button">${icon('plus', { size: 18, stroke: 2.4 })}Нова транзакція${cls === 'desktop' ? '<span class="kbdkey" style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)">C</span>' : ''}</span>`

export function emptyScreen(w, h, { create = true } = {}) {
  const body = `${financeToolbar(create ? undefined : 'JUNIOR')}${stateBlock({
    ic: 'receipt',
    title: create ? 'Ще немає транзакцій' : 'Ще немає виплат',
    text: emptyCopy({ create }),
    // D-8: on a phone the docked button is the one create entry, so the empty block carries none.
    action: '',
  })}`
  return tabScreen({
    w,
    h,
    // JUNIOR sees Фінанси and has no create action (nav.mjs QUICK_ADD), so it has no «+» at all.
    role: create ? 'ADMIN' : 'JUNIOR',
    active: '/finance',
    title: 'Фінанси',
    body,
  })
}

export function errorScreen(w, h) {
  const body = stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити транзакції',
    text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
    action: `<span class="btn secondary">${icon('rotate-cw', { size: 18 })}Повторити</span>`,
  })
  // The real toolbar stays (search, filters): the error replaces only the rows (R1-06).
  return tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: `${financeToolbar()}${body}`,
  })
}

export function offlineBanner() {
  return `<div role="status" class="row" style="gap:8px;margin:0 12px 4px;padding:8px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px">
  <span style="color:var(--warning)">${icon('wifi-off', { size: 16 })}</span><span class="grow">Немає з’єднання. Показано останні завантажені дані. Зараз зберегти зміни не вдасться. Введені дані залишаться у формі.</span></div>`
}

/** After «Не зараз» on the session alert: persistent, in the offline-banner slot; background requests pause. */
export function sessionBanner() {
  return `<div role="status" class="row" style="gap:8px;margin:0 12px 4px;padding:0 4px 0 12px;min-height:44px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px">
  <span style="color:var(--warning);display:grid">${icon('lock', { size: 16 })}</span><span class="grow">Сесія завершилася</span><a href="#" role="button" style="display:grid;place-items:center;min-height:44px;padding:0 10px;font-weight:600;color:var(--primary);text-decoration:none">Увійти знову</a></div>`
}

export function impersonationBanner({ wide = false } = {}) {
  // R5-32: at >= 640 the one banner anatomy — text left, the action right on the same line.
  if (wide)
    return `<div role="status" class="row" style="margin:0 12px 4px;gap:8px;min-height:44px;padding:0 4px 0 12px;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);font-size:14px;line-height:18px"><span style="color:var(--primary);display:grid">${icon('triangle-alert', { size: 16 })}</span><span class="grow" style="color:var(--primary)">Ви увійшли як <b>«Оксана Бойко»</b> (HR)</span><span class="row" role="button" style="flex:none;gap:6px;height:44px;padding:0 10px;color:var(--fg);font-weight:600">${icon('undo-2', { size: 15 })}Повернутися до свого профілю</span></div>`
  // R4-30: no bottom padding: the 44 px return row already leaves ~13 px under its text (no ~20 px dead band).
  return `<div role="status" style="margin:0 12px 4px;padding:8px 12px 0;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);font-size:14px;line-height:18px">
  <div class="row" style="gap:8px;color:var(--primary)">${icon('triangle-alert', { size: 16 })}<span class="grow">Ви увійшли як <b>«Оксана Бойко»</b> (HR)</span></div>
  <div class="row" role="button" style="gap:6px;height:44px;color:var(--fg);font-weight:600;padding-left:24px">${icon('undo-2', { size: 15 })}Повернутися до свого профілю</div></div>`
}

export { SCROLL_END, safeTop, sheet, closeBtn, skRow, topBar, tabBar, largeTitle, TABBAR_H, phone }
