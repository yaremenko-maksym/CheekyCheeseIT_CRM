// Council r1 frames: the component × class cells r0 found undrawn (F0-08/09/13/14/15/16/17/18/19/24/26/34).
// Invented sample data only; the same tokens and helpers as every other frame.
import { icon, phone, field, safeBottom, segmented } from './base.mjs'
import { tabScreen, financeBody, searchField, chips, peopleList, topBar } from './mobile.mjs'
import {
  sheet,
  closeBtn,
  stateBlock,
  emptyCopy,
  offlineBanner,
  sessionBanner,
  impersonationBanner,
} from './mobile-overlays.mjs'
import { desktop, cmdk } from './desktop.mjs'
import { tablet } from './tablet.mjs'
import { listFooter, netBars, legend } from './prims-viz.mjs'
import { detailTxnBody } from './prims-mobile.mjs'
import { actionConfirm } from './money-form.mjs'

const POP =
  'background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:14px;box-shadow:0 24px 64px oklch(0 0 0 / 0.6)'
const SCRIM = (a = 0.45) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / ${a});z-index:60"></div>`
const bell = (s = 22) =>
  `<span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: s })}<i class="dot"></i></span>`
const paneHead = (t) =>
  `<div class="row" style="height:56px;padding:0 8px 0 16px;flex:none"><div class="grow t-title">${t}</div>${bell()}</div>`
const pane = (label, inner) =>
  `<section aria-label="${label}" class="col" style="width:360px;flex:none;border-right:1px solid var(--border)">${inner}</section>`
// The phone overlay goes before the home bar (a 320 device has none: then last inside the device).
const overHome = (screen, overlay) =>
  screen.includes('<div class="homebar">')
    ? screen.replace('<div class="homebar">', `${overlay}<div class="homebar">`)
    : screen.replace(/<\/div>\s*$/, `${overlay}</div>`)

// ---------- Picker (F0-13): one kind-pill + picker primitive; the container follows width, pointer and count ----------
// ≤ 7 options: a listbox (no search). > 7: a combobox with a search field on top. < 640: always the PickerSheet.
const opt = (label, on, h, { check = false } = {}) =>
  `<div role="option" aria-selected="${on}" class="row" style="gap:10px;height:${h}px;padding:0 12px;margin:0 4px;border-radius:8px;font-size:${h >= 44 ? 16 : 14}px;${on ? 'background:var(--raised)' : ''}">${check ? `<span style="width:16px;height:16px;border-radius:4px;flex:none;display:grid;place-items:center;${on ? 'background:var(--primary);color:var(--primary-fg)' : 'border:1.5px solid var(--input-border)'}">${on ? icon('check', { size: 12, stroke: 3 }) : ''}</span>` : ''}<span class="grow trunc">${label}</span>${on && !check ? `<span style="color:var(--primary)">${icon('check', { size: 16 })}</span>` : ''}</div>`

export function pickerTablet(w, h) {
  const list = ['Усі проєкти', 'Альфа', 'Бета', 'Гамма', 'Дельта', 'Інфраструктура', 'Офіс']
  const pop = `<div role="listbox" aria-label="Проєкт" style="position:absolute;top:164px;left:330px;width:260px;z-index:70;padding:4px 0;${POP}">${list.map((p, i) => opt(p, i === 0, 44)).join('')}</div>`
  return tablet({ w, h, overlay: pop })
}

export function pickerDesktop(w, h) {
  // Query «а»: 8 of 12 projects match; the match is bold, as in the palette.
  const all = [
    'Альфа',
    'Бета',
    'Гамма',
    'Дельта',
    'Зета',
    'Інфраструктура',
    'Маркетинг',
    'Платформа',
  ].map((p) => p.replace(/[аА]/, (m) => `<b>${m}</b>`))
  const pop = `<div role="dialog" aria-label="Фільтр: проєкт" style="position:absolute;top:114px;left:640px;width:300px;z-index:70;${POP};overflow:hidden">
  <div class="row" style="gap:8px;height:44px;padding:0 12px;border-bottom:1px solid var(--border)"><span class="muted">${icon('search', { size: 15 })}</span><span role="combobox" aria-expanded="true" aria-controls="pp" class="grow" style="font-size:14px">а<span class="caret" style="height:16px"></span></span><span class="t-cap muted num">8 з 12</span></div>
  <div id="pp" role="listbox" aria-multiselectable="true" aria-label="Проєкт" style="padding:4px 0;max-height:296px;overflow:hidden">${all.map((p, i) => opt(p, i === 0, 36, { check: true })).join('')}</div>
  <div class="row" style="justify-content:space-between;height:44px;padding:0 8px 0 12px;border-top:1px solid var(--border);font-size:13px"><span class="muted num">Вибрано: 1</span><span class="btn sm ghost">Очистити</span></div></div>`
  // The open, set filter: solid accent outline, value in the label, aria-expanded (a dashed «+» chip is an unset filter).
  return desktop({ w, h, overlay: pop }).replace(
    `border:1px dashed var(--input-border);font-size:13px;color:var(--muted-fg)">${icon('plus', { size: 13 })}Проєкт</span>`,
    `border:1px solid var(--primary);background:var(--yellow-subtle);font-size:13px;color:var(--fg)" role="button" aria-expanded="true" aria-haspopup="dialog">Проєкт: Альфа${icon('chevron-down', { size: 13 })}</span>`,
  )
}

