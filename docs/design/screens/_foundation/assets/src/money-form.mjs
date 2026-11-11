// The canonical mobile money form (council R1, item A): one shape for quick-add, the pushed page,
// keyboard-open, edit and the failure frames. Chrome: «Скасувати» top-left, title centred, the
// primary in a bottom bar above the keyboard / home indicator. Never a top-right «Готово».
// The primary is always enabled (except while its own request is in flight): a tap validates,
// focuses the first invalid field and shows inline errors. Sample data is invented.
import { icon, phone, safeBottom, systemBar, segmented, currencyPill, field } from './base.mjs'
import { tabScreen, financeBody, topBar, txnList, TXNS, TABBAR_H, FLOAT_RIGHT } from './mobile.mjs'
import { sheet, safeTop, closeBtn } from './mobile-overlays.mjs'

export const AMOUNT = '1 250,50'

const thumb = (s = 44) =>
  `<div style="position:relative;width:${s}px;height:${s}px;flex:none;border-radius:10px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;overflow:hidden"><div style="position:absolute;inset:7px 9px;display:grid;gap:4px">${'<i style="height:3px;background:oklch(0.45 0 0);border-radius:2px"></i>'.repeat(4)}</div></div>`

export function ring(pct, size = 28) {
  const c = 2 * Math.PI * 15
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.25)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
}

/** Receipt: empty picker, uploading or uploaded. «Замінити» and «✕ Видалити чек» are both 44 px. */
export function receiptCard(state = 'uploading') {
  if (state === 'empty')
    return `<div class="row" role="button" style="gap:12px;height:68px;padding:0 12px;border-radius:var(--r-lg);border:1.5px dashed var(--input-border)">
    <span style="width:44px;height:44px;border-radius:12px;background:var(--surface);display:grid;place-items:center">${icon('camera', { size: 20 })}</span><span class="grow col" style="gap:2px"><span class="t-sub" style="font-weight:600">Додати чек</span><span class="t-foot muted">Камера, фото або файл · до 10 МБ</span></span></div>`
  const up = state === 'uploading'
  const over = up
    ? `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.45);display:grid;place-items:center">${ring(62)}</div>`
    : ''
  return `<div class="row" style="gap:10px;padding:6px 4px 6px 10px;border-radius:14px;background:var(--card);border:1px solid var(--border)">
    <div style="position:relative;width:44px;height:44px;flex:none">${thumb()}${over}</div>
    <div class="grow col" style="gap:2px;min-width:0"><div class="t-sub" style="font-weight:600">Чек додано</div><div class="t-foot muted num" role="status">${up ? 'Завантажується · 62%' : 'Завантажено · 220 КБ'}</div></div>
    <span class="btn sm secondary">Замінити</span><span class="iconbtn" role="button" aria-label="Видалити чек" style="color:var(--muted-fg)">${icon('x', { size: 18 })}</span></div>`
}

export function amountBlock({ focus = false, amount = AMOUNT, cur = 'USD' } = {}) {
  // The amount never truncates: it steps down 44 → 34 px when it would not fit (long UAH sums at 320).
  const fs = amount.length > 9 ? 34 : 44
  return `<div style="padding:18px 0 4px;text-align:center"><label class="t-foot muted" for="amt">Сума</label>
    <div id="amt" class="num" style="font-size:${fs}px;line-height:52px;font-weight:700;letter-spacing:-0.03em;margin-top:2px;white-space:nowrap">${focus ? '1 250,5<span class="caret" style="height:40px"></span>' : amount}</div>
    <div class="row" style="justify-content:center;flex-wrap:wrap;gap:8px;margin-top:10px">${currencyPill(cur)}${segmented(['Витрата', 'Дохід', 'Переказ'], 0, { fit: true })}</div></div>`
}

/** Collapsed optional fields: the row shows what will be saved, not what is missing. */
export const defaultsRow = () =>
  `<div role="button" aria-expanded="false" class="row" style="justify-content:center;gap:6px;height:44px;font-size:15px;margin-top:6px"><span class="muted">${icon('calendar', { size: 16 })}</span><span>Сьогодні · без проєкту ·</span><span style="color:var(--primary);font-weight:600">змінити</span></div>`

export function optionalFields({ focus = '', dateError = false } = {}) {
  return [
    field({
      id: 'dt',
      label: 'Дата',
      value: dateError ? '28 жовтня 2026' : 'Сьогодні, 11 листопада',
      state: dateError ? 'error focus' : '',
      err: dateError ? 'Жовтень уже закрито. Оберіть дату від 1 листопада.' : '',
      lead: `<span class="muted">${icon('calendar', { size: 18 })}</span>`,
    }),
    field({
      id: 'p',
      label: 'Проєкт',
      value: 'Без проєкту',
      suffix: `<span class="muted">${icon('chevron-down', { size: 18 })}</span>`,
    }),
    field({
      id: 'n',
      label: 'Опис',
      value: focus === 'note' ? 'Оренда офісу за лис' : '',
      ph: 'Необов’язково',
      state: focus === 'note' ? 'focus' : '',
    }),
  ].join('')
}

