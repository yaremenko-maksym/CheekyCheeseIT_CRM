// The canonical mobile money form (council R1, item A): one shape for quick-add, the pushed page,
// keyboard-open, edit and the failure frames. Chrome: «Скасувати» top-left, title centred, the
// primary in a bottom bar above the keyboard / home indicator. Never a top-right «Готово».
// The primary is always enabled (except while its own request is in flight): a tap validates,
// focuses the first invalid field and shows inline errors. Sample data is invented.
import { icon, phone, safeBottom, systemBar, segmented, currencyPill, field } from './base.mjs'
import { tabScreen, financeBody, topBar, txnRow, TABBAR_H, FLOAT_RIGHT } from './mobile.mjs'
import { sheet, safeTop, closeBtn, quickAddRows } from './mobile-overlays.mjs'

export const AMOUNT = '1 250,50'

export const thumb = (s = 44) =>
  `<div style="position:relative;width:${s}px;height:${s}px;flex:none;border-radius:10px;background:linear-gradient(160deg,oklch(0.86 0 0),oklch(0.7 0 0));outline:1px solid oklch(1 0 0 / 0.1);outline-offset:-1px;overflow:hidden"><div style="position:absolute;inset:7px 9px;display:grid;gap:4px">${'<i style="height:3px;background:oklch(0.45 0 0);border-radius:2px"></i>'.repeat(4)}</div></div>`

export function ring(pct, size = 28) {
  const c = 2 * Math.PI * 15
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.25)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
}

// The receipt is mandatory: exactly one of a file or a link. Effective currency USDT: an explorer link only.
const URL_ATTRS =
  'type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"'
const receiptModes = (on) =>
  `<div role="group" aria-label="Чек" style="margin-bottom:8px">${segmented(['Файл', 'Посилання'], on)}</div>`
const linkField = ({ usdt = false, value = '', err = '' } = {}) =>
  field({
    id: 'rl',
    label: usdt ? 'Посилання на транзакцію в блокчейн-експлорері' : 'Посилання на чек',
    value,
    ph: usdt ? 'https://tronscan.org/#/transaction/…' : 'https://…',
    state: err ? 'error focus' : '',
    err,
    hint: usdt && !err ? 'Чек для USDT — лише посилання на транзакцію' : '',
    lead: `<span class="muted">${icon('link', { size: 18 })}</span>`,
    attrs: URL_ATTRS,
  })

const USDT_ERR = 'Для USDT потрібне посилання на транзакцію в експлорері'

/**
 * Receipt tile. Empty: «Файл» / «Посилання» (44 px segmented) over the picker or the link field.
 * A file in place replaces the switch (remove it to switch). USDT: the link field only, no file mode.
 * «Замінити» and «✕ Видалити чек» are both 44 px. A currency switch to USDT with a file (uploading or
 * done) keeps the file card with the USDT error and two exits; nothing is deleted silently.
 */
