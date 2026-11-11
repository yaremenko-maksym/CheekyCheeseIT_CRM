// Primitives v2, mobile part: ResponsiveSheet (mobile), ListRow, section header, FormField, keyboard-open.
import { icon, phone, safeBottom, field, segmented } from './base.mjs'
import { moneyForm, primaryBtn } from './money-form.mjs'
export { field, segmented }
import { tabScreen, financeBody, txnRow, TXNS, topBar, PEOPLE } from './mobile.mjs'
import { sheet, closeBtn, safeTop } from './mobile-overlays.mjs'

const chevDown = `<span class="muted">${icon('chevron-down', { size: 18 })}</span>`

export const toggle = (on = true, label = '') =>
  `<span role="switch" aria-checked="${on}" aria-label="${label}" style="width:51px;height:31px;border-radius:16px;flex:none;position:relative;background:${on ? 'var(--primary)' : 'oklch(0.32 0 0)'}"><i style="position:absolute;top:2px;${on ? 'right' : 'left'}:2px;width:27px;height:27px;border-radius:14px;background:${on ? 'var(--primary-fg)' : 'oklch(0.92 0 0)'}"></i></span>`

// Pushed-page form: back + title, the primary in the same bottom bar as the money form.
const stickyFooter = (w, label = 'Зберегти') =>
  `<div style="position:absolute;left:0;right:0;bottom:0;padding:8px 16px ${safeBottom(w) + 8}px;background:var(--popover);border-top:1px solid var(--border)">${primaryBtn(label)}</div>`

function formPage(w, h, title, fields, { footer = '', overlay = '' } = {}) {
  const inner = `${topBar({ back: true, title, bell: false, search: false })}
  <div class="content col" style="gap:18px;padding:12px 16px 0">${fields}</div>${footer}`
  return phone({ w, h, inner, overlay })
}

export function formStates(w, h) {
  const f = [
    field({ id: 'a', label: 'Ім’я та прізвище', ph: 'Наприклад, Ірина Мельник' }),
    field({
      id: 'b',
      label: 'Email',
      value: 'iryna.m',
      state: 'focus',
      hint: 'На цю адресу прийде запрошення',
    }),
    field({ id: 'c', label: 'Телефон', value: '+380 67 000 00 00' }),
    field({
      id: 'd',
      label: 'Робочий email',
      value: 'iryna@',
      state: 'error',
      err: 'Вкажіть email у форматі name@domain.com',
    }),
    field({
      id: 'e',
      label: 'Роль',
      value: 'Junior',
      state: 'disabled',
      suffix: chevDown,
      hint: 'Роль змінює адміністратор',
    }),
  ].join('')
  return formPage(w, h, 'Новий користувач', f, {
    footer: stickyFooter(w, 'Надіслати запрошення'),
  })
}

/** Pushed-screen variant of the canonical money form: no keyboard, optional fields expanded, empty receipt. */
export const formMoney = (w, h) =>
  moneyForm({ w, h, variant: 'page', receipt: 'empty', expanded: true })

/** Keyboard open: the focused field scrolls above the keyboard; the bottom bar rides on top of it. */
export const formKeyboard = (w, h) =>
  moneyForm({ w, h, receipt: 'done', expanded: true, focus: 'note', keyboard: 'text', scroll: 250 })

