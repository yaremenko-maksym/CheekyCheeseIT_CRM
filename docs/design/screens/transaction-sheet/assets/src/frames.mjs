// Frame list for the transaction sheet. Each frame = { name, w, h, dpr, html }.
// Phone frames: 375 × 812 (320 × 568 for the narrow check) at 2×; tablet / desktop at 1×.
import * as T from './transaction-sheet.mjs'

const { txSheet, FOOT, page, icon, errAlert, infoCard, txnRow, TXNS, searchField, chips } = T

const size = (w) =>
  w === 320
    ? [320, 568]
    : w === 375
      ? [375, 812]
      : w === 768
        ? [768, 1024]
        : w === 1024
          ? [1024, 768]
          : w === 1000
            ? [1000, 768]
            : [1440, 900]
const frame = (name, w, html) => {
  const [fw, fh] = size(w)
  return {
    name: `${name}-${w}`,
    w: fw,
    h: fh,
    dpr: w < 640 ? 2 : 1,
    html: page(html, { width: fw }),
  }
}
/** A state config → frames at the given widths. */
const at = (name, widths, cfg) =>
  widths.map((w) => {
    const [fw, fh] = size(w)
    return frame(
      name,
      w,
      txSheet({
        role: 'ADMIN',
        kind: 'EXPENSE',
        cur: 'USD',
        title: 'Нова транзакція',
        ...cfg,
        w: fw,
        h: fh,
      }),
    )
  })
const BOTH = [375, 1440]
/** 320 drawn full length: a taller canvas than the 568 device, so the whole scrolled sheet is in one image. */
const tall = (name, fh, cfg) => {
  const html = txSheet({
    role: 'ADMIN',
    kind: 'EXPENSE',
    cur: 'USD',
    title: 'Нова транзакція',
    ...cfg,
    w: 320,
    h: fh,
  })
  return { name: `${name}-320`, w: 320, h: fh, dpr: 2, html: page(html, { width: 320 }) }
}

// ---------------------------------------------------------------- closed-sheet money lifecycle
// One model at every width (foundation §11): saving → saved | failed | unknown. The pill sits in the
// foundation slot (phone: above the tab bar, left of «+»; tablet / desktop: bottom-right, 24 px, 320 × 52);
// a failed / unknown draft is a pinned row at the top of the list and a dot on every «+». No toast.
// The saved row has no description, so its title is the EXPENSE category (rule: description → category → kind).
const OPT_ROW = {
  day: 'Сьогодні',
  t: 'Оплата послуги',
  s: 'Витрата · без проєкту',
  a: '−1 250,50 USD',
  time: '14:32',
  ic: 'receipt',
  neg: true,
  att: true,
}
// Foundation change request: amounts in the pill and the pinned row carry the sign of the kind.
const signed = (html) => html.replace(/(?<![−+])1 250,50 USD/g, '−1 250,50 USD')
// Status in --muted-fg (the meta line), never a dimmed row.
const optimisticRow = (x) =>
  txnRow({ ...x, tag: 'Зберігаємо…' }).replace('class="lrow two"', 'class="lrow two" aria-busy="true"')
const savedRow = (x) => txnRow(x)
function phoneList(rows, pinned = '') {
  const today = `<div class="sechead"><span class="t-over">Сьогодні</span></div><div class="group">${rows}${TXNS.filter(
    (r) => r.day === 'Сьогодні',
  )
    .slice(0, 2)
    .map((r) => txnRow(r))
    .join('')}</div>`
  return `${searchField('Пошук транзакцій')}${chips(['Усі', 'Витрати', 'Доходи', 'Проєкт ▾', 'Період ▾'])}${pinned}${today}`
}
/** The phone pill restyled into the tablet / desktop slot. */
const widePill = (kind) =>
  signed(T.moneyPill(375, kind)).replace(
    /position:absolute;left:12px;right:\d+px;bottom:\d+px;z-index:44;height:56px;border-radius:16px/,
    'position:absolute;right:24px;bottom:24px;z-index:80;width:320px;height:52px;border-radius:14px',
  )
const DOT =
  '<i aria-hidden="true" style="position:absolute;top:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:var(--destructive);box-shadow:0 0 0 2px var(--bg)"></i>'
