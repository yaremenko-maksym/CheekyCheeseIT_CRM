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
  `<tr${status ? ' aria-busy="true"' : ''}><td class="num muted">17.11</td><td><span class="row" style="gap:8px"><span class="trunc">Оплата послуги</span>${status ? `<span class="pill" style="height:20px;font-size:11px;gap:4px;color:var(--muted-fg)">${icon('loader-circle', { size: 11 })}Зберігаємо…</span>` : ''}</span></td><td class="muted">Витрата</td><td class="muted trunc">—</td><td style="text-align:center" class="muted">${icon('paperclip', { size: 14 })}</td><td class="num" style="text-align:right;font-weight:600">−1 250,50 USD</td></tr>`
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
  if (w < 640) {
    const act = `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.4);z-index:95"></div><div role="alertdialog" aria-labelledby="dc-t" aria-describedby="dc-d" style="position:absolute;left:8px;right:8px;bottom:${T.safeBottom(w) + 8}px;z-index:96" class="col"><div style="border-radius:14px;background:oklch(0.24 0.004 85);overflow:hidden"><div style="padding:14px 16px;text-align:center"><div id="dc-t" style="font-size:13px;font-weight:600;color:var(--muted-fg)">Вийти без збереження?</div><div id="dc-d" class="t-foot muted num" style="margin-top:2px">Сума 1 250,50 USD і чек не збережуться.</div></div><div style="height:56px;display:grid;place-items:center;border-top:1px solid var(--separator);font-size:19px;color:var(--destructive)" role="button">Вийти без збереження</div></div><div style="margin-top:8px;height:56px;border-radius:14px;background:oklch(0.24 0.004 85);display:grid;place-items:center;font-size:19px;font-weight:600" role="button">Продовжити редагування</div></div>`
    return base.replace(/<\/div>\s*$/, `${act}</div>`)
  }
  const dlg = `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.55);z-index:95"></div><div role="alertdialog" aria-modal="true" aria-labelledby="dc-t" style="position:absolute;z-index:96;left:50%;top:50%;transform:translate(-50%,-50%);width:420px;padding:24px;border-radius:var(--r-xl);background:var(--popover);border:1px solid var(--border)"><div id="dc-t" class="t-head">Вийти без збереження?</div><div class="t-sub muted num" style="margin-top:6px">Сума 1 250,50 USD і чек не збережуться.</div><div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px">Продовжити редагування</span><span class="btn sm" style="height:36px;background:var(--destructive);color:#fff">Вийти без збереження</span></div></div>`
  return base.replace(/<\/div>\s*$/, `${dlg}</div>`)
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
  const row = ([k, l, ic, sub], i) =>
    `<div class="lrow" role="option" aria-selected="${i === 0}" style="--inset:60px;min-height:56px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon(ic, { size: 18 })}</div><div class="grow col" style="gap:1px;min-width:0"><div class="t-body trunc" style="${i === 0 ? 'font-weight:600' : ''}">${l}</div><div class="t-foot muted trunc">${sub}</div></div>${i === 0 ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`
  if (w < 640) {
    const body = `<div role="listbox" aria-label="Тип"><div class="group">${opts.map(row).join('')}</div></div>`
    const over = T.sheet({ w, h, top: Math.round(h * 0.42), title: 'Тип', trail: T.closeBtn, body })
    return txSheet({
      role: 'ADMIN',
      kind: 'EXPENSE',
      cur: 'USD',
      title: 'Нова транзакція',
      amount: '1 250,50',
      receipt: 'done',
      w,
      h,
      over,
    })
  }
  const pop = `<div role="listbox" aria-label="Тип" style="position:absolute;z-index:80;right:${480 - 300}px;top:330px;width:300px;padding:6px;border-radius:12px;background:oklch(0.22 0.004 85);border:1px solid var(--border);box-shadow:0 16px 40px oklch(0 0 0 / 0.5)">${opts
    .map(
      ([k, l, ic], i) =>
        `<div role="option" aria-selected="${i === 0}" class="row" style="gap:10px;height:36px;padding:0 10px;border-radius:8px;font-size:14px;${i === 0 ? 'background:var(--raised)' : ''}"><span class="muted">${icon(ic, { size: 16 })}</span><span class="grow">${l}</span>${T.kbd(String(i + 1))}</div>`,
    )
    .join('')}</div>`
  return txSheet({
    role: 'ADMIN',
    kind: 'EXPENSE',
    cur: 'USD',
    title: 'Нова транзакція',
    amount: '1 250,50',
    receipt: 'done',
    w,
    h,
    over: pop,
  })
}