/** Bottom submit bar: sits on the keyboard (tracks visualViewport) or above the home indicator. */
export function submitBar({ w = 375, kbdH = 0, inner }) {
  const pad = kbdH ? 8 : safeBottom(w) + 8
  return `<div style="position:absolute;left:0;right:0;bottom:${kbdH}px;z-index:80;padding:8px 16px ${pad}px;background:var(--popover);border-top:1px solid var(--border)">${inner}</div>`
}

export const primaryBtn = (label, ic = '') =>
  `<span class="btn primary" role="button" style="width:100%">${ic ? icon(ic, { size: 18 }) : ''}${label}</span>`

const SR =
  'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'

/** The receipt percent: a progressbar, never a live region (only arm / disarm / result are announced). */
const progress = (inner, label = 'Завантаження чека') =>
  `<span role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="62" style="display:grid;flex:none">${inner}</span>`

/**
 * Armed save: the payload is frozen and the button names it. Repeat taps are ignored (no toggle).
 * Disarm = the separate «Не зберігати автоматично» control, or any field edit.
 */
export const armedBtn = ({ amount = AMOUNT, cur = 'USD' } = {}) =>
  `<span class="btn" role="button" aria-describedby="arm-st" style="width:100%;min-height:56px;height:auto;padding:8px 14px;flex-direction:column;gap:0;position:relative;overflow:hidden;background:oklch(0.84 0.183 85.3 / 0.12);color:var(--fg);box-shadow:inset 0 0 0 1px oklch(0.84 0.183 85.3 / 0.5)"><i aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:62%;background:oklch(0.84 0.183 85.3 / 0.24)"></i><span class="num" style="position:relative;font-size:15px;line-height:20px;white-space:normal;text-align:center">Збережеться ${amount} ${cur} після чека</span>${progress(`<span class="num t-cap" style="position:relative;font-weight:500;color:oklch(0.86 0 0)">чек 62%</span>`)}</span><span id="arm-st" role="status" style="${SR}">Збереження заплановано</span>
  <span class="btn ghost" role="button" style="width:100%;height:44px;margin-top:4px;font-size:15px;font-weight:500;color:var(--muted-fg)">Не зберігати автоматично</span>`

export function decimalPad() {
  const k = (t, alt = '') => `<div class="k ${alt}">${t}</div>`
  return `<div class="kbd" aria-hidden="true">${systemBar('margin:-8px -6px 0')}
  <div class="krow">${k('1')}${k('2')}${k('3')}</div><div class="krow">${k('4')}${k('5')}${k('6')}</div>
  <div class="krow">${k('7')}${k('8')}${k('9')}</div><div class="krow">${k(',', 'alt')}${k('0')}${k(icon('delete', { size: 22 }), 'alt')}</div><div style="height:30px"></div></div>`
}
export const DECIMAL_H = 44 + 4 * 46 + 4 * 8 + 30 + 8

export function textKeyboard() {
  const key = (k) =>
    `<span style="flex:1;height:42px;border-radius:6px;background:oklch(0.36 0 0);display:grid;place-items:center;font-size:20px;color:#fff">${k}</span>`
  const row = (keys) =>
    `<div style="display:flex;gap:5px">${keys.split('').map(key).join('')}</div>`
  const mod = (t, wd = 42) =>
    `<span style="width:${wd}px;height:42px;border-radius:6px;background:oklch(0.28 0 0);display:grid;place-items:center;color:#fff;font-size:15px">${t}</span>`
  return `<div class="kbd" aria-hidden="true" style="padding:0 3px;gap:11px">${systemBar('margin:0 -3px')}
  ${row('йцукенгшщзх')}${row('фівапролджє')}<div style="display:flex;gap:5px">${mod(icon('arrow-big-up', { size: 20 }))}<div class="grow">${row('ячсмитьбю')}</div>${mod(icon('delete', { size: 20 }))}</div>
  <div style="display:flex;gap:5px">${mod('123', 88)}<span class="grow" style="height:42px;border-radius:6px;background:oklch(0.36 0 0);display:grid;place-items:center;color:#fff;font-size:15px">пробіл</span>${mod('Далі', 88)}</div><div style="height:34px"></div></div>`
}
export const TEXT_H = 44 + 4 * 42 + 4 * 11 + 34

/**
 * One money form. variant 'sheet' (quick-add / edit, over the Finance tab) or 'page' (pushed screen).
 * keyboard '' | 'decimal' | 'text'; scroll lifts the body when a lower field is focused.
 */