export function receiptCard(state = 'uploading', { narrow = false, cur = 'USD' } = {}) {
  const usdt = cur === 'USDT'
  if (usdt && state === 'empty') return linkField({ usdt: true })
  if (usdt && (state === 'uploading' || state === 'done'))
    return `<div role="group" aria-label="Чек" aria-describedby="rf-e" class="col" style="gap:10px;padding:6px 10px 12px;border-radius:14px;background:var(--card);border:1.5px solid var(--destructive)">
    <div class="row" style="gap:10px">${thumb()}<div class="grow col" style="gap:2px;min-width:0"><div class="t-sub trunc" style="font-weight:600">receipt-office-nov.jpg</div><div class="t-foot muted num">Файл · 220 КБ</div></div></div>
    <div class="hint err" id="rf-e">${icon('circle-alert', { size: 15 })}<span>${USDT_ERR}</span></div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary" style="flex:1 1 auto">${icon('link', { size: 18 })}Замінити посиланням</button><button type="button" class="btn ghost" style="color:var(--destructive)">${icon('trash-2', { size: 18 })}Видалити чек</button></div></div>`
  // The upload failed: the card stays with its error and two exits. An armed draft becomes `failed`.
  if (state === 'failed')
    return `<div role="group" aria-label="Чек" aria-describedby="rf-f" class="col" style="gap:10px;padding:6px 10px 12px;border-radius:14px;background:var(--card);border:1.5px solid var(--destructive)">
    <div class="row" style="gap:10px">${thumb()}<div class="grow col" style="gap:2px;min-width:0"><div class="t-sub trunc" style="font-weight:600">receipt-office-nov.jpg</div><div class="t-foot muted num">Не завантажено · 220 КБ</div></div></div>
    <div class="hint err" id="rf-f">${icon('circle-alert', { size: 15 })}<span>Чек не завантажився: з’єднання перервалося</span></div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn secondary" style="flex:1 1 auto">${icon('rotate-cw', { size: 18 })}Повторити</button><button type="button" class="btn secondary" style="flex:1 1 auto">${icon('refresh-cw', { size: 18 })}Замінити</button></div></div>`
  if (state === 'empty')
    return `<div>${receiptModes(0)}<div class="row" role="button" style="gap:12px;height:68px;padding:0 12px;border-radius:var(--r-lg);border:1.5px dashed var(--input-border)">
    <span style="width:44px;height:44px;border-radius:12px;background:var(--surface);display:grid;place-items:center">${icon('camera', { size: 20 })}</span><span class="grow col" style="gap:2px"><span class="t-sub" style="font-weight:600">Додати чек</span><span class="t-foot muted">Камера, фото або файл · до 10 МБ</span></span></div></div>`
  if (state === 'link')
    return `<div>${receiptModes(1)}${linkField({ value: 'https://docs.example.com/receipts/office-nov.pdf' })}</div>`
  if (state === 'usdt-error')
    return linkField({
      usdt: true,
      value: 'https://drive.example.com/usdt-receipt.png',
      err: USDT_ERR,
    })
  const up = state === 'uploading'
  const over = up
    ? `<div role="progressbar" aria-label="Завантаження чека" aria-valuemin="0" aria-valuemax="100" aria-valuenow="62" style="position:absolute;inset:0;background:oklch(0 0 0 / 0.45);display:grid;place-items:center">${ring(62)}</div>`
    : ''
  // «Чек додано» only at 100%; while uploading the title is the file name and the status line the phase.
  // The percent is aria-hidden: the ring is the progressbar.
  const title = up ? 'receipt-office-nov.jpg' : 'Чек додано'
  const status = up ? (narrow ? '62%' : 'Завантаження · 62%') : '220 КБ'
  const replace = narrow
    ? `<button type="button" class="iconbtn" aria-label="Замінити чек">${icon('refresh-cw', { size: 18 })}</button>`
    : '<button type="button" class="btn sm secondary">Замінити</button>'
  return `<div class="row" style="gap:6px;padding:6px 4px 6px 10px;border-radius:14px;background:var(--card);border:1px solid var(--border)">
    <div style="position:relative;width:44px;height:44px;flex:none">${thumb()}${over}</div>
    <div class="grow col" style="gap:2px;min-width:0;margin-left:4px"><div class="t-sub trunc" style="font-weight:600">${title}</div><div class="t-foot muted num trunc" aria-hidden="${up}">${status}</div></div>
    ${replace}<button type="button" class="iconbtn" aria-label="Видалити чек" style="color:var(--muted-fg)">${icon('x', { size: 18 })}</button></div>`
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

/** The canonical body (alert, receipt, amount + currency + type, defaults row or expanded fields). */
export const moneyBody = ({
  amount = AMOUNT,
  cur = 'USD',
  receipt = 'uploading',
  expanded = false,
  focus = '',
  dateError = false,
  alert = '',
  scroll = 0,
  pad = '4px 16px 120px',
  narrow = false,
  locked = false,
} = {}) => {
  const rest = locked
    ? sentFields()
    : expanded
      ? `<div class="col" style="gap:16px">${optionalFields({ focus, dateError })}</div>`
      : defaultsRow()
  const fields = `${receiptCard(receipt, { narrow, cur })}${amountBlock({ focus: focus === 'amount', amount, cur })}${rest}`
  return `<div class="col" style="gap:14px;padding:${pad};transform:translateY(-${scroll}px)">${alert}${locked ? lockedFields(fields) : fields}</div>`
}

/**
 * An unknown draft is read-only from send until it leaves that state: the sent values stay visible and
 * readable, every control is dimmed and aria-disabled (never hidden, never the `inert` attribute, which
 * would hide the values from a screen reader). To change a value the user discards the draft.
 */
const lockedFields = (html) =>
  `<style>.locked .btn,.locked .iconbtn,.locked [role=radiogroup],.locked .pill,.locked [aria-expanded]{opacity:.4}</style><div class="t-foot muted row num" style="gap:6px;justify-content:center">${icon('lock', { size: 14 })}Надіслано о 14:32 · змінити не можна</div><div class="locked col" style="gap:14px">${html
    .replace(/<button type="button"/g, '<button type="button" aria-disabled="true"')
    .replace(/role="(button|radio)"/g, 'role="$1" aria-disabled="true"')}</div>`

/** A locked draft shows everything it sent: the optional fields as read-only text, no «змінити». */
const sentFields = () =>
  `<dl class="group" style="margin:0">${[
    ['Дата', 'Сьогодні, 11 листопада'],
    ['Проєкт', 'Без проєкту'],
    ['Опис', 'Без опису'],
  ]
    .map(
      ([k, v], i) =>
        `<div class="row" style="justify-content:space-between;gap:12px;min-height:44px;padding:0 14px;${i ? 'border-top:1px solid var(--separator)' : ''}"><dt class="t-foot muted">${k}</dt><dd class="t-body" style="margin:0">${v}</dd></div>`,
    )
    .join('')}</dl>`

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
 * Armed save: the payload is frozen and the button names it. aria-disabled (never disabled), so it keeps
 * focus and its name; a tap only explains the wait. Disarm = «Не зберігати автоматично», any field edit,
 * or replacing / removing the receipt.
 */
export const armedBtn = ({ amount = AMOUNT, cur = 'USD' } = {}) =>
  `<span class="btn" role="button" aria-disabled="true" aria-describedby="arm-st" style="width:100%;min-height:56px;height:auto;padding:8px 14px;flex-direction:column;gap:0;position:relative;overflow:hidden;background:oklch(0.84 0.183 85.3 / 0.12);color:var(--fg);box-shadow:inset 0 0 0 1px oklch(0.84 0.183 85.3 / 0.5)"><i aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:62%;background:oklch(0.84 0.183 85.3 / 0.24)"></i><span class="num" style="position:relative;font-size:15px;line-height:20px;white-space:normal;text-align:center">Збережеться ${amount} ${cur} після чека</span>${progress(`<span class="num t-cap" style="position:relative;font-weight:500;color:oklch(0.86 0 0)">чек 62%</span>`)}</span><span id="arm-st" role="status" style="${SR}">Збереження заплановано</span>
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
  locked = false,
}) {
  const kbdH = keyboard === 'decimal' ? DECIMAL_H : keyboard === 'text' ? TEXT_H : 0
  const body = moneyBody({
    amount,
    cur,
    receipt,
    expanded,
    focus,
    dateError,
    alert,
    scroll,
    narrow: w < 360,
    locked,
  })
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

/**
 * A failed or unknown draft is put away, never lost: the leading control reads «Згорнути» (a drag down
 * and a scrim tap do the same) and keeps the draft. Discard is its own 44 px control under the primary.
 */
export const discardBtn = `<button type="button" class="btn ghost" style="width:100%;height:44px;margin-top:4px;font-size:15px;font-weight:500;color:var(--destructive)">${icon('trash-2', { size: 18 })}Видалити чернетку</button>`
const draftForm = (opts) => moneyForm({ lead: 'Згорнути', ...opts })

/** 422: the values are wrong, not the network — inline error on the field, focus moved there, no retry button. */
export const failure422 = (w, h) =>
  draftForm({
    w,
    h,
    receipt: 'done',
    expanded: true,
    dateError: true,
    focus: 'date',
    footer: primaryBtn('Зберегти') + discardBtn,
  })

/** Definite failure that is not about a field (offline before send, app 500/503): alert + manual retry. */
export const failureOffline = (w, h) =>
  draftForm({
    w,
    h,
    receipt: 'done',
    alert: errAlert(
      'Транзакцію не надіслано',
      'Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.',
    ),
    footer: primaryBtn('Повторити збереження', 'rotate-cw') + discardBtn,
  })

/** An armed draft whose receipt upload failed is `failed`: the error sits on the receipt card. */
export const failureReceipt = (w, h) =>
  draftForm({ w, h, receipt: 'failed', footer: primaryBtn('Зберегти') + discardBtn })

/**
 * Unknown outcome (502/504/524, drop after send, client timeout) on a keyless form: keep the draft, check
 * the list. The sent values are read-only; the check sheet and a recreate use exactly that payload.
 */
export const failureUnknown = (w, h) =>
  draftForm({
    w,
    h,
    receipt: 'done',
    locked: true,
    alert: errAlert(
      'Невідомо, чи транзакцію збережено',
      'Відповідь не надійшла. Форма й чек залишились. Перевірте список: якщо транзакції там немає, її можна створити ще раз.',
      85,
    ),
    // The form is inert, so «Перевірити список» is the one filled primary.
    footer: `<span class="btn primary" role="button" style="width:100%">${icon('list', { size: 18 })}Перевірити список</span>${discardBtn}`,
  })

/** The send time of the sample draft (invented). */
export const SENT_AT = '14:32'
/** The check sheet's bound: `t − 5 хв`, so a device clock that runs ahead cannot hide the committed row. */
export const FROM = '14:27'

// The check sheet lists only the user's rows created from `t − 5 хв`, newest created first, with no
// filters or date sections; each row carries its business date and its server creation time. A match
// (amount, currency, type) is highlighted.
export const NEW_ROWS = [
  {
    t: 'Оплата від клієнта',
    s: 'Дохід · 10.11.2026',
    a: '+1 250,50 USD',
    time: '14:33',
    ic: 'arrow-down-left',
    isNew: true,
  },
  {
    t: 'Хостинг серверів',
    s: 'Витрата · 11.11.2026',
    a: '−45,00 USD',
    time: '14:33',
    ic: 'receipt',
    neg: true,
    isNew: true,
  },
]
/** Same type, currency and amount, another description, an earlier row: «схожа · інший опис», muted, never a «збіг». */
export const SIMILAR_ROW = {
  t: 'Обладнання · ноутбук',
  s: 'Витрата · 11.11.2026',
  a: `−${AMOUNT} USD`,
  time: '14:29',
  ic: 'receipt',
  neg: true,
  tag: 'схожа · інший опис',
}

/** Equal amount, created after the send, but the payload differs (the server trimmed the description): a warning «схожа». */
export const SIMILAR_AFTER = {
  t: 'Обладнання',
  s: 'Витрата · 11.11.2026',
  a: `−${AMOUNT} USD`,
  time: '14:33',
  ic: 'receipt',
  neg: true,
  tag: 'схожа · інший опис',
  warn: true,
}

export const MATCH_ROW = {
  t: 'Без опису',
  s: 'Витрата · 11.11.2026',
  a: `−${AMOUNT} USD`,
  time: '14:33',
  ic: 'receipt',
  neg: true,
  match: true,
}

/**
 * «Перевірити список»: the list opens as a sheet over the kept form, refetched on open. It lists only rows
 * created from `t − 5 хв`, newest created first, without the list's filters or date sections. Only a row
 * whose every sent field matches and whose created_at >= t + offset − 5 s (offset from the `Date` header)
 * is highlighted («збіг»); the same type, currency and amount with another field different is «схожа» (it
 * names the field); a different type or currency is «нова», whatever the amount.
 * «Немає — створити ще раз» stays aria-disabled until 60 s after the failure arrived; then one automatic
 * refetch runs and the status region announces the unlock once. The countdown is never in a live region.
 * rows: 'none' (new rows, no match), 'match', 'similar' (a warning «схожа» after the send), 'empty', 'failed' (the refetch failed: an alert with
 * «Повторити», never the empty text or «Збігів немає»; the recreate unlocks only after a successful
 * refetch at least 60 s after the failure arrived).
 */
export function failureUnknownList(w, h, { ready = false, rows = 'none' } = {}) {
  const failed = rows === 'failed'
  const hint = failed
    ? 'Список не оновився. Створити транзакцію ще раз можна лише після того, як він оновиться.'
    : rows === 'match'
      ? 'Схоже, це ваша транзакція: −1 250,50 USD, створена о 14:33. Перевірте її, перш ніж створювати ще раз.'
      : rows === 'similar'
        ? 'У списку є схожа о 14:33: та сама сума, інший опис. Перевірте її, перш ніж створювати ще раз.'
        : ready
          ? 'Список оновлено через хвилину після помилки. Якщо транзакції в ньому немає, її можна створити ще раз.'
          : 'Сервер міг зберегти транзакцію із запізненням. Через хвилину після помилки список оновиться сам, і тоді її можна буде створити ще раз.'
  // With a «збіг» the status never announces the unlock.
  const status = ready
    ? rows === 'match'
      ? 'Оновлено о 14:34:01. Знайдено збіг'
      : rows === 'similar'
        ? 'Оновлено о 14:34:01. Знайдено схожу'
        : 'Оновлено о 14:34:01. Тепер можна створити ще раз'
    : 'Оновлено о 14:33:18'
  const list = failed
    ? ''
    : rows === 'empty'
      ? `<div class="col" style="align-items:center;gap:6px;padding:28px 24px;text-align:center"><span class="muted">${icon('search', { size: 24 })}</span><div class="t-body num" style="font-weight:600">Нових записів з ${FROM} немає</div></div>`
      : `<div class="group" style="margin-top:4px">${(rows === 'match' ? [MATCH_ROW, ...NEW_ROWS, SIMILAR_ROW] : rows === 'similar' ? [SIMILAR_AFTER, ...NEW_ROWS] : NEW_ROWS).map((r) => txnRow(r, { wrap: true })).join('')}</div>`
  const body = `<div class="col" style="gap:8px;padding:0 16px 8px">
  <div class="t-sub num" style="font-weight:600">Шукаємо: −${AMOUNT} USD · Витрата · без опису · надіслано ${SENT_AT}</div>
  <div class="t-foot muted num">Лише ваші записи з ${FROM}</div>
  ${
    failed
      ? `<div role="alert" class="row" style="gap:8px;padding:6px 6px 6px 12px;border-radius:12px;background:oklch(0.2 0.04 22);border:1px solid oklch(0.38 0.09 22)"><span style="color:var(--destructive)">${icon('circle-alert', { size: 16 })}</span><span class="grow t-foot" style="font-weight:600">Не вдалося оновити список</span><button type="button" class="btn sm secondary" style="height:44px">${icon('rotate-cw', { size: 16 })}Повторити</button></div>`
      : `<div class="row" style="gap:8px"><div role="status" class="grow t-foot muted row num" style="gap:6px">${icon('rotate-cw', { size: 14 })}${status}</div><span class="btn sm secondary" role="button" style="height:44px">${icon('refresh-cw', { size: 16 })}Оновити</span></div>`
  }
  <div id="rc-h" class="t-foot" style="padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)">${hint}</div></div>${list}`
  const recreate =
    ready && !failed
      ? `<span class="btn secondary" role="button" style="width:100%">${icon('plus', { size: 18 })}Немає — створити ще раз</span>`
      : `<span class="btn secondary" role="button" aria-disabled="true" aria-describedby="rc-h" style="width:100%;min-height:52px;height:auto;padding:6px 14px;flex-direction:column;gap:0;color:var(--muted-fg);box-shadow:none;border:1px solid var(--border);background:transparent"><span class="row" style="gap:8px">${icon('plus', { size: 18 })}Немає — створити ще раз</span>${failed ? '' : '<span class="t-cap num" aria-hidden="true">Можна через 0:42</span>'}</span>`
  const noMatch =
    rows === 'none'
      ? `<div class="t-foot muted num" style="text-align:center">Збігів немає</div>`
      : ''
  const footer = `<div style="display:grid;gap:8px;padding:10px 16px ${safeBottom(w) + 8}px;border-top:1px solid var(--border);background:var(--popover)">${noMatch}<span class="btn ${rows === 'match' || rows === 'similar' ? 'primary' : 'secondary'}" role="button"${rows === 'match' ? '' : ' aria-haspopup="dialog"'} style="width:100%">${icon('check', { size: 18 })}Є в списку — закрити чернетку</span>${recreate}</div>`
  const sh = sheet({
    w,
    h,
    top: safeTop(w) + 34,
    title: 'Нові записи',
    trail: closeBtn,
    body,
    footer,
  })
  return failureUnknown(w, h).replace('<div class="homebar">', `${sh}<div class="homebar">`)
}

/**
 * Boot, phase `sent`: «Оновити список» on the alert opens the check sheet over the Фінанси list. No draft form
 * is behind it and the marker holds no amount, so the sheet names only the time and offers no resubmit.
 * A failed refetch here reuses the «Не вдалося оновити список» alert with «Повторити». Drawn while the
 * device time is before `latest t + 160 s`: the hint names the app-owned background refetch (it runs at
 * `max(boot, latest sent t + 160 s)` whether this sheet is open or not; foundation §11), and «…створіть її
 * знову» appears only after it succeeds. Until then the footer reads «Закрити» and keeps the markers (like
 * ✕); «Зрозуміло» (acknowledge + remove the markers) appears only after that refetch.
 */
const BEFORE_ROW = {
  t: 'Таксі на зустріч',
  s: 'Витрата · 11.11.2026',
  a: '−18,20 USD',
  time: '14:29',
  ic: 'receipt',
  neg: true,
  tag: 'раніше',
}
export function checkSheetBoot(w, h) {
  const body = `<div class="col" style="gap:8px;padding:0 16px 8px">
  <div class="t-sub num" style="font-weight:600">Транзакція о ${SENT_AT} · результат невідомий</div>
  <div class="t-foot muted num">Лише ваші записи з ${FROM}</div>
  <div class="row" style="gap:8px"><div role="status" class="grow t-foot muted row num" style="gap:6px">${icon('rotate-cw', { size: 14 })}Оновлено о 14:33:40</div><span class="btn sm secondary" role="button" style="height:44px">${icon('refresh-cw', { size: 16 })}Оновити</span></div>
  <div class="t-foot" style="padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)">Сервер міг зберегти транзакцію із запізненням. Список оновиться о 14:35:12</div></div><div class="group" style="margin-top:4px">${[...NEW_ROWS, BEFORE_ROW].map((r) => txnRow(r, { wrap: true })).join('')}</div>`
  const footer = `<div style="padding:10px 16px ${safeBottom(w) + 8}px;border-top:1px solid var(--border);background:var(--popover)"><span class="btn secondary" role="button" style="width:100%">Закрити</span></div>`
  const sh = sheet({
    w,
    h,
    top: safeTop(w) + 34,
    title: 'Нові записи',
    trail: closeBtn,
    body,
    footer,
  })
  return overHome(pageKillAlert(w, h, 'sent'), sh)
}

export const PILL_H = 56
const PILL_POS = (w) =>
  `position:absolute;left:12px;right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16}px;z-index:44;height:${PILL_H}px;border-radius:16px;background:oklch(0.2 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5)`
const pillBox = (w, inner, label, tone = '0.34 0.05 85', close = false) =>
  close
    ? `<div class="row" style="${PILL_POS(w)};border:1px solid oklch(${tone});padding:0 4px 0 0"><div role="button" aria-label="${label}" class="row grow" style="gap:10px;height:100%;padding:0 4px 0 10px;min-width:0">${inner}</div><span class="iconbtn" role="button" aria-label="Закрити" style="color:var(--muted-fg)">${icon('x', { size: 18 })}</span></div>`
    : `<div role="button" aria-label="${label}" class="row" style="${PILL_POS(w)};gap:10px;padding:0 12px 0 10px;border:1px solid oklch(${tone})">${inner}</div>`
const pillText = (a, b) =>
  `<span class="grow col" style="gap:1px;min-width:0"><span class="num" style="font-size:13px;font-weight:600;white-space:nowrap">${a}</span><span class="t-cap muted">${b}</span></span>`

/**
 * One pill slot for every draft; it shows the highest state: unknown > failed > in flight > armed >
 * saved (foundation §11). The amount for one draft, a count for more. armed: the save rides the upload.
 * saved: a 44 px ✕ and a swipe dismiss it, the body opens the transaction. failed / unknown: wait for a
 * tap. multi: two armed drafts, a count and never a merged percentage (each pinned row has its own).
 * inflight: the create has left. drafts: two or more failed / unknown drafts; a tap opens Фінанси at the
 * pinned rows.
 */
export function moneyPill(w, kind = 'armed') {
  if (kind === 'unknown')
    return pillBox(
      w,
      `<span style="color:var(--primary)">${icon('circle-help', { size: 24 })}</span>${pillText('Результат невідомий', `${AMOUNT} USD · Відкрити`)}<span role="status" style="${SR}">Невідомо, чи транзакцію збережено</span>`,
      `Результат невідомий, ${AMOUNT} USD. Відкрити`,
      '0.42 0.09 85',
    )
  if (kind === 'drafts')
    return pillBox(
      w,
      `<span style="color:var(--destructive)">${icon('file-pen', { size: 24 })}</span>${pillText('2 потребують перевірки', 'Відкрити')}`,
      '2 чернетки потребують перевірки. Відкрити',
      '0.42 0.12 22',
    )
  if (kind === 'saved')
    return pillBox(
      w,
      `<span style="color:var(--positive)">${icon('circle-check', { size: 24 })}</span>${pillText(`Збережено ${AMOUNT} USD`, 'Відкрити')}<span role="status" style="${SR}">Транзакцію збережено</span>`,
      `Збережено ${AMOUNT} USD. Відкрити`,
      '0.4 0.08 150',
      true,
    )
  if (kind === 'multi')
    return pillBox(
      w,
      `<span style="color:var(--primary)">${icon('clock', { size: 24 })}</span>${pillText('Збережеться 2 транзакції', 'Відкрити')}`,
      'Збережеться 2 транзакції після чеків. Відкрити',
    )
  if (kind === 'inflight')
    return pillBox(
      w,
      `<span style="color:var(--primary);display:grid">${icon('loader-circle', { size: 24 })}</span>${pillText(`Зберігаємо ${AMOUNT} USD…`, 'Відкрити')}`,
      `Зберігаємо ${AMOUNT} USD. Відкрити`,
    )
  if (kind === 'failed')
    return pillBox(
      w,
      `<span style="color:var(--destructive)">${icon('circle-alert', { size: 24 })}</span>${pillText(`Не збережено ${AMOUNT} USD`, 'Відкрити')}<span role="status" style="${SR}">Транзакцію не збережено</span>`,
      `Не збережено ${AMOUNT} USD. Відкрити`,
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
export const uploadPillMulti = (w, h) =>
  financeTab(w, h, moneyPill(w, 'multi'), pinDrafts([DRAFT.armed2, DRAFT.armed]))
export const uploadPillInflight = (w, h) =>
  financeTab(w, h, moneyPill(w, 'inflight'), pinDrafts([DRAFT.inflight]))

/**
 * Failed / unknown drafts exist: «+» never blocks. On Фінанси the FAB opens a new form directly; on the
 * other tabs it opens the quick-add sheet with the draft rows on top. A red dot (carrying the count when
 * more than one) and the accessible name say how many drafts need attention.
 */
export const draftFab = (html, count = 1, label = 'Нова транзакція') =>
  html.replace(
    /<div class="fab" role="button" aria-label="[^"]*"\s*(aria-haspopup="dialog")?\s*style="([^"]*)">[\s\S]*?<\/div>/,
    (_, hp, st) => {
      const dot =
        count > 1
          ? `<i aria-hidden="true" class="num" style="position:absolute;top:5px;right:5px;min-width:18px;height:18px;border-radius:9px;background:var(--destructive);color:#fff;font:700 12px/18px var(--font);font-style:normal;text-align:center;box-shadow:0 0 0 2px var(--primary)">${count}</i>`
          : '<i aria-hidden="true" style="position:absolute;top:9px;right:9px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--primary)"></i>'
      const name =
        count > 1
          ? `${label}, ${count} чернетки потребують уваги`
          : `${label}, 1 чернетка потребує уваги`
      return `<div class="fab" role="button" aria-label="${name}"${hp ? ' aria-haspopup="dialog"' : ''} style="${st}">${icon('plus', { size: 26, stroke: 2.4 })}${dot}</div>`
    },
  )
export const uploadPillFailed = (w, h) => draftFab(financeTab(w, h, moneyPill(w, 'failed')))
export const uploadPillUnknown = (w, h) =>
  draftFab(financeTab(w, h, moneyPill(w, 'unknown'), pinDrafts([DRAFT.unknown])))

/** Toast + pill: the pill keeps the base slot, at most one toast stacks 8 px above it. */
export function toastPillStack(w, h) {
  const toast = `<div class="toast" role="status" style="left:12px;right:${FLOAT_RIGHT}px;bottom:${TABBAR_H + safeBottom(w) + 16 + PILL_H + 8}px;min-height:52px"><span style="color:var(--positive)">${icon('circle-check', { size: 18 })}</span><span class="grow">Транзакцію «Оренда офісу» оновлено</span></div>`
  return financeTab(w, h, `${moneyPill(w, 'armed')}${toast}`)
}

// Boot after a page kill. The marker is { t, phase: 'armed' | 'sent' | 'failed' }: no amount, payload or
// receipt, so no alert names an amount.
//   armed: the create never left, so the alert says it was not saved.
//   failed: a definite failure (or a failed receipt upload) the user never saw; nothing was saved.
//   sent: the create left and may have committed. «Оновити список» opens the «Нові записи» check sheet
//   (the user's rows created after the earliest t); the dated list is never scrolled. No resubmit.
const KILL = {
  armed: {
    text: 'Транзакцію не збережено: застосунок закрився під час завантаження чека. Створіть її ще раз.',
    actions: '<span class="btn sm secondary" role="button">Зрозуміло</span>',
    tone: 22,
    ink: 'var(--destructive)',
    glyph: 'circle-alert',
  },
  failed: {
    text: 'Транзакцію не збережено: о 14:32 збереження не вдалося. Створіть її ще раз.',
    actions: '<span class="btn sm secondary" role="button">Зрозуміло</span>',
    tone: 22,
    ink: 'var(--destructive)',
    glyph: 'circle-alert',
  },
  sent: {
    text: 'Результат збереження транзакції о 14:32 невідомий. Вона могла зберегтися: перевірте нові записи, перш ніж створювати її знову.',
    actions:
      // Drawn inside the late-commit window: «Закрити» keeps the markers until the guard's refetch succeeds.
      '<span class="btn sm ghost" role="button">Закрити</span><span class="btn sm secondary" role="button">Оновити список</span>',
    tone: 85,
    ink: 'var(--primary)',
    glyph: 'circle-help',
  },
}
export function pageKillAlert(w, h, phase = 'armed') {
  const k = KILL[phase]
  const alert = `<div style="padding:0 16px 12px"><div role="alert" style="padding:12px 14px;border-radius:14px;background:oklch(0.2 0.04 ${k.tone});border:1px solid oklch(0.38 0.09 ${k.tone})"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:${k.ink};margin-top:1px">${icon(k.glyph, { size: 18 })}</span><div class="grow t-foot" style="font-size:15px;line-height:20px;color:oklch(0.92 0.02 ${k.tone})">${k.text}</div></div><div class="row" style="justify-content:flex-end;gap:8px;margin-top:6px">${k.actions}</div></div></div>`
  return financeTab(w, h, '', `${alert}${financeBody()}`)
}