// ---------- Date picker (F0-14): phone sheet · tablet popover · desktop DateField popover ----------
// Листопад 2026 starts on a Sunday: Monday-first grid, 6 leading blanks. 11 = today (ring), 12 = selected.
function cal(c) {
  const head = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
    .map(
      (d) =>
        `<span role="columnheader" class="t-cap muted" style="display:grid;place-items:center;height:${Math.round(c * 0.7)}px">${d}</span>`,
    )
    .join('')
  const cells = [...Array(6).fill(''), ...Array.from({ length: 30 }, (_, i) => i + 1)]
    .map((d) => {
      if (!d) return '<span></span>'
      const sel = d === 12
      const today = d === 11
      return `<span role="gridcell" aria-selected="${sel}" ${today ? 'aria-current="date"' : ''} class="num" style="display:grid;place-items:center;width:${c}px;height:${c}px;border-radius:${c / 2}px;font-size:${c >= 44 ? 16 : 13}px;${sel ? 'background:var(--primary);color:var(--primary-fg);font-weight:700' : today ? 'box-shadow:inset 0 0 0 1.5px var(--input-border);font-weight:600' : ''}">${d}</span>`
    })
    .join('')
  const nav = (ic, l) =>
    `<span class="iconbtn" role="button" aria-label="${l}" style="width:${Math.max(c, 32)}px;height:${Math.max(c, 32)}px">${icon(ic, { size: 18 })}</span>`
  return `<div class="row" style="height:${Math.max(c, 36)}px;gap:4px;margin-bottom:4px"><span class="grow" style="font-size:${c >= 44 ? 17 : 14}px;font-weight:600;padding-left:6px">Листопад 2026</span>${nav('chevron-left', 'Попередній місяць')}${nav('chevron-right', 'Наступний місяць')}</div>
  <div role="grid" aria-label="Листопад 2026" style="display:grid;grid-template-columns:repeat(7,${c}px);row-gap:${c >= 44 ? 2 : 2}px">${head}${cells}</div>`
}