const TONE = { failed: 'var(--destructive)', unknown: 'var(--warning)' }
const STATE = { failed: 'Не збережено · Витрата', unknown: 'Результат невідомий · Витрата' }
/** Desktop: the pinned draft is a 40 px full-width first row of the table (prims-viz draftsDesktop). */
const pinnedTr = (k) => {
  const mix = (p) => `color-mix(in oklch, ${TONE[k]} ${p}%, transparent)`
  return `<tr><td colspan="6" style="padding:0;max-width:none;background:${mix(7)};box-shadow:inset 2px 0 0 ${TONE[k]}"><div class="row" style="gap:10px;height:40px;padding:0 8px 0 12px"><span style="color:${TONE[k]};display:grid">${icon('file-pen', { size: 16 })}</span><span class="num" style="font-weight:600;white-space:nowrap">−1 250,50 USD</span><span class="grow muted trunc">${STATE[k]}</span><button type="button" class="btn sm secondary" aria-label="Відкрити чернетку −1 250,50 USD" style="height:28px;font-size:13px;padding:0 12px;background:${mix(18)};border-color:${mix(45)}">Відкрити</button></div></td></tr>`
}
const tr = (status) =>
  `<tr${status ? ' aria-busy="true"' : ''}><td class="num muted">11.11</td><td><span class="row" style="gap:8px"><span class="trunc">Оплата послуги</span>${status ? `<span class="pill" style="height:20px;font-size:11px;gap:4px;color:var(--muted-fg)">${icon('loader-circle', { size: 11 })}Зберігаємо…</span>` : ''}</span></td><td class="muted">Витрата</td><td class="muted trunc">—</td><td style="text-align:center" class="muted">${icon('paperclip', { size: 14 })}</td><td class="num" style="text-align:right;font-weight:600">−1 250,50 USD</td></tr>`
const STEP_PILL = { saving: 'inflight', saved: 'saved', failed: 'failed', unknown: 'unknown' }
const draft = (step) => step === 'failed' || step === 'unknown'

function closedState(step, w) {
  const pill = STEP_PILL[step]
  if (w < 640) {
    const row = step === 'saving' ? optimisticRow(OPT_ROW) : step === 'saved' ? savedRow(OPT_ROW) : ''
    const pinned = draft(step) ? signed(T.pinnedRows([T.DRAFT[step]])) : ''
    const html = T.tabScreen({
      w,
      h: 812,
      role: 'ADMIN',
      active: '/finance',
      title: 'Фінанси',
      body: phoneList(row, pinned),
      overlay: signed(T.moneyPill(w, pill)),
    })
    return draft(step) ? T.MF.draftFab(html) : html
  }
  if (w < 1024) {
    // Tablet 640–1023: one list pane; the pinned row sits above «Сьогодні», the dot on the rail «+».
    const row = step === 'saving' ? optimisticRow(OPT_ROW) : step === 'saved' ? savedRow(OPT_ROW) : ''
    const pinned = draft(step) ? signed(T.pinnedRows([T.DRAFT[step]])) : ''
    let html = T.tablet({ w, h: 1024, role: 'ADMIN', overlay: widePill(pill) })
      .replace('<div class="sechead"><span class="t-over">Сьогодні</span></div>', `${pinned}$&`)
      .replace('<div class="group" style="margin:0 12px">', `$&${row}`)
    if (draft(step))
      html = html.replace(
        /<div aria-label="Створити" style="(width:52px;height:52px;border-radius:16px;[^"]*)">([\s\S]*?)<\/div>/,
        `<div aria-label="Створити, 1 чернетка потребує уваги" style="position:relative;$1">$2${DOT}</div>`,
      )
    return html
  }
  const first = step === 'saving' ? tr(true) : step === 'saved' ? tr(false) : pinnedTr(step)
  let html = T.desktop({ w, h: 900, role: 'ADMIN', overlay: widePill(pill) })
    .replace('padding:20px 24px 24px;', 'padding:20px 24px 100px;')
    .replace('<tr aria-selected="true" style="background:var(--raised)">', '<tr>')
    .replace('<tbody>', `<tbody>${first}`)
  if (draft(step))
    html = html
      .replace(
        '<span class="btn primary" style="height:36px',
        '<span class="btn primary" aria-label="Нова транзакція, 1 чернетка потребує уваги" style="position:relative;height:36px',
      )
      .replace('C</span></span></header>', `C</span>${DOT}</span></header>`)
  return html
}