/**
 * Irreversible or money-moving action, mobile: an action sheet (alertdialog) with two 56 px rows,
 * the action first and the cancel apart. Over a sheet it stacks above the sheet (z 76 / 77).
 */
export function actionConfirm(
  w,
  {
    id,
    title,
    desc,
    action,
    cancel = 'Скасувати',
    ink = 'var(--destructive)',
    overSheet = false,
    focusCancel = false,
  },
) {
  const z = overSheet ? [76, 77] : [70, 75]
  const row = (label, style, focus = false) =>
    `<button type="button"${focus ? ' data-initial-focus' : ''} style="appearance:none;margin:0;border:0;background:none;font:inherit;color:inherit;width:100%;cursor:pointer;height:56px;display:grid;place-items:center;font-size:17px;font-weight:600;${style}">${label}</button>`
  return `<div class="scrim" style="z-index:${z[0]}"></div><div role="alertdialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-d" style="position:absolute;left:8px;right:8px;bottom:${safeBottom(w) + 8}px;z-index:${z[1]};display:grid;gap:8px">
  <div style="background:var(--popover);border-radius:14px;border:1px solid var(--border);overflow:hidden;text-align:center">
    <div style="padding:16px 20px 14px"><div id="${id}-t" class="t-sub num" style="font-weight:600">${title}</div><div id="${id}-d" class="t-foot muted" style="margin-top:4px">${desc}</div></div>
    ${row(action, `border-top:1px solid var(--separator);color:${ink}`)}</div>
  ${row(cancel, 'background:var(--popover);border-radius:14px;border:1px solid var(--border)', focusCancel)}</div>`
}
// A 320 (SE) device has no home bar: the overlay then goes last inside the device.
const overHome = (screen, overlay) =>
  screen.includes('<div class="homebar">')
    ? screen.replace('<div class="homebar">', `${overlay}<div class="homebar">`)
    : screen.replace(/<\/div>\s*$/, `${overlay}</div>`)