export function moneyForm({
  w = 375,
  h = 812,
  variant = 'sheet',
  title = 'Нова транзакція',
  lead = 'Скасувати',
  amount = AMOUNT,
  cur = 'USD',
  keyboard = '',
  receipt = 'uploading',
  expanded = false,
  focus = '',
  dateError = false,
  alert = '',
  footer = primaryBtn('Зберегти'),
  scroll = 0,
  over = '',
}) {
  const kbdH = keyboard === 'decimal' ? DECIMAL_H : keyboard === 'text' ? TEXT_H : 0
  const body = `<div class="col" style="gap:14px;padding:4px 16px 120px;transform:translateY(-${scroll}px)">${alert}${receiptCard(receipt)}${amountBlock({ focus: focus === 'amount', amount, cur })}${expanded ? `<div class="col" style="gap:16px">${optionalFields({ focus, dateError })}</div>` : defaultsRow()}</div>`
  const bar = submitBar({ w, kbdH, inner: footer })
  const kbd = keyboard === 'decimal' ? decimalPad() : keyboard === 'text' ? textKeyboard() : ''
  if (variant === 'page') {
    const inner = `${topBar({ back: true, title, bell: false, search: false })}<div class="content">${body}</div>${bar}${kbd}`
    return phone({ w, h, inner, overlay: over })
  }
  const overlay = `${sheet({ w, h, top: safeTop(w) + 10, title, lead: `<span style="font-size:17px">${lead}</span>`, body, footer: bar })}${kbd}${over}`
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

// ---------- Failure states (spec §4.5b + Master ruling, fix round 2) ----------
export const errAlert = (title, text, tone = 22) =>
  `<div role="alert" style="padding:12px 14px;border-radius:14px;background:oklch(0.2 0.04 ${tone});border:1px solid oklch(0.38 0.09 ${tone})"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:${tone === 22 ? 'var(--destructive)' : 'var(--warning)'};margin-top:1px">${icon(tone === 22 ? 'circle-alert' : 'circle-help', { size: 18 })}</span><div class="grow"><div style="font-size:15px;font-weight:600">${title}</div><div class="t-foot" style="margin-top:2px;color:oklch(0.88 0.02 ${tone})">${text}</div></div></div></div>`

/** 422: the values are wrong, not the network — inline error on the field, focus moved there, no retry button. */
export const failure422 = (w, h) =>
  moneyForm({ w, h, receipt: 'done', expanded: true, dateError: true, focus: 'date' })

/** Definite failure that is not about a field (offline before send, app 500/503): alert + manual retry. */
export const failureOffline = (w, h) =>
  moneyForm({
    w,
    h,
    receipt: 'done',
    alert: errAlert(
      'Транзакцію не надіслано',
      'Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.',
    ),
    footer: primaryBtn('Повторити збереження', 'rotate-cw'),
  })

/** Unknown outcome (502/504/524, drop after send, client timeout) on a keyless form: keep the draft, check the list. */
export const failureUnknown = (w, h) =>
  moneyForm({
    w,
    h,
    receipt: 'done',
    alert: errAlert(
      'Невідомо, чи транзакцію збережено',
      'Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.',
      85,
    ),
    footer: `<span class="btn secondary" role="button" style="width:100%">${icon('list', { size: 18 })}Перевірити список</span>`,
  })

/** «Перевірити список»: the list opens as a sheet over the kept form, refetched on open. */
export function failureUnknownList(w, h) {
  const body = `<div class="col" style="gap:4px;padding:0 16px 8px"><div role="status" class="t-foot muted row" style="gap:6px">${icon('rotate-cw', { size: 14 })}Оновлено щойно</div>
  <div class="t-foot" style="padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)">Якщо транзакції ще немає, оновіть список за хвилину.</div></div>${txnList(TXNS.slice(0, 4))}`
  const footer = `<div style="display:grid;gap:8px;padding:10px 16px ${safeBottom(w) + 8}px;border-top:1px solid var(--border);background:var(--popover)"><span class="btn secondary" role="button" style="width:100%">${icon('check', { size: 18 })}Є в списку — закрити чернетку</span><span class="btn secondary" role="button" style="width:100%">${icon('plus', { size: 18 })}Немає — створити ще раз</span></div>`
  const list = sheet({
    w,
    h,
    top: safeTop(w) + 34,
    title: 'Транзакції',
    trail: closeBtn,
    body,
    footer,
  })
  return failureUnknown(w, h).replace('<div class="homebar">', `${list}<div class="homebar">`)
}

export const PILL_H = 56
const pillBox = (w, inner, label, tone = '0.34 0.05 85') =>
  `<div role="button" aria-label="${label}" class="row" style="position:absolute;left:12px;right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16}px;z-index:44;gap:10px;height:${PILL_H}px;padding:0 12px 0 10px;border-radius:16px;background:oklch(0.2 0.006 85);border:1px solid oklch(${tone});box-shadow:0 10px 30px oklch(0 0 0 / 0.5)">${inner}</div>`
const pillText = (a, b) =>
  `<span class="grow col" style="gap:1px;min-width:0"><span class="num" style="font-size:13px;font-weight:600;white-space:nowrap">${a}</span><span class="t-cap muted">${b}</span></span>`

/** One pill, three states. armed: the save rides the upload. saved / failed: the result waits for a tap. */
export function moneyPill(w, kind = 'armed') {
  if (kind === 'saved')
    return pillBox(
      w,
      `<span style="color:var(--positive)">${icon('circle-check', { size: 24 })}</span>${pillText(`Збережено ${AMOUNT} USD`, 'Відкрити')}<span role="status" style="${SR}">Транзакцію збережено</span>`,
      `Збережено ${AMOUNT} USD. Відкрити`,
      '0.4 0.08 150',
    )
  if (kind === 'failed')
    return pillBox(
      w,
      `<span style="color:var(--destructive)">${icon('circle-alert', { size: 24 })}</span>${pillText('Не збережено', 'Відкрити чернетку')}<span role="status" style="${SR}">Транзакцію не збережено</span>`,
      'Не збережено. Відкрити чернетку',
      '0.42 0.12 22',
    )
  return pillBox(
    w,
    `${progress(ring(62, 28))}${pillText(`Збережеться ${AMOUNT} USD · 62%`, 'Відкрити чернетку')}`,
    `Збережеться ${AMOUNT} USD після чека. Відкрити чернетку`,
  )
}

const financeTab = (w, h, overlay, body = financeBody()) =>
  tabScreen({ w, h, role: 'ADMIN', active: '/finance', title: 'Фінанси', body, overlay })

/** Sheet dismissed while armed: the global upload pill carries the save; a tap reopens the draft. */
export const uploadPillArmed = (w, h) => financeTab(w, h, moneyPill(w, 'armed'))
export const uploadPillSaved = (w, h) => financeTab(w, h, moneyPill(w, 'saved'))
export const uploadPillFailed = (w, h) => financeTab(w, h, moneyPill(w, 'failed'))

/** Toast + pill: the pill keeps the base slot, at most one toast stacks 8 px above it. */
export function toastPillStack(w, h) {
  const toast = `<div class="toast" role="status" style="left:12px;right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16 + PILL_H + 8}px;min-height:52px"><span style="color:var(--positive)">${icon('circle-check', { size: 18 })}</span><span class="grow">Транзакцію «Оренда офісу» оновлено</span></div>`
  return financeTab(w, h, `${moneyPill(w, 'armed')}${toast}`)
}

/** Boot after a page kill while armed: only a timestamp marker survived, so the alert names no amount. */
export function pageKillAlert(w, h) {
  const alert = `<div style="padding:0 16px 12px"><div role="alert" style="padding:12px 14px;border-radius:14px;background:oklch(0.2 0.04 22);border:1px solid oklch(0.38 0.09 22)"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:var(--destructive);margin-top:1px">${icon('circle-alert', { size: 18 })}</span><div class="grow t-foot" style="font-size:15px;line-height:20px;color:oklch(0.92 0.02 22)">Транзакцію не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.</div></div><div class="row" style="justify-content:flex-end;margin-top:6px"><span class="btn sm secondary" role="button">Зрозуміло</span></div></div></div>`
  return financeTab(w, h, '', `${alert}${financeBody()}`)
}

/** The kept draft, pinned at the top of the Фінанси list when reached another way. */
export function listrowDraft(w, h) {
  const row = `<div style="padding:0 16px 12px"><div class="row" style="gap:12px;min-height:64px;padding:8px 8px 8px 12px;border-radius:14px;background:var(--card);border:1px solid oklch(0.84 0.183 85.3 / 0.45);box-shadow:inset 2px 0 0 var(--primary)"><span style="width:36px;height:36px;border-radius:10px;background:var(--yellow-subtle);color:var(--primary);display:grid;place-items:center;flex:none">${icon('file-pen', { size: 18 })}</span><span class="grow col" style="gap:2px;min-width:0"><span class="t-body num" style="font-weight:600">Чернетка <span style="white-space:nowrap">${AMOUNT} USD</span></span><span class="t-foot muted">Не збережено · Витрата · чек додано</span></span><span class="btn sm primary" role="button" style="height:44px">Продовжити</span></div></div>`
  const body = financeBody()
  const k = body.indexOf('<div class="sechead"')
  return financeTab(w, h, '', k < 0 ? row + body : body.slice(0, k) + row + body.slice(k))
}
