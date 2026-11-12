// Mobile overlays: More sheet, quick-add, first transaction step (keyboard open), shell states.
import { icon, phone, safeBottom } from './base.mjs'
import { DEST, GROUPS, ACTIONS, QUICK_ADD, ROLE_LABEL, moreItems } from './nav.mjs'
import {
  tabScreen,
  financeBody,
  peopleList,
  largeTitle,
  topBar,
  tabBar,
  TABBAR_H,
} from './mobile.mjs'

const safeTop = (w) => (w <= 320 ? 20 : 54)

function sheet({ w, h, top, title, lead = '', trail = '', body, footer = '' }) {
  return `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${title}" style="top:${top}px">
  <div class="grabber" aria-hidden="true"></div>
  <div class="sheethead"><div class="a">${lead}</div><div class="t">${title}</div><div class="a r">${trail}</div></div>
  <div style="flex:1;min-height:0;overflow:hidden;overscroll-behavior:contain">${body}</div>${footer}</div>`
}

const closeBtn = `<span class="iconbtn" aria-label="Закрити" style="width:44px;height:44px;margin-left:auto"><span style="width:30px;height:30px;border-radius:15px;background:var(--secondary);display:grid;place-items:center;color:var(--muted-fg)">${icon('x', { size: 16, stroke: 2.4 })}</span></span>`