export function datepickerSheet(w, h) {
  const body = `<div style="padding:4px 16px 0;display:grid;justify-content:center">${cal(44)}</div>
  <div class="row" style="justify-content:space-between;gap:12px;padding:12px 16px ${safeBottom(w) + 12}px"><span class="t-foot muted">Вибір дня закриває аркуш</span><span class="btn sm secondary" role="button" style="height:44px">Сьогодні</span></div>`
  const overlay = sheet({ w, h, top: null, title: 'Дата', trail: closeBtn, body })
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

// A short create form in a side panel (Нова співбесіда), «Дата» open. `fine`: 36 px pointer sizes; the inputs stay 48 px / 16 px everywhere.
function formPanel(width, { modal, fine }) {
  const dateField = field({
    label: 'Дата',
    value: '12.11.2026',
    state: 'focus',
    id: 'dt',
    suffix: `<span class="muted" style="display:grid">${icon('calendar', { size: 18 })}</span>`,
    attrs: 'role="combobox" aria-expanded="true" aria-haspopup="dialog"',
  })
  const body = `<div class="col" style="gap:16px;padding:16px 20px">${field({ label: 'Ім’я та прізвище', value: 'Богдан Ткач', id: 'nm' })}${field({ label: 'Етап', value: 'HR-скринінг', suffix: `<span class="muted" style="display:grid">${icon('chevron-down', { size: 18 })}</span>`, id: 'st', tag: 'button' })}${dateField}${field({ label: 'Час', value: '11:00', id: 'tm' })}</div>`
  const btnH = fine ? 36 : 44
  const head = `<div class="row" style="height:56px;padding:0 8px 0 20px;border-bottom:1px solid var(--border);flex:none"><div id="fp-t" class="grow t-head">Нова співбесіда</div><button type="button" class="iconbtn" aria-label="Закрити" style="width:44px;height:44px">${icon('x', { size: 20 })}</button></div>`
  const foot = `<div class="row" style="gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border);margin-top:auto"><span class="btn secondary" style="height:${btnH}px">Скасувати</span><span class="btn primary" style="height:${btnH}px">Зберегти</span></div>`
  const box = `${head}<div class="col grow" style="min-height:0">${body}${foot}</div>`
  return modal
    ? `${SCRIM()}<div role="dialog" aria-modal="true" aria-labelledby="fp-t" class="col" style="position:absolute;top:0;right:0;bottom:0;width:${width}px;z-index:65;background:var(--popover);border-left:1px solid var(--border)">${box}</div>`
    : `<aside aria-labelledby="fp-t" class="col" style="width:${width}px;flex:none;background:var(--card);border-left:1px solid var(--border)">${box}</aside>`
}
// «Дата» input bottom = 56 head + 16 pad + 2 × (20 label + 6 + 48 + 16 gap) + 20 + 6 + 48 = 294.
const datePop = (place, c) =>
  `<div role="dialog" aria-label="Вибір дати" style="position:absolute;${place};z-index:75;padding:10px 10px 8px;${POP}">${cal(c)}<div class="row" style="justify-content:flex-end;margin-top:6px"><span class="btn sm ghost" style="height:${c >= 44 ? 44 : 32}px">Сьогодні</span></div></div>`

export const datepickerTablet = (w, h) =>
  tablet({
    w,
    h,
    active: '/interviews',
    list: hrPane(),
    overlay: `${formPanel(400, { modal: true, fine: false })}${datePop(`top:300px;right:${400 - 20 - 330}px`, 44)}`,
  })

export const datepickerDesktop = (w, h) =>
  peopleDesk({
    w,
    h,
    panel: formPanel(480, { modal: false, fine: true }),
    panelW: 480,
    overlay: datePop(`top:300px;left:${w - 480 + 20}px`, 36),
  })

// ---------- Banner stack (F0-15): impersonation pinned first, then newest first; two shown, the rest folded ----------
const fold = (n, m = '0 12px 4px') =>
  `<button type="button" aria-expanded="false" class="row" style="width:calc(100% - 24px);margin:${m};justify-content:space-between;min-height:44px;padding:0 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font:inherit;font-size:14px;color:var(--fg)"><span class="num">Ще ${n}: сесія завершилася</span><span style="color:var(--primary);font-weight:600">Показати</span></button>`
const stack = () => `${impersonationBanner()}${offlineBanner()}${fold(1)}`
// sessionBanner() is the folded third one; drawn expanded in alert-session-expired-* and state frames.
void sessionBanner

export const bannerStackPhone = (w, h) =>
  tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body: peopleListBody(),
    banner: `<div style="padding-top:4px">${stack()}</div>`,
  })
function peopleListBody() {
  return `${searchField('Пошук співбесід')}${peopleList()}`
}

// The admin is impersonating an HR user, so every class draws HR's own navigation and page.
const hrPane = (banner = '') =>
  pane(
    'Співбесіди',
    `${paneHead('Співбесіди')}${banner}${searchField('Пошук співбесід')}${chips(['Усі', 'HR-скринінг', 'Технічна', 'Офер'])}${peopleList()}`,
  )
export const bannerStackTablet = (w, h) =>
  tablet({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    list: hrPane(`<div style="flex:none">${stack()}</div>`),
  })

// Desktop Співбесіди page: toolbar + the interview list (the screen spec owns its final table).
function peopleDesk({ top = '', ...o }) {
  return desktop({
    ...o,
    active: '/interviews',
    crumb: ['Люди', 'Співбесіди'],
    cta: 'Нова співбесіда',
    content: `${top}${deskToolbar.replace('Пошук транзакцій', 'Пошук співбесід')}<div class="grow" style="min-height:0;overflow:hidden;margin:0 -16px">${peopleList()}</div>`,
  })
}
export const bannerStackDesktop = (w, h) =>
  peopleDesk({ w, h, role: 'HR', top: `<div class="col" style="margin:0 -12px">${stack()}</div>` })

// ---------- System states per class (F0-16) ----------
const errorBlock = () =>
  stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити транзакції',
    text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
    action: `<span class="btn secondary" role="button">${icon('rotate-cw', { size: 18 })}Спробувати ще</span>`,
  })