function listFrames() {
  const W3 = [375, 768, 1440]
  const name = { saving: 'optimistic-row', saved: 'saved', failed: 'rollback', unknown: 'unknown-closed' }
  return Object.keys(name).flatMap((step) => W3.map((w) => frame(name[step], w, closedState(step, w))))
}

// ---------------------------------------------------------------- confirm (dirty close)
function dirtyClose(w, h) {
  const base = txSheet({
    role: 'ADMIN',
    kind: 'EXPENSE',
    cur: 'USD',
    title: 'Нова транзакція',
    amount: '1 250,50',
    receipt: 'done',
    w,
    h,
  })
  const DC = {
    id: 'dc',
    title: 'Вийти без збереження?',
    desc: 'Сума −1 250,50 USD і чек не збережуться.',
    keep: 'Продовжити редагування',
    action: 'Вийти без збереження',
  }
  // Phone: the foundation action sheet, bottom at the safe-area inset + 8 (under the home indicator).
  if (w < 640)
    return append(base, T.MF.actionConfirm(w, { ...DC, cancel: DC.keep, overSheet: true }))
  return append(base, dialog(w, DC))
}
/**
 * Puts an overlay last inside the device, but under the home indicator when the device has one, so
 * an action sheet never covers it (the foundation's overHome).
 */
const append = (html, over) =>
  html.includes('<div class="homebar">')
    ? html.replace('<div class="homebar">', `${over}<div class="homebar">`)
    : html.replace(/<\/div>\s*$/, `${over}</div>`)
/** Tablet / desktop confirm: a 420 px centred dialog; 44 px buttons on a coarse pointer, 36 px on a fine one. */
function dialog(w, { id, title, desc, keep, action }) {
  const bh = w < 1024 ? 44 : 36
  return `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.55);z-index:95"></div><div role="alertdialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-d" style="position:absolute;z-index:96;left:50%;top:50%;transform:translate(-50%,-50%);width:420px;padding:24px;border-radius:var(--r-xl);background:var(--popover);border:1px solid var(--border)"><div id="${id}-t" class="t-head num">${title}</div><div id="${id}-d" class="t-sub muted num" style="margin-top:6px">${desc}</div><div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap"><span class="btn sm secondary" role="button" data-initial-focus style="height:${bh}px">${keep}</span><span class="btn sm" role="button" style="height:${bh}px;background:var(--destructive);color:#fff">${action}</span></div></div>`
}

// ---------------------------------------------------------------- discard a kept draft (asks first)
const DISCARD = {
  id: 'dd',
  title: 'Видалити чернетку −1 250,50 USD?',
  desc: 'Сума, поля й чек зникнуть. Цю дію не можна скасувати.',
  keep: 'Залишити',
  action: 'Видалити',
}
function confirmDiscard(w, h) {
  const base = txSheet({
    ...definite(),
    role: 'ADMIN',
    kind: 'EXPENSE',
    cur: 'USD',
    title: 'Нова транзакція',
    w,
    h,
  })
  const over =
    w < 640
      ? T.MF.actionConfirm(w, {
          ...DISCARD,
          cancel: DISCARD.keep,
          overSheet: true,
          focusCancel: true,
        })
      : dialog(w, DISCARD)
  return append(base, over)
}