/**
 * A 401 with a dirty money form and a failed draft: its own state, never a save failure. The body names each
 * loss, so the initial focus is on «Не зараз» (no ring on touch) and Enter does not sign in; the markers stay.
 */
export const sessionExpired = (w, h) =>
  overHome(
    moneyForm({ w, h, receipt: 'done' }),
    actionConfirm(w, {
      id: 'se',
      title: 'Сесія завершилася. Увійдіть знову, щоб продовжити.',
      desc: '<span style="display:block">Незбережені дані форми та вибраний чек буде втрачено.</span><span style="display:block;margin-top:4px">Чернетку 86,40 USD буде втрачено.</span>',
      action: 'Увійти знову',
      cancel: 'Не зараз',
      ink: 'var(--primary)',
      overSheet: true,
      focusCancel: true,
    }),
  )

/** Unknown outcome, «Немає — створити ще раз»: the one money-moving step after an unknown result asks first. */
export const confirmRecreate = (w, h) =>
  overHome(
    failureUnknownList(w, h, { ready: true, rows: 'similar' }),
    actionConfirm(w, {
      id: 'cr',
      title: `Створити ${AMOUNT} USD ще раз?`,
      desc: 'У списку є схожа о 14:33. Буде створено одну нову транзакцію: витрата, сьогодні, без проєкту.',
      action: 'Створити ще раз',
      ink: 'var(--primary)',
      overSheet: true,
    }),
  )