// ---------- ResponsiveSheet (mobile) ----------
export function sheetMedium(w, h) {
  const row = (k, v) =>
    `<div class="lrow"><div class="grow t-body">${k}</div><span class="muted t-sub trunc" style="max-width:55%">${v}</span>${icon('chevron-right', { size: 18, cls: 'chev' })}</div>`
  const body = `<div style="padding:4px 16px 14px">${segmented(['Усі', 'Витрати', 'Доходи'])}</div>
  <div class="group">${row('Проєкт', 'Усі проєкти')}${row('Період', 'Цей місяць')}${row('Чек', 'Будь-який')}</div>`
  const footer = `<div style="padding:12px 16px ${safeBottom(w) + 8}px"><span class="btn primary" style="width:100%">Показати 48</span></div>`
  const top = Math.round(h * (w <= 320 ? 0.36 : 0.46))
  const overlay = sheet({
    w,
    h,
    top,
    title: 'Фільтри',
    lead: '<span style="font-size:17px">Скинути</span>',
    trail: closeBtn,
    body,
    footer,
  })
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

/** Large sheet = the canonical form in edit mode: «Скасувати» left, title centred, primary in the bottom bar. */
export const sheetLarge = (w, h) =>
  moneyForm({
    w,
    h,
    title: 'Редагувати',
    receipt: 'done',
    expanded: true,
    footer: primaryBtn('Зберегти зміни'),
  })

/** Irreversible action → confirm (never undo). Mobile = action sheet; ≥ 640 = centred dialog. */
export function sheetConfirm(w, h) {
  const overlay = `<div class="scrim"></div><div role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-d" style="position:absolute;left:8px;right:8px;bottom:${safeBottom(w) + 8}px;z-index:75;display:grid;gap:8px">
  <div style="background:var(--popover);border-radius:14px;border:1px solid var(--border);overflow:hidden;text-align:center">
    <div style="padding:16px 20px 14px"><div id="cf-t" class="t-sub" style="font-weight:600">Видалити транзакцію «Оренда офісу»?</div><div id="cf-d" class="t-foot muted" style="margin-top:4px">−1 200,00 $ · 11.11.2026. Цю дію не можна скасувати.</div></div>
    <div style="height:56px;display:grid;place-items:center;border-top:1px solid var(--separator);color:var(--destructive);font-size:17px;font-weight:600">Видалити</div></div>
  <div style="height:56px;display:grid;place-items:center;background:var(--popover);border-radius:14px;border:1px solid var(--border);font-size:17px;font-weight:600">Скасувати</div></div>`
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

// ---------- ListRow + section header ----------
const navRow = (ic, label, { value = '', badge = 0, danger = false } = {}) =>
  `<div class="lrow" style="--inset:60px"><div class="lead" style="width:32px;height:32px;border-radius:9px;${danger ? 'color:var(--destructive)' : ''}">${icon(ic, { size: 18 })}</div><div class="grow t-body trunc" style="${danger ? 'color:var(--destructive)' : ''}">${label}</div>${value ? `<span class="muted t-sub">${value}</span>` : ''}${badge ? `<span class="pill y num" style="font-weight:700">${badge}</span>` : ''}${danger ? '' : icon('chevron-right', { size: 18, cls: 'chev' })}</div>`

const sec = (t, action = '') =>
  `<div class="sechead"><span class="t-over">${t}</span>${action ? `<span style="font-size:15px;color:var(--primary);font-weight:500;min-height:44px;display:flex;align-items:flex-end;padding-bottom:0">${action}</span>` : ''}</div>`

export function listVariants(w, h) {
  const [ini, n, sub, st] = PEOPLE[3]
  const inner = `${topBar({ title: 'ListRow', bell: false, search: false })}<div class="content">
  ${sec('Навігація · 56')}<div class="group">${navRow('dollar-sign', 'Фінанси')}${navRow('clock', 'Чекають рішення', { badge: 3 })}${navRow('languages', 'Мова', { value: 'Українська' })}</div>
  ${sec('Дворядковий · 64', 'Усі')}<div class="group">${txnRow(TXNS[0])}${txnRow(TXNS[1])}</div>
  ${sec('Аватар і статус')}<div class="group"><div class="lrow two" style="--inset:64px"><div class="lead av">${ini}</div><div class="grow col" style="gap:2px"><div class="t-body trunc" style="font-weight:500">${n}</div><div class="t-foot muted trunc">${sub}</div></div><span class="pill ok">${st}</span></div></div>
  ${sec('Перемикач і небезпечна дія')}<div class="group"><div class="lrow" style="--inset:60px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon('bell', { size: 18 })}</div><div class="grow t-body">Сповіщення</div>${toggle(true, 'Сповіщення')}</div>${navRow('log-out', 'Вийти', { danger: true })}</div></div>`
  return phone({ w, h, inner })
}

// Visible «…» on every row with swipe / long-press actions; rows set -webkit-touch-callout: none.
const withMore = (row) =>
  row.replace(
    /<\/div>$/,
    `<span class="iconbtn" role="button" aria-label="Дії з транзакцією" aria-haspopup="menu" style="margin-right:-10px;color:var(--muted-fg)">${icon('ellipsis', { size: 20 })}</span></div>`,
  )

/** Swipe reveals trailing actions; every action is also reachable from the row's ⋯ / long-press menu (WCAG 2.5.1). */
export function listSwipe(w, h) {
  const swiped = `<div class="lrow two" style="padding:0;overflow:hidden"><div class="row" style="position:absolute;right:0;top:0;bottom:0">
    <div class="col" style="width:76px;height:100%;background:oklch(0.42 0.02 250);justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('pencil', { size: 18 })}Змінити</div>
    <div class="col" style="width:76px;height:100%;background:var(--destructive);color:#fff;justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('trash-2', { size: 18 })}Видалити</div></div>
    <div style="width:100%;transform:translateX(-152px);background:var(--card)">${txnRow(TXNS[2]).replace('class="lrow two"', 'class="lrow two" style="background:var(--card)"')}</div></div>`
  const menu = `<div role="menu" aria-label="Дії з транзакцією" style="position:absolute;right:16px;top:${safeTop(w) + 44 + 362}px;width:230px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);overflow:hidden">
    ${[
      ['eye', 'Відкрити'],
      ['pencil', 'Змінити'],
      ['copy', 'Дублювати'],
    ]
      .map(
        ([i, t]) =>
          `<div role="menuitem" class="row" style="gap:12px;height:44px;padding:0 14px;border-bottom:1px solid var(--separator);font-size:16px">${icon(i, { size: 18 })}${t}</div>`,
      )
      .join('')}
    <div role="menuitem" class="row" style="gap:12px;height:44px;padding:0 14px;color:var(--destructive);font-size:16px">${icon('trash-2', { size: 18 })}Видалити…</div></div>`
  const inner = `${topBar({ title: 'Свайп і меню', bell: false, search: false })}<div class="content">
  ${sec('Свайп ліворуч')}<div class="group">${txnRow(TXNS[1])}${swiped}${txnRow(TXNS[3])}</div>
  ${sec('Довге натискання або «…»')}<div class="group">${withMore(txnRow(TXNS[4]).replace('class="lrow two"', 'class="lrow two" style="background:var(--raised)"'))}${withMore(txnRow(TXNS[5]))}</div></div>${menu}`
  return phone({ w, h, inner })
}

export function listSticky(w, h) {
  const long = {
    ...TXNS[0],
    t: 'Підписка на інструмент для дизайну інтерфейсів команди',
    s: 'Витрата · Проєкт «Інфраструктура та інструменти»',
    a: '−1 029,00 $',
  }
  const inner = `${topBar({ title: 'Фінанси', bell: false })}<div class="content">
  <div class="sechead sticky" style="box-shadow:0 1px 0 var(--border)"><span class="t-over">Вчора</span><span class="t-cap muted num">−3 186,40 $</span></div>
  <div class="group" style="margin-top:-18px">${txnRow(TXNS[3])}${txnRow(long)}${txnRow(TXNS[4])}${txnRow(TXNS[5])}</div>
  <div class="sechead"><span class="t-over">9 листопада</span><span class="t-cap muted num">+2 870,00 $</span></div><div class="group">${TXNS.slice(
    0,
    4,
  )
    .map((x) => txnRow(x))
    .join('')}</div></div>`
  return phone({ w, h, inner })
}

export function sectionHeaders(w, h) {
  const card = (body) => `<div class="group" style="padding:2px 0 8px">${body}</div>`
  const inner = `${topBar({ title: 'Заголовки секцій', bell: false, search: false })}<div class="content col" style="gap:14px;padding-top:6px">
  ${card(`${sec('Overline · 12/16')}<div class="lrow"><span class="t-foot muted">Групує рядки списку. Колір muted, не жовтий.</span></div>`)}
  ${card(`${sec('З дією', 'Усі')}<div class="lrow"><span class="t-foot muted">Дія 15 px, ціль ≥ 44 px по висоті.</span></div>`)}
  ${card(`<div class="sechead"><span class="t-over">З підсумком</span><span class="t-cap muted num">−3 186,40 $</span></div><div class="lrow"><span class="t-foot muted">Підсумок дня — tabular-nums.</span></div>`)}
  ${card(`<div class="sechead" style="padding-top:16px"><span class="t-title">Цей місяць</span><span class="btn sm secondary">${icon('calendar', { size: 14 })}Листопад</span></div><div class="lrow"><span class="t-foot muted">Заголовок блоку дашборда 20/26.</span></div>`)}
  ${card(`<div class="sechead sticky" style="margin:0"><span class="t-over">Липкий · blur</span></div><div class="lrow"><span class="t-foot muted">Липне під верхньою панеллю, фон 92% + blur.</span></div>`)}</div>`
  return phone({ w, h, inner })
}