// ---------------------------------------------------------------- kind picker
function kindPicker(w, h) {
  const opts = [
    ['EXPENSE', 'Витрата', 'arrow-up-right', 'Оренда, сервіси, збори'],
    ['ADMIN_INCOME', 'Дохід', 'arrow-down-left', 'Оплата від клієнта за проєкт'],
    ['SALARY', 'Зарплата', 'wallet', 'Частина зарплати співробітника'],
    ['ADMIN_TRANSFER', 'Переказ', 'arrow-left-right', 'Між адміністраторами'],
    ['DIVIDEND', 'Дивіденди', 'landmark', 'Виплата партнеру з рахунку компанії'],
  ]
  const row = ([, l, ic, sub], i) =>
    `<div class="lrow" role="option" aria-selected="${i === 0}" style="--inset:60px;min-height:56px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon(ic, { size: 18 })}</div><div class="grow col" style="gap:1px;min-width:0"><div class="t-body trunc" style="${i === 0 ? 'font-weight:600' : ''}">${l}</div><div class="t-foot muted trunc">${sub}</div></div>${i === 0 ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`
  const base = {
    role: 'ADMIN',
    kind: 'EXPENSE',
    cur: 'USD',
    title: 'Нова транзакція',
    amount: '1 250,50',
    receipt: 'done',
    w,
    h,
  }
  if (w < 640) {
    const body = `<div role="listbox" aria-label="Тип"><div class="group">${opts.map(row).join('')}</div></div>`
    const over = T.sheet({ w, h, top: Math.round(h * 0.42), title: 'Тип', trail: T.closeBtn, body })
    return txSheet({ ...base, over })
  }
  const box = (pos, wd, inner) =>
    `<div role="listbox" aria-label="Тип" style="position:absolute;z-index:80;${pos};width:${wd}px;padding:6px;border-radius:12px;background:oklch(0.22 0.004 85);border:1px solid var(--border);box-shadow:0 16px 40px oklch(0 0 0 / 0.5)">${inner}</div>`
  // Coarse pointer (tablet): the same popover, 56 px rows with the subtitle, no key hints.
  if (w < 1024)
    return txSheet({
      ...base,
      over: box(
        'right:40px;top:330px',
        320,
        `<div class="group" style="margin:0;background:none;border:0">${opts.map(row).join('')}</div>`,
      ),
    })
  const fine = opts
    .map(
      ([, l, ic], i) =>
        `<div role="option" aria-selected="${i === 0}" class="row" style="gap:10px;height:36px;padding:0 10px;border-radius:8px;font-size:14px;${i === 0 ? 'background:var(--raised)' : ''}"><span class="muted">${icon(ic, { size: 16 })}</span><span class="grow">${l}</span>${T.kbd(String(i + 1))}</div>`,
    )
    .join('')
  return txSheet({ ...base, over: box(`right:${480 - 300}px;top:330px`, 300, fine) })
}

// ---------------------------------------------------------------- cascade (admin edit)
// The first row is this transaction; every value is «<amount> <CODE>», never a bare «—».
function cascade({ blocked = false } = {}) {
  const rows = [
    ['Ця транзакція · Дохід', '1 200,00 USD', '1 250,50 USD'],
    blocked
      ? [
          'Частка · Адміністратор 1 (10%)',
          '120,00 USD',
          null,
          'err',
          'У заявці на виплату — суму не змінити',
        ]
      : ['Частка · Адміністратор 1 (10%)', '120,00 USD', '125,05 USD'],
    ['Частка · Адміністратор 2 (5%)', '60,00 USD', '62,53 USD'],
    [
      'Рахунок · клієнт «Бета»',
      '1 200,00 USD',
      null,
      'warn',
      'Не перерахується автоматично — потрібна ручна звірка',
    ],
  ]
  const item = ([t, from, to, tone, why]) => {
    const val = to
      ? `<span class="muted">${from} →</span> <b>${to}</b>`
      : `<b>${from}</b> <span class="muted">— залишиться без змін</span>`
    const cap = why
      ? `<span class="t-cap" style="color:var(--${tone === 'err' ? 'destructive' : 'warning'})">${why}</span>`
      : ''
    return `<div class="col" style="gap:2px;padding:10px 14px;border-top:1px solid var(--separator)"><span class="t-foot" style="font-weight:500">${t}</span><span class="num t-foot">${val}</span>${cap}</div>`
  }
  return `<div class="group" style="margin:0"><div class="row" style="min-height:40px;padding:0 14px"><span class="t-over">Що зміниться</span></div>${rows.map(item).join('')}</div>`
}
const ADMIN_EDIT = {
  title: 'Редагування',
  subtitle: 'Дохід · було +1 200,00 USD',
  edit: true,
  adminEdit: true,
  kind: 'ADMIN_INCOME',
  amount: '1 250,50',
  receipt: 'done',
  extra: cascade(),
  footer: (fine) => FOOT.save(fine, 'Зберегти зміни'),
}
const definite = () => ({
  amount: '1 250,50',
  receipt: 'done',
  lead: 'Згорнути',
  alert: errAlert(
    'Транзакцію не надіслано',
    'Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.',
  ),
  footer: FOOT.retry(),
})
/** Save unavailable (blocked, stale or loading preview): a flat muted fill, never a dimmed primary. */
const blockedSave = (fine, by = 'ab-e') =>
  `<span class="btn" role="button" aria-disabled="true" aria-describedby="${by}" style="width:100%;background:var(--muted);color:var(--muted-fg);box-shadow:none">Зберегти зміни${fine ? T.kbd('⌘↵') : ''}</span>`