/** A warning «схожа» and no «збіг»: «Є в списку — закрити чернетку» is the one filled primary (its named confirm stays). */
export const failureUnknownSimilar = (w, h) =>
  failureUnknownList(w, h, { ready: true, rows: 'similar' })

/** Empty list, «Є в списку — закрити чернетку» without a «збіг»: closing drops the frozen payload, so it asks. */
export const failureUnknownEmpty = (w, h) =>
  overHome(
    failureUnknownList(w, h, { ready: true, rows: 'empty' }),
    actionConfirm(w, {
      id: 'cc',
      title: `Закрити чернетку ${AMOUNT} USD?`,
      desc: 'У списку її не знайдено',
      action: 'Закрити чернетку',
      cancel: 'Залишити',
      overSheet: true,
    }),
  )

/** «Видалити чернетку» on a failed or unknown draft: discarding asks and names the amount. */
export const confirmDiscardDraft = (w, h) =>
  overHome(
    failureOffline(w, h),
    actionConfirm(w, {
      id: 'dd',
      title: `Видалити чернетку ${AMOUNT} USD?`,
      desc: 'Сума, поля й чек зникнуть. Цю дію не можна скасувати.',
      action: 'Видалити',
      cancel: 'Залишити',
      overSheet: true,
    }),
  )