// ---------------------------------------------------------------- cascade (admin edit)
function cascade(w) {
  const rows = [
    ['Частка · Адміністратор 1', '120,00', '125,05', false],
    ['Частка · Адміністратор 2', '60,00', '62,53', false],
    ['Рахунок · клієнт «Бета»', '1 200,00', '—', true],
  ]
  const item = ([t, from, to, blocked]) =>
    `<div class="row" style="gap:10px;min-height:52px;padding:6px 14px;border-top:1px solid var(--separator)"><div class="grow col" style="gap:1px;min-width:0"><span class="t-foot trunc" style="font-weight:500">${t}</span>${blocked ? `<span class="t-cap" style="color:var(--warning)">Не перерахується автоматично</span>` : ''}</div><span class="num t-foot" style="white-space:nowrap"><span class="muted">${from} →</span> <b>${to}</b></span></div>`
  return `<div class="group" style="margin:0"><div class="row" style="min-height:40px;padding:0 14px"><span class="t-over">Що зміниться</span></div>${rows.map(item).join('')}</div>`
}

export function frames() {
  const f = []
  // ---- main state: open, prefilled, receipt first (all five widths)
  const main = { amount: '', focusAmount: false, receipt: 'empty' }
  f.push(...at('default', [320, 375, 768, 1024, 1440], main))

  // ---- key states
  f.push(...at('receipt-uploading', BOTH, { amount: '1 250,50', receipt: 'uploading' }))
  f.push(
    ...at('armed', BOTH, {
      amount: '1 250,50',
      receipt: 'uploading',
      lead: 'Згорнути',
      footer: FOOT.armed(),
    }),
  )
  f.push(
    ...at('inflight', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      locked: true,
      lockedText: 'Зберігаємо… · змінити не можна',
      footer: FOOT.inflight(),
    }),
  )
  f.push(...listFrames())
  f.push(
    ...at('error-422', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      expanded: true,
      dateError: true,
      lead: 'Згорнути',
      footer: (fine) => FOOT.save(fine) + T.discardBtn,
      scroll: 120,
    }),
  )
  f.push(
    ...at('error-definite', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      lead: 'Згорнути',
      alert: errAlert(
        'Транзакцію не надіслано',
        'Немає з’єднання. Нічого не збережено; сума й чек залишились у формі.',
      ),
      footer: FOOT.retry(),
    }),
  )
  f.push(
    ...at('unknown-resubmit', BOTH, {
      amount: '1 250,50',
      receipt: 'done',
      lead: 'Згорнути',
      locked: true,
      alert: errAlert(
        'Невідомо, чи транзакцію збережено',
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
  f.push(
    ...at('long-content', BOTH, {
      cur: 'UAH',
      amount: '1 234 567,89',
      usdEq: '29 965,24',
      receipt: 'done',
      expanded: true,
      longProject: 'Проєкт «Платформа онлайн-навчання для корпоративних клієнтів»',
      note: 'Оренда офісу за листопад, включно з паркуванням і прибиранням',
      scroll: 40,
    }),
  )
  f.push(
    ...at('permission-limited', BOTH, {
      title: 'Транзакція',
      edit: true,
      amount: '2 150,00',
      kind: 'SALARY',
      locked: true,
      lockedText: 'Лише перегляд',
      banner: infoCard(
        'lock',
        'Транзакцію не можна редагувати: це виплата або вона прив’язана до заявки на виплату.',
        'var(--warning)',
      ),
      hideDefaults: true,
      lead: 'Закрити',
      footer: '',
    }),
  )
  f.push(
    frame('dirty-close', 375, dirtyClose(375, 812)),
    frame('dirty-close', 1440, dirtyClose(1440, 900)),
  )

  // ---- kind and role variants
  f.push(
    frame('kind-picker', 375, kindPicker(375, 812)),
    frame('kind-picker', 1440, kindPicker(1440, 900)),
  )
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
  f.push(
    ...at('transfer', BOTH, {
      role: 'ACCOUNTANT',
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
  f.push(
    ...at('admin-edit-cascade', BOTH, {
      title: 'Редагування',
      edit: true,
      kind: 'ADMIN_INCOME',
      amount: '1 250,50',
      receipt: 'done',
      extra: cascade(),
      hideDefaults: true,
      footer: (fine) => FOOT.save(fine, 'Зберегти зміни'),
      scroll: 90,
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