const emptyBlock = (cls) =>
  stateBlock({ ic: 'receipt', title: 'Ще немає транзакцій', text: emptyCopy({ create: true }) })

// Tablet: the real header, search and chips stay; the state replaces the rows (nothing jumps on recovery).
const tabletState = (w, h, block) =>
  tablet({
    w,
    h,
    list: pane(
      'Транзакції',
      `${paneHead('Фінанси')}${searchField('Пошук транзакцій')}${chips(['Усі', 'Витрати', 'Доходи', 'Проєкт ▾'])}${block}`,
    ),
  })
export const stateEmptyTablet = (w, h) => tabletState(w, h, emptyBlock('touch'))
export const stateErrorTablet = (w, h) => tabletState(w, h, errorBlock())

// Desktop: toolbar stays; the state sits in the table card, centred, never full-page.
const deskToolbar = `<div class="row" style="gap:8px"><span class="row" style="gap:8px;height:32px;width:300px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 14 })}<span class="grow">Пошук транзакцій</span><span class="kbdkey">/</span></span><span class="grow"></span></div>`
const deskState = (w, h, block) =>
  desktop({
    w,
    h,
    content: `${deskToolbar}<div class="grow" style="min-height:0;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card);padding-bottom:56px">${block}</div>`,
  })
export const stateEmptyDesktop = (w, h) => deskState(w, h, emptyBlock('desktop'))
export const stateErrorDesktop = (w, h) => deskState(w, h, errorBlock())

/** Desktop session expiry: a centred alertdialog over the open panel; «Не зараз» has the initial focus. */
export function sessionExpiredDesktop(w, h) {
  const dlg = `${SCRIM(0.55)}<div role="alertdialog" aria-modal="true" aria-labelledby="sx-t" aria-describedby="sx-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;z-index:80;padding:20px 20px 16px;${POP}">
  <div id="sx-t" class="t-head">Сесія завершилася. Увійдіть знову, щоб продовжити.</div>
  <div id="sx-d" class="t-foot muted" style="margin-top:8px;font-size:14px;line-height:20px">Введене у формі «Нова співбесіда» буде втрачено.</div>
  <div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><span class="btn secondary" style="height:36px;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">Не зараз</span><span class="btn primary" style="height:36px">Увійти знову</span></div></div>`
  return peopleDesk({
    w,
    h,
    panel: formPanel(480, { modal: false, fine: true }),
    panelW: 480,
    overlay: dlg,
  })
}

// ---------- Phone 320 (F0-19) ----------
export function formfieldError320(w, h) {
  const inner = `${topBar({ back: true, title: 'Новий користувач', bell: false, search: false })}<div class="content col" style="gap:16px;padding:8px 16px">
  ${field({ label: 'Ім’я та прізвище', value: 'Олена Коваль', id: 'n' })}
  ${field({ label: 'Email', value: 'olena.koval@', state: 'error', err: 'Введіть повну адресу, наприклад name@company.com', id: 'e' })}
  ${field({ label: 'Роль', value: 'HR', id: 'r', tag: 'button', suffix: `<span class="muted" style="display:grid">${icon('chevron-down', { size: 18 })}</span>` })}</div>`
  return phone({ w, h, inner })
}

// ---------- Tablet cells (F0-17) ----------
export function chartTablet(w, h) {
  const card = `<div style="margin:0 16px;padding:14px 16px 10px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><div class="row"><div class="grow"><div class="t-foot muted">Чистий прибуток · 6 міс</div><div class="num" style="font-size:24px;font-weight:700">+25 900,00 USD</div></div>${legend(
    [
      ['var(--chart-1)', 'Прибуток'],
      ['', 'Збиток', 'hatch'],
    ],
  )}</div><div style="margin-top:8px">${netBars(w - 80 - 64, 260, { labelSize: 12, pad: 34 })}</div></div>`
  const list = `<section aria-label="Статистика" class="col grow" style="min-width:0">${paneHead('Статистика')}<div style="padding:0 16px 12px">${segmented(['3 міс', '6 міс', 'Рік'], 1, { fit: true })}</div>${card}</section>`
  return tablet({ w, h, list, active: '/stats' })
}

export function listFooterTablet(w, h) {
  const covered = `<div class="row" style="gap:12px;padding:12px 16px;justify-content:space-between"><span class="t-foot muted num" style="min-width:0">Шукали серед завантажених, з 9.11</span><span class="btn sm secondary" role="button" style="height:44px;flex:none">Шукати далі</span></div>`
  const list = pane(
    'Транзакції',
    `${paneHead('Фінанси')}${searchField('Пошук транзакцій')}<div style="flex:1;min-height:0;overflow:hidden">${listFooter(w - 80).replace(/width:\d+px;/, '')}${covered}</div>`,
  )
  return tablet({ w, h, list })
}