// Pinned draft rows: one per unsaved draft (armed, in flight, failed, unknown), newest first.
export const DRAFT = {
  failed: { kind: 'failed', amount: AMOUNT, state: 'Не збережено · Витрата' },
  unknown: { kind: 'unknown', amount: AMOUNT, state: 'Результат невідомий · Витрата' },
  armed: { kind: 'armed', amount: '320,00', state: 'Збережеться після чека · Витрата' },
  armed2: { kind: 'armed', amount: AMOUNT, state: 'Збережеться після чека · Витрата' },
  inflight: {
    kind: 'inflight',
    amount: AMOUNT,
    state: 'Зберігаємо… · Витрата',
    ic: 'loader-circle',
  },
  failed2: { kind: 'failed', amount: '86,40', state: 'Не збережено · Витрата' },
}
// A pinned row is never a primary (foundation §7.5): a tonal «Відкрити»; the tone marks failed / unknown.
const TONE = { failed: 'var(--destructive)', unknown: 'var(--warning)' }
// No icon tile on the phone row: «Результат невідомий · Витрата» must fit one line at 375 beside «Відкрити».
const draftRow = ({ kind, amount, state }) => {
  const t = TONE[kind]
  const mix = (p) => (t ? `color-mix(in oklch, ${t} ${p}%, transparent)` : '')
  return `<div style="padding:0 16px 8px"><div class="row" style="gap:10px;min-height:64px;padding:8px 8px 8px 14px;border-radius:14px;background:var(--card);border:1px solid ${t ? mix(40) : 'var(--border)'};box-shadow:inset 2px 0 0 ${t || 'var(--muted-fg)'}"><span class="grow col" style="gap:2px;min-width:0"><span class="t-body num" style="font-weight:600;white-space:nowrap">${amount} USD</span><span class="t-foot muted trunc">${state}</span></span><a class="btn sm secondary" href="#" aria-label="Відкрити чернетку ${amount} USD" style="height:44px;padding:0 12px;${t ? `background:${mix(18)};border-color:${mix(45)}` : ''}">Відкрити</a></div></div>`
}
// The slot precedence (unknown > failed > in flight > armed) orders the rows; at most two show.
const RANK = { unknown: 0, failed: 1, inflight: 2, armed: 3 }
const byRank = (drafts) => [...drafts].sort((a, b) => RANK[a.kind] - RANK[b.kind])
const chernetok = (n) => (n === 1 ? 'чернетка' : n < 5 ? 'чернетки' : 'чернеток')
/** The pinned rows block: up to three rows, unresolved first; from four on, two plus «Ще N чернеток · Показати» (N ≥ 2). */
export const pinnedRows = (drafts) => {
  const sorted = byRank(drafts)
  const shown = sorted.length > 3 ? 2 : sorted.length
  const more = sorted.length - shown
  const moreRow =
    more > 0
      ? `<div style="padding:0 16px 8px"><button type="button" class="row" aria-expanded="false" style="width:100%;justify-content:space-between;min-height:44px;padding:0 14px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font:inherit;font-size:15px;color:var(--fg);cursor:pointer"><span class="num">Ще ${more} ${chernetok(more)}</span><span style="color:var(--primary);font-weight:600">Показати</span></button></div>`
      : ''
  return `<div style="padding-bottom:4px">${sorted.slice(0, shown).map(draftRow).join('')}${moreRow}</div>`
}
const pinDrafts = (drafts) => {
  const body = financeBody()
  const rows = pinnedRows(drafts)
  const k = body.indexOf('<div class="sechead"')
  return k < 0 ? rows + body : body.slice(0, k) + rows + body.slice(k)
}