function navRow(d, { badge = 0 } = {}) {
  return `<div class="lrow" style="--inset:60px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon(DEST[d].icon, { size: 18 })}</div>
  <div class="grow t-body trunc">${DEST[d].label}</div>${badge ? `<span class="pill y num" style="font-weight:700">${badge}</span>` : ''}${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
}

export function moreSheet(role, w, h) {
  const items = moreItems(role)
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((d) => items.includes(d)),
  })).filter((g) => g.items.length)
  const user = `<div class="group" style="margin-top:4px"><div class="lrow two"><div class="lead av" style="width:44px;height:44px;border-radius:22px;font-size:15px">ВК</div>
    <div class="grow col" style="gap:2px"><div class="t-head trunc">Віктор Кравець</div><div class="t-foot muted trunc">${DEST['/profile'].label} · ${ROLE_LABEL[role]}</div></div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div></div>`
  const body = `${user}${groups
    .map(
      (g) =>
        `<div class="sechead" style="padding-top:18px"><span class="t-over">${g.title}</span></div><div class="group">${g.items.map((d) => navRow(d, { badge: d === '/pending' ? 3 : 0 })).join('')}</div>`,
    )
    .join(
      '',
    )}<div class="group" style="margin-top:24px"><div class="lrow"><div class="lead" style="width:32px;height:32px;border-radius:9px;color:var(--destructive)">${icon('log-out', { size: 18 })}</div><div class="grow t-body" style="color:var(--destructive)">Вийти</div></div></div>`
  const overlay = sheet({ w, h, top: safeTop(w) + 10, title: 'Ще', trail: closeBtn, body })
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
      <div class="grow col" style="gap:2px"><div class="t-body" style="font-weight:600">${x.label}</div><div class="t-foot muted trunc">${x.sub}</div></div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
    })
    .join('')
export function quickAddSheet(role, w, h) {
  const acts = QUICK_ADD[role]
  const rows = quickAddRows(role)
  const listH = 52 + acts.length * 64 + 40 + safeBottom(w) + 16
  const body = `<div class="group">${rows}</div>`
  const overlay = sheet({ w, h, top: h - listH, title: 'Створити', trail: closeBtn, body })
  // Context «+»: Фінанси / Користувачі / Співбесіди / Вакансії open their own create directly, so the
  // menu is drawn from a tab that owns no create action (ADMIN → Статистика, HR → Дашборд).
  const active = role === 'HR' ? '/' : '/stats'
  const kpi = (k, v, c = '') =>
    `<div class="lrow"><div class="grow t-body">${k}</div><span class="amount ${c}">${v}</span></div>`
  const content = `<div class="sechead"><span class="t-over">Цей місяць</span></div><div class="group">${kpi('Дохід', '+18 400,00 USD', 'pos')}${kpi('Витрати', '−10 500,00 USD')}${kpi('Чистий прибуток', '+7 900,00 USD', 'pos')}</div>`
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

function skRow() {
  return `<div class="lrow two" style="--inset:64px"><div class="sk" style="width:36px;height:36px;border-radius:10px"></div><div class="grow col" style="gap:8px"><div class="sk" style="height:14px;width:62%"></div><div class="sk" style="height:11px;width:40%"></div></div><div class="col" style="gap:8px;align-items:flex-end"><div class="sk" style="height:14px;width:72px"></div><div class="sk" style="height:10px;width:36px"></div></div></div>`
}
export function skeletonList(n = 4) {
  return `<div class="sechead"><div class="sk" style="height:11px;width:70px"></div></div><div class="group" aria-hidden="true">${skRow().repeat(n)}</div>`
}

export function loadingScreen(role, w, h) {
  const body = `<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${'<div style="padding:4px 16px 10px"><div class="sk" style="height:44px;border-radius:12px"></div></div>'}${skeletonList(3)}${skeletonList(3)}</div>`
  return tabScreen({ w, h, role, active: '/finance', title: 'Фінанси', body })
}

/** Centred empty / error block for a tab root. Only one action; never a decorative illustration. */
export function stateBlock({ ic, tone = 'var(--muted-fg)', title, text, action = '', role = '' }) {
  return `<div ${role ? `role="${role}"` : ''} class="col" style="align-items:center;text-align:center;gap:6px;padding:56px 32px 0">
  <span style="width:52px;height:52px;border-radius:16px;background:var(--surface);border:1px solid var(--border);display:grid;place-items:center;color:${tone}">${icon(ic, { size: 24 })}</span>
  <div class="t-head" style="margin-top:10px">${title}</div><div class="t-foot muted" style="max-width:280px">${text}</div>${action ? `<div style="margin-top:14px">${action}</div>` : ''}</div>`
}

export function emptyScreen(w, h) {
  const body = stateBlock({
    ic: 'receipt',
    title: 'Ще немає транзакцій',
    text: 'Тут з’являться доходи, витрати й перекази компанії. Натисніть «+», щоб додати першу.',
  })
  // No in-state button: the «+» stays where it always is, so there is one entry point per screen.
  return tabScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', body })
}

export function errorScreen(w, h) {
  const body = stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити транзакції',
    text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
    action: `<span class="btn secondary">${icon('rotate-cw', { size: 18 })}Спробувати ще</span>`,
  })
  return tabScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', body })
}

export function offlineBanner() {
  return `<div role="status" class="row" style="gap:8px;margin:0 12px 4px;padding:8px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px">
  <span style="color:var(--warning)">${icon('wifi-off', { size: 16 })}</span><span class="grow">Немає з’єднання. Показано останні завантажені дані; збереження не пройде, введене залишиться у формі.</span></div>`
}

/** After «Не зараз» on the session alert: persistent, in the offline-banner slot; background requests pause. */
export function sessionBanner() {
  return `<div role="status" class="row" style="gap:8px;margin:0 12px 4px;padding:0 4px 0 12px;min-height:44px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px">
  <span style="color:var(--warning);display:grid">${icon('lock', { size: 16 })}</span><span class="grow">Сесія завершилася</span><a href="#" role="button" style="display:grid;place-items:center;min-height:44px;padding:0 10px;font-weight:600;color:var(--primary);text-decoration:none">Увійти знову</a></div>`
}

export function impersonationBanner() {
  return `<div role="status" style="margin:0 12px 4px;padding:8px 12px;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);font-size:14px;line-height:18px">
  <div class="row" style="gap:8px;color:var(--primary)">${icon('triangle-alert', { size: 16 })}<span class="grow">Ви увійшли як <b>«Оксана Бойко»</b> (HR)</span></div>
  <div class="row" role="button" style="gap:6px;height:44px;color:var(--fg);font-weight:600;padding-left:24px">${icon('undo-2', { size: 15 })}Повернутися до свого профілю</div></div>`
}

export { safeTop, sheet, closeBtn, skRow, topBar, tabBar, largeTitle, TABBAR_H, phone }
