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

export function quickAddSheet(role, w, h) {
  const acts = QUICK_ADD[role]
  const rows = acts
    .map((a, i) => {
      const x = ACTIONS[a]
      const hero = i === 0
      return `<div class="lrow two" style="--inset:68px"><div class="lead" style="width:40px;height:40px;border-radius:12px;${hero ? 'background:var(--yellow-subtle);color:var(--primary)' : ''}">${icon(x.icon, { size: 20 })}</div>
      <div class="grow col" style="gap:2px"><div class="t-body" style="font-weight:600">${x.label}</div><div class="t-foot muted trunc">${x.sub}</div></div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
    })
    .join('')
  const listH = 52 + acts.length * 64 + 40 + safeBottom(w) + 16
  const body = `<div class="group">${rows}</div>`
  const overlay = sheet({ w, h, top: h - listH, title: 'Створити', trail: closeBtn, body })
  const active = role === 'HR' ? '/interviews' : '/finance'
  const content = role === 'HR' ? peopleList() : financeBody()
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

function decimalPad() {
  const k = (t, alt = '') => `<div class="k ${alt}">${t}</div>`
  const bar = `<div class="kbar" style="background:oklch(0.24 0 0);margin:-8px -6px 0"><span class="row" style="gap:18px;color:var(--muted-fg)">${icon('chevron-up', { size: 22 })}${icon('chevron-down', { size: 22 })}</span><span style="color:var(--primary);font-weight:600">Готово</span></div>`
  return `<div class="kbd" aria-hidden="true">${bar}
  <div class="krow">${k('1')}${k('2')}${k('3')}</div><div class="krow">${k('4')}${k('5')}${k('6')}</div>
  <div class="krow">${k('7')}${k('8')}${k('9')}</div><div class="krow">${k(',', 'alt')}${k('0')}${k(icon('delete', { size: 22 }), 'alt')}</div><div style="height:30px"></div></div>`
}

/** Quick-add → «Нова транзакція», step 1: receipt + amount focused, decimal keyboard open (illustrative; Wave 1 owns the form). */
export function txnQuickStep(w, h) {
  const kbdH = 44 + 4 * 46 + 4 * 8 + 30 + 8
  const receipt = `<div style="padding:0 16px"><div class="row" style="gap:12px;padding:10px;border-radius:14px;background:var(--card);border:1px solid var(--border)">
    <div style="position:relative;width:52px;height:52px;border-radius:10px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;overflow:hidden">
      <div style="position:absolute;inset:8px 10px;display:grid;gap:4px">${'<i style="height:3px;background:oklch(0.45 0 0);border-radius:2px"></i>'.repeat(5)}</div>
      <div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.45);display:grid;place-items:center">
        <svg width="28" height="28" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.25)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="35.8" transform="rotate(-90 18 18)"/></svg></div></div>
    <div class="grow col" style="gap:2px"><div class="t-sub" style="font-weight:600">Чек додано</div><div class="t-foot muted num" id="rcpt-st" role="status">Завантажується · 62% · збереження чекає</div></div>
    <span class="btn sm secondary">Замінити</span></div></div>`
  const amount = `<div style="padding:22px 16px 6px;text-align:center"><div class="t-foot muted">Сума</div>
    <div class="num" style="font-size:44px;line-height:52px;font-weight:700;letter-spacing:-0.03em;margin-top:2px">1 250,5<span class="caret" style="height:40px"></span></div>
    <div class="row" style="justify-content:center;gap:8px;margin-top:10px"><span class="pill" style="height:32px;padding:0 12px;font-size:14px">USD ${icon('chevron-down', { size: 14 })}</span>
    <span class="row" style="height:32px;border-radius:16px;background:var(--surface);border:1px solid var(--border);padding:2px">
      <span style="height:26px;padding:0 12px;border-radius:13px;background:var(--fg);color:var(--bg);font-size:14px;font-weight:600;display:grid;place-items:center">Витрата</span>
      <span style="height:26px;padding:0 12px;font-size:14px;display:grid;place-items:center">Дохід</span>
      <span style="height:26px;padding:0 12px;font-size:14px;display:grid;place-items:center">Переказ</span></span></div></div>`
  const more = `<div style="padding:8px 16px 0"><div class="row" style="justify-content:center;gap:6px;color:var(--muted-fg);font-size:14px;height:44px">${icon('chevron-down', { size: 16 })}Проєкт, опис, дата — необов’язково</div></div>`
  const footer = `<div style="position:absolute;left:0;right:0;bottom:${kbdH}px;padding:8px 16px;background:var(--popover);border-top:1px solid var(--border)"><span class="btn primary" role="button" aria-disabled="true" aria-describedby="rcpt-st" style="width:100%;position:relative;overflow:hidden;background:oklch(0.84 0.183 85.3 / 0.12);color:var(--fg);box-shadow:inset 0 0 0 1px oklch(0.84 0.183 85.3 / 0.4)"><i aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:62%;background:oklch(0.84 0.183 85.3 / 0.24)"></i><span class="num" style="position:relative">Зберегти · чек 62%</span></span></div>`
  const body = `${receipt}${amount}${more}`
  const overlay = `${sheet({ w, h, top: safeTop(w) + 10, title: 'Нова транзакція', lead: '<span style="font-size:17px">Скасувати</span>', body, footer })}${decimalPad()}`
  return tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: financeBody(),
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
  const body = `<div role="status" aria-label="Завантаження транзакцій" style="display:contents">${'<div style="padding:4px 16px 10px"><div class="sk" style="height:40px;border-radius:12px"></div></div>'}${skeletonList(3)}${skeletonList(3)}</div>`
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
  <span style="color:var(--warning)">${icon('wifi-off', { size: 16 })}</span><span class="grow">Немає з’єднання. Показано останні завантажені дані; збереження недоступне.</span></div>`
}

export function impersonationBanner() {
  return `<div role="status" style="margin:0 12px 4px;padding:8px 12px;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85);font-size:14px;line-height:18px">
  <div class="row" style="gap:8px;color:var(--primary)">${icon('triangle-alert', { size: 16 })}<span class="grow">Ви увійшли як <b>«Оксана Бойко»</b> (HR)</span></div>
  <div class="row" style="gap:6px;height:36px;color:var(--fg);font-weight:600;padding-left:24px">${icon('undo-2', { size: 15 })}Повернутися до свого профілю</div></div>`
}

export { safeTop, sheet, closeBtn, decimalPad, skRow, topBar, tabBar, largeTitle, TABBAR_H, phone }