/** Desktop table end: the next page auto-loads at the end; failure keeps the rows and adds an inline retry row. */
export function listFooterDesktop(w, h) {
  const foot = `<div role="alert" class="row" style="position:absolute;left:0;right:0;bottom:0;gap:10px;height:44px;padding:0 12px;border-top:1px solid var(--border);background:var(--card);font-size:14px"><span style="color:var(--destructive);display:grid">${icon('circle-alert', { size: 16 })}</span><span class="grow">Не вдалося завантажити ще. Показано 50 з 312.</span><span class="btn sm secondary" style="height:32px">Повторити</span></div>`
  return desktop({ w, h })
    .replace(
      'style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"',
      'style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card);position:relative;padding-bottom:44px"',
    )
    .replace('</tbody></table>', `</tbody></table>${foot}`)
}

/** ≥ 640 the row menu is an anchored menu beside the row (44 px items); < 640 it is the action sheet. */
export function rowMenuTablet(w, h) {
  const it = (ic, t, ink = '') =>
    `<div role="menuitem" class="row" style="gap:12px;height:44px;padding:0 14px;font-size:16px;${ink ? `color:${ink}` : ''}"><span style="display:grid;${ink ? '' : 'color:var(--muted-fg)'}">${icon(ic, { size: 18 })}</span>${t}</div>`
  const menu = `<div role="menu" aria-label="Дії: Оплата від клієнта" style="position:absolute;top:312px;right:24px;width:240px;z-index:70;padding:4px 0;${POP}">${it('pencil', 'Редагувати')}${it('copy', 'Дублювати')}${it('paperclip', 'Додати чек')}<div style="height:1px;background:var(--border);margin:4px 0"></div>${it('trash-2', 'Видалити', 'var(--destructive)')}</div>`
  return tablet({ w, h, overlay: menu })
}

/** F0-24: the action slot holds only what the role may do; JUNIOR reads the record with no actions at all. */
export function detailReadonlyTablet(w, h) {
  const detail = `<section aria-label="Деталі транзакції" class="grow col" style="background:var(--bg);min-width:0">
  <div class="row" style="height:56px;padding:0 20px;border-bottom:1px solid var(--border);flex:none"><div class="grow t-head">Транзакція</div><span class="t-cap muted">Лише перегляд</span></div>
  <div style="flex:1;min-height:0;overflow:hidden;padding:12px 8px 24px">${detailTxnBody()}</div></section>`
  return tablet({ w, h, role: 'JUNIOR', active: '/finance', detail })
}

/** A non-ADMIN rail: HR's own destinations, its own «+» actions (interview, vacancy). */
export const railHrTablet = (w, h) =>
  tablet({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    list: hrPane(),
  })

/** F0-09: ✕ (or a swipe down) on a dirty short form asks first; a clean form closes at once. */
// A short form in a medium sheet: typed input, so ✕ is a dirty close.
function interviewSheet(w, h) {
  const chev = `<span class="muted" style="display:grid">${icon('chevron-down', { size: 18 })}</span>`
  const body = `<div class="col" style="gap:16px;padding:4px 16px 8px">${field({ label: 'Ім’я та прізвище', value: 'Богдан Ткач', id: 'sn' })}${field({ label: 'Етап', value: 'HR-скринінг', suffix: chev, id: 'ss', tag: 'button' })}${field({ label: 'Дата', value: '12.11.2026', id: 'sd' })}</div>`
  const footer = `<div style="padding:12px 16px ${safeBottom(w) + 8}px"><span class="btn primary" style="width:100%">Зберегти</span></div>`
  return tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body: peopleListBody(),
    overlay: sheet({ w, h, top: null, title: 'Нова співбесіда', trail: closeBtn, body, footer }),
    showFab: false,
  })
}

export const sheetDirtyClose = (w, h) =>
  overHome(
    interviewSheet(w, h),
    actionConfirm(w, {
      id: 'dc',
      title: 'Вийти без збереження?',
      desc: 'Введене в цій формі буде втрачено.',
      action: 'Вийти',
      cancel: 'Залишитися',
      overSheet: true,
      focusCancel: true,
    }),
  )

export const cmdkEmpty = (w, h) => desktop({ w, h, overlay: cmdk({ empty: true }) })