/** The kept draft, pinned at the top of the Фінанси list when reached another way. */
export const listrowDraft = (w, h) => draftFab(financeTab(w, h, '', pinDrafts([DRAFT.failed])))

/** One failed + one armed draft: the failed one wins the pill (unknown > failed > in flight > armed > saved); both are pinned. */
export const draftsTwo = (w, h) =>
  draftFab(financeTab(w, h, moneyPill(w, 'failed'), pinDrafts([DRAFT.armed, DRAFT.failed])))

/**
 * Two unresolved drafts and an armed one: the pill names the count and opens Фінанси at the pinned rows;
 * the FAB dot carries it. Up to three rows show, so all three are here (unresolved first).
 */
export const draftsTwoUnresolved = (w, h) =>
  draftFab(
    financeTab(
      w,
      h,
      moneyPill(w, 'drafts'),
      pinDrafts([DRAFT.failed2, DRAFT.unknown, DRAFT.armed]),
    ),
    2,
  )

/** Four drafts: two rows (unresolved first) and «Ще 2 чернетки · Показати», collapsed. */
export const draftsFourCollapsed = (w, h) =>
  draftFab(
    financeTab(
      w,
      h,
      moneyPill(w, 'drafts'),
      pinDrafts([DRAFT.armed, DRAFT.failed2, DRAFT.inflight, DRAFT.unknown]),
    ),
    2,
  )