export function frames() {
  const f = []
  // ---- main state: open, prefilled, receipt first (all five widths; 320 drawn full length)
  const main = { amount: '', focusAmount: false, receipt: 'empty' }
  f.push(tall('default', 1010, main))
  f.push(...at('default', [375, 768, 1024, 1440], main))

  // ---- key states
  f.push(
    ...at('receipt-uploading', BOTH, {
      amount: '1 250,50',
      receipt: 'uploading',
      footer: (fine) => FOOT.save(fine, 'Зберегти після завантаження чека'),
    }),
  )
  f.push(
    ...at('armed', [320, 375, 1440], {
      amount: '1 250,50',
      receipt: 'uploading',
      lead: 'Згорнути',
      footer: FOOT.armed(),
    }),
  )
  // The draft reopened from the in-flight pill: locked, lead «Згорнути», the spinner primary.
  f.push(
    ...at('inflight', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      lead: 'Згорнути',
      locked: true,
      footer: FOOT.inflight(),
    }),
  )
  f.push(...listFrames())
  // 422: the server named a field; reopening turns the draft back into an ordinary (dirty) form, so the
  // lead is «Скасувати» (it asks «Вийти без збереження?») and there is no «Видалити чернетку».
  f.push(
    ...at('error-422', [375, 768, 1440], {
      amount: '1 250,50',
      receipt: 'done',
      expanded: true,
      dateError: true,
      category: 0,
      lead: 'Скасувати',
      scroll: 120,
    }),
  )
  f.push(...at('error-definite', [320, 375, 1440], definite()))
  f.push(
    frame('confirm-discard', 375, confirmDiscard(375, 812)),
    frame('confirm-discard', 1440, confirmDiscard(1440, 900)),
  )
  f.push(
    ...at('unknown-resubmit', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      lead: 'Згорнути',
      locked: true,
      alert: errAlert(
        'Невідомо, чи збережено транзакцію',
        'Відповідь не надійшла. Надішліть ще раз: якщо транзакцію вже збережено, друга не з’явиться.',
        85,
      ),
      footer: FOOT.resubmit(),
    }),
  )
  f.push(
    ...at('loading', BOTH, {
      kind: 'ADMIN_INCOME',
      cur: 'UAH',
      amount: '52 000,00',
      receipt: 'done',
      loading: true,
      fxLoading: true,
    }),
  )
  const long = {
    cur: 'UAH',
    amount: '1 234 567,89',
    usdEq: '29 965,24',
    receipt: 'done',
    expanded: true,
    longProject: 'Проєкт «Платформа онлайн-навчання для корпоративних клієнтів»',
    note: 'Оренда офісу за листопад, включно з паркуванням і прибиранням',
  }
  f.push(tall('long-content', 1180, long))
  f.push(...at('long-content', BOTH, { ...long, scroll: 40 }))
  f.push(
    ...at('permission-limited', BOTH, {
      title: 'Транзакція',
      amount: '−1 800,00',
      kind: 'PAYOUT',
      readOnly: {
        sub: 'Виплата',
        rows: [
          ['Отримувач', 'Сеньйор 2'],
          ['Дата', '10 листопада 2026'],
          ['Проєкт', 'Проєкт «Альфа»'],
          ['Опис', 'Виплата частки за жовтень'],
        ],
      },
      banner: infoCard(
        'lock',
        'Транзакцію не можна редагувати: це виплата або вона прив’язана до заявки на виплату.',
        'var(--warning)',
      ),
      lead: 'Закрити',
      footer: '',
    }),
  )
  f.push(...[375, 768, 1440].map((w) => frame('dirty-close', w, dirtyClose(...size(w)))))

  // ---- kind and role variants
  f.push(...[375, 768, 1440].map((w) => frame('kind-picker', w, kindPicker(...size(w)))))
  f.push(
    ...at('admin-income-usdt', BOTH, {
      kind: 'ADMIN_INCOME',
      cur: 'USDT',
      curLocked: true,
      amount: '1 250,50',
      receipt: 'usdt-link',
    }),
  )
  f.push(
    ...at('admin-income-accountant', BOTH, {
      role: 'ACCOUNTANT',
      kind: 'ADMIN_INCOME',
      amount: '4 800,00',
      receipt: 'done',
    }),
  )
  f.push(
    ...at('expense-company', BOTH, {
      role: 'ACCOUNTANT',
      cur: 'USDT',
      amount: '86,40',
      receipt: 'usdt-link',
      category: 0,
      expanded: true,
      companyFunded: true,
      scroll: 60,
    }),
  )
  f.push(
    ...at('salary-part', BOTH, {
      role: 'ACCOUNTANT',
      kind: 'SALARY',
      title: 'Частина зарплати',
      amount: '500,00',
    }),
  )
  // ACCOUNTANT records either direction: both cards pick, a separate «Поміняти напрямок» swaps them.
  f.push(
    ...at('transfer', BOTH, {
      role: 'ACCOUNTANT',
      kind: 'ADMIN_TRANSFER',
      amount: '3 000,00',
      receipt: 'link',
    }),
  )
  // ADMIN sends only from their own account (API rule): the sender is fixed, only the receiver picks.
  f.push(
    ...at('transfer-admin', BOTH, {
      kind: 'ADMIN_TRANSFER',
      amount: '3 000,00',
      receipt: 'link',
    }),
  )
  f.push(
    ...at('dividend', BOTH, {
      kind: 'DIVIDEND',
      cur: 'USDT',
      curLocked: true,
      amount: '5 000,00',
      receipt: 'usdt-link',
    }),
  )
  f.push(
    ...at('senior-income', BOTH, {
      role: 'SENIOR',
      kind: 'SENIOR_INCOME',
      title: 'Новий дохід',
      amount: '2 400,00',
      receipt: 'uploading',
      footer: (fine) => FOOT.save(fine, 'Зберегти після завантаження чека'),
    }),
  )
  f.push(
    ...at('drop-income', BOTH, {
      role: 'DROP',
      kind: 'DROP_INCOME',
      title: 'Новий дохід',
      cur: 'USDT',
      amount: '900,00',
      receipt: 'usdt-link',
    }),
  )
  f.push(...at('admin-edit-cascade', [375, 768, 1440], ADMIN_EDIT))
  f.push(
    ...at('admin-edit-blocked', BOTH, {
      ...ADMIN_EDIT,
      extra: cascade({ blocked: true }),
      alert: errAlert(
        'Зберегти не можна',
        'По відмічених рядках суму не перерахувати — потрібне ручне рішення.',
      ).replace('role="alert"', 'role="alert" id="ab-e"'),
      footer: blockedSave,
    }),
  )
  // Admin edit always waits for the server (it recomputes the derivatives): locked, lead «Згорнути».
  f.push(
    ...at('admin-edit-saving', BOTH, {
      ...ADMIN_EDIT,
      lead: 'Згорнути',
      locked: true,
      footer: FOOT.inflight('Зберегти зміни'),
    }),
  )
  f.push(
    ...at('senior-edit-rejected', BOTH, {
      role: 'SENIOR',
      kind: 'SENIOR_INCOME',
      title: 'Виправити дохід',
      edit: true,
      amount: '2 400,00',
      receipt: 'done',
      banner: infoCard(
        'circle-x',
        'Дохід відхилено. Після збереження він знову піде на перевірку.',
        'var(--destructive)',
      ),
      footer: (fine) => FOOT.save(fine, 'Зберегти й надіслати'),
    }),
  )
  f.push(
    ...at('attach-receipt', BOTH, {
      role: 'SENIOR',
      kind: 'SENIOR_INCOME',
      title: 'Додати чек',
      edit: true,
      hideAmount: true,
      hideDefaults: true,
      receipt: 'uploading',
      banner: infoCard(
        'receipt',
        '<b class="num" style="font-weight:600">+2 400,00 USD</b> · Дохід · Проєкт «Альфа» · 14 листопада',
      ),
      footer: (fine) => FOOT.save(fine, 'Додати чек'),
    }),
  )
  return f
}