/** Any «+» menu shows at most 2 draft rows (unresolved first). */
const menuDraftRows = (drafts) => byRank(drafts).slice(0, 2).map(draftRow).join('')
/**
 * The «Чернетки» header; from 3 drafts it gains a trailing text button «Усі чернетки (N)» (opens Фінанси at the
 * pinned rows). Its 44 px hit area comes from padding cancelled by a negative margin, so it adds no height.
 */
const menuDraftHead = (drafts) => {
  const open = drafts.filter((d) => d.kind === 'failed' || d.kind === 'unknown').length
  const all =
    drafts.length > 2
      ? `<a href="#" class="num" style="padding:13px 8px;margin:-13px -8px;font-size:13px;font-weight:600;color:var(--primary);text-decoration:none;white-space:nowrap">Усі чернетки (${drafts.length})</a>`
      : ''
  const label = all ? 'Чернетки' : `Чернетки · ${open} потребують перевірки`
  return `<div class="row" style="justify-content:space-between;gap:12px;padding:0 16px 8px"><span class="t-over">${label}</span>${all}</div>`
}

/**
 * «+» with unresolved drafts off Фінанси (a quick-add FAB): the quick-add sheet keeps the role's actions; the
 * «Чернетки» section sits on top. A draft never hides other actions.
 * On Фінанси the FAB opens a new form directly. `base`: the tab screen behind the sheet.
 */
export function quickAddDrafts(w, h, base, drafts = [DRAFT.failed2, DRAFT.unknown]) {
  const rows = menuDraftRows(drafts)
  const acts = `<div class="group" role="group" aria-label="Дії" style="margin-top:8px">${quickAddRows('ADMIN')}</div>`
  const body = `${menuDraftHead(drafts)}${rows}${acts}`
  const listH = 52 + 26 + 2 * 72 + 8 + 4 * 64 + safeBottom(w) + 24
  const overlay = sheet({ w, h, top: h - listH, title: 'Створити', trail: closeBtn, body })
  return draftFab(overHome(base, overlay), 2, 'Створити')
}
