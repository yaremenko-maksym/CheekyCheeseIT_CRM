// Task 1.3 — the receipt-first transaction sheet (design-gate: degraded, HTML prototypes).
// Built only from the `_foundation` mockup library; nothing here is product code. Sample data is invented.
// Usage: see render.mjs in this directory.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const F = join(dirname(fileURLToPath(import.meta.url)), '../../../_foundation/assets/src')
const imp = (f) => import(pathToFileURL(join(F, f)).href)

const { icon, page, field, segmented, currencyPill, safeBottom } = await imp('base.mjs')
const { tabScreen, financeBody, txnRow, TXNS, searchField, chips, txnList } =
  await imp('mobile.mjs')
const { sheet, safeTop, closeBtn } = await imp('mobile-overlays.mjs')
const MF = await imp('money-form.mjs')
const { checkDialog } = await imp('prims-viz.mjs')
const { receiptCard, thumb, ring, submitBar, primaryBtn, armedBtn, errAlert, discardBtn } = MF
const { decimalPad, DECIMAL_H, moneyPill, pinnedRows, DRAFT } = MF

/**
 * The foundation's tablet() / desktop() frames hard-code the ADMIN shell. For the role variants this
 * imports a copy with `role` as a parameter (default unchanged); the foundation files stay untouched.
 */
async function withRole(file) {
  const src = readFileSync(join(F, file), 'utf8')
  const out = src
    .replace(/from '\.\/([\w-]+\.mjs)'/g, (_, f) => `from '${pathToFileURL(join(F, f)).href}'`)
    .replace(/\n\}\) \{\n {2}const role = 'ADMIN'\n/, "\n  role = 'ADMIN',\n}) {\n")
  if (!out.includes("  role = 'ADMIN',\n}) {"))
    throw new Error(`withRole: pattern not found in ${file}`)
  const tmp = join(mkdtempSync(join(tmpdir(), 'tsheet-')), file)
  writeFileSync(tmp, out)
  return import(pathToFileURL(tmp).href)
}
const { tablet } = await withRole('tablet.mjs')
const { desktop } = await withRole('desktop.mjs')

/** A substitution that throws when the pattern is absent, so a foundation change cannot silently skip it. */
export const must = (html, a, b) => {
  if (!html.includes(a)) throw new Error(`must: not found: ${a.slice(0, 80)}`)
  return html.split(a).join(b)
}

const SR =
  'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
const chev = `<span class="muted">${icon('chevron-down', { size: 18 })}</span>`
const sk = (wd = 120, h = 14) =>
  `<span aria-hidden="true" style="display:inline-block;width:${wd}px;height:${h}px;border-radius:6px;background:oklch(0.3 0.004 85)"></span>`
const kbd = (k, onPrimary = false) =>
  `<span class="kbdkey"${onPrimary ? ' style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)"' : ''}>${k}</span>`

export const KIND = {
  EXPENSE: 'Витрата',
  ADMIN_INCOME: 'Дохід',
  SALARY: 'Зарплата',
  ADMIN_TRANSFER: 'Переказ',
  DIVIDEND: 'Дивіденди',
  SENIOR_INCOME: 'Дохід',
  DROP_INCOME: 'Дохід',
}
/** Kinds per role — unchanged from today's `availableTypes`. */
export const KINDS = {
  ADMIN: ['EXPENSE', 'ADMIN_INCOME', 'SALARY', 'ADMIN_TRANSFER', 'DIVIDEND'],
  ACCOUNTANT: ['EXPENSE', 'ADMIN_INCOME', 'SALARY', 'ADMIN_TRANSFER'],
  SENIOR: ['SENIOR_INCOME'],
  DROP: ['DROP_INCOME'],
}

// ---------------------------------------------------------------- form blocks
/** A picker field (opens a PickerSheet on touch, a listbox popover on a fine pointer). */
const pick = (id, label, value, { err = '', hint = '', loading = false, lead = '' } = {}) =>
  field({
    id,
    label,
    value: loading ? sk(140) : value,
    ph: 'Оберіть',
    tag: 'button',
    state: err ? 'error' : '',
    err,
    hint,
    lead,
    suffix: loading ? '' : chev,
    attrs: `aria-haspopup="listbox"${loading ? ' aria-busy="true"' : ''}`,
  })

/** The kind control: one pill, prefilled with the last kind used on this device. Single-kind roles get none. */
const kindPill = (kind, { locked = false } = {}) =>
  `<span class="pill" role="button" aria-haspopup="listbox" aria-label="Тип: ${KIND[kind]}"${locked ? ' aria-disabled="true"' : ''} style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font-weight:600;gap:6px">${KIND[kind]} ${icon('chevron-down', { size: 15 })}</span>`

const lockedCur = (c) =>
  `<span class="pill" aria-label="Валюта: ${c}, змінити не можна" style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font-weight:600;gap:6px;opacity:.75">${c} ${icon('lock', { size: 14 })}</span>`

function amountSection(c) {
  const amount = c.amount ?? ''
  const fs = amount.length > 9 ? 34 : 44
  const shown = amount
    ? amount
    : `<span style="color:oklch(0.5 0 0)">0,00</span>${c.focusAmount ? '<span class="caret" style="height:40px"></span>' : ''}`
  const multi = (KINDS[c.role] ?? []).length > 1 && !c.edit
  const cur = c.curLocked ? lockedCur(c.cur) : currencyPill(c.cur)
  const fx =
    c.cur === 'UAH' || c.cur === 'EUR'
      ? `<div class="t-foot muted num" style="margin-top:8px">${c.fxLoading ? `Курс НБУ ${sk(110, 12)}` : `Курс НБУ на 11.11: <span style="white-space:nowrap">1 USD = 41,20 UAH</span> · <span style="white-space:nowrap">≈ ${c.usdEq ?? '30,35'} USD</span>`}</div>`
      : ''
  const note = c.amountNote
    ? `<div class="t-foot muted" style="margin-top:8px">${icon('lock', { size: 13 })} ${c.amountNote}</div>`
    : ''
  const err = c.amountErr
    ? `<div class="hint err" id="amt-e" style="justify-content:center">${icon('circle-alert', { size: 15 })}<span>${c.amountErr}</span></div>`
    : ''
  return `<div style="padding:14px 0 2px;text-align:center"><label class="t-foot muted" for="amt">Сума</label>
    <div id="amt" role="textbox" inputmode="decimal" aria-label="Сума" ${c.amountErr ? 'aria-invalid="true" aria-describedby="amt-e"' : ''} class="num" style="font-size:${fs}px;line-height:52px;font-weight:700;letter-spacing:-0.03em;margin-top:2px;white-space:nowrap">${shown}</div>${err}
    <div class="row" style="justify-content:center;flex-wrap:wrap;gap:8px;margin-top:10px">${cur}${multi ? kindPill(c.kind, { locked: c.locked }) : ''}</div>${fx}${note}</div>`
}

const infoCard = (ic, html, tone = 'var(--muted-fg)') =>
  `<div class="row" style="gap:10px;align-items:flex-start;padding:12px 14px;border-radius:14px;background:var(--card);border:1px solid var(--border)"><span style="color:${tone};margin-top:1px">${icon(ic, { size: 18 })}</span><div class="grow t-foot" style="color:oklch(0.86 0 0)">${html}</div></div>`

/** EXPENSE category: free text (today's `ExpenseCategoryField`); the chips only fill the field. */
export const CATEGORY_HINTS = ['Оплата послуги', 'Банківський збір', 'Інше']
function categoryField(c) {
  const on = c.category ?? -1
  const input = field({
    id: 'ct',
    label: 'Категорія',
    value: on >= 0 ? CATEGORY_HINTS[on] : '',
    ph: 'Категорія витрати',
    attrs: 'role="textbox" aria-describedby="ct-s"',
  })
  const chips = CATEGORY_HINTS.map(
    (x, i) =>
      `<button type="button" class="pill" style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font:inherit;color:inherit;${i === on ? 'background:var(--raised);border-color:var(--fg)' : ''}">${x}</button>`,
  ).join('')
  return `<div class="col" style="gap:8px">${input}<div id="ct-s" class="row" role="group" aria-label="Підказки категорії" style="gap:8px;flex-wrap:wrap">${chips}</div></div>`
}

/** Read-only label + value list (permission-limited): no inputs, no chevrons, values at --fg. */
export function readOnlyList(rows) {
  return `<dl class="group" style="margin:0">${rows
    .map(
      ([k, v], i) =>
        `<div class="row" style="gap:12px;min-height:48px;padding:6px 14px;align-items:flex-start;${i ? 'border-top:1px solid var(--separator)' : ''}"><dt class="t-foot muted" style="flex:none;width:96px;padding-top:7px">${k}</dt><dd class="grow num" style="margin:0;padding-top:5px;color:var(--fg);font-size:15px;overflow-wrap:anywhere">${v}</dd></div>`,
    )
    .join('')}</dl>`
}

/** A text field that grows with its content: a textbox with aria-multiline, capped at 6 lines (then it scrolls). */
export const multiline = (html, id) =>
  must(
    must(
      html,
      `class="input " id="${id}"`,
      `class="input" id="${id}" role="textbox" aria-multiline="true" style="height:auto;min-height:48px;padding-top:12px;padding-bottom:12px;align-items:flex-start"`,
    ),
    '<span class="grow trunc ',
    '<span style="white-space:normal;overflow-wrap:anywhere;line-height:22px;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden" class="grow ',
  )
/** The segmented control below 360: each label wraps inside its own padding. */
const wrapSeg = (html) =>
  html
    .replaceAll('style="height:44px;display:grid', 'style="min-height:44px;display:grid')
    .replaceAll(
      'height:36px;padding:0 12px;border-radius:18px;display:grid;place-items:center;font-size:14px;font-weight:600;white-space:nowrap;',
      'min-height:36px;padding:2px 12px;border-radius:18px;display:grid;place-items:center;font-size:14px;font-weight:600;line-height:16px;text-align:center;',
    )

/** Required fields that belong to the kind; they sit right under the amount. */
function kindBlock(c) {
  const L = c.loading
  switch (c.kind) {
    case 'ADMIN_INCOME': {
      const project = pick('pr', 'Проєкт', c.project ?? 'Проєкт «Альфа»', { loading: L })
      const recv =
        c.role === 'ACCOUNTANT'
          ? `<div class="field"><label>Рахунок отримувача</label>${segmented(['Власник проєкту', 'Рахунок компанії'], 0)}</div>`
          : pick('rv', 'Рахунок отримувача', c.receiver ?? 'Адміністратор 1', {
              loading: L,
              hint:
                c.receiver === 'Рахунок компанії' ? 'Баланс рахунку компанії: 18 420,00 USDT' : '',
            })
      const obligation =
        c.cur === 'USDT' && !L
          ? infoCard(
              'scale',
              `<b style="font-weight:600">Після збереження</b><br>Адміністратор 1 — буде створено частку <b class="num">125,05 USDT</b> (10%, джерело: проєкт)<br>Адміністратор 2 — буде створено частку <b class="num">62,53 USDT</b> (5%, джерело: проєкт)`,
            )
          : ''
      return project + recv + obligation
    }
    case 'SENIOR_INCOME':
    case 'DROP_INCOME':
      return pick('pr', 'Проєкт', c.project ?? 'Проєкт «Альфа»', {
        loading: L,
        hint: c.kind === 'DROP_INCOME' ? 'Дохід очікуватиме валідації' : '',
      })
    case 'EXPENSE':
      return categoryField(c)
    case 'ADMIN_TRANSFER': {
      // A card is a picker trigger (chevron) unless it is fixed: an ADMIN always sends from their own account.
      const card = (who, verb, fixed = false) =>
        `<${fixed ? 'div' : 'button type="button" aria-haspopup="listbox"'} aria-label="${verb}: ${who}" class="grow row" style="gap:6px;min-height:64px;padding:10px 10px 10px 12px;border-radius:14px;background:var(--card);border:1px solid var(--border);min-width:0;text-align:left;font:inherit;color:inherit"><span class="grow col" style="gap:2px;min-width:0"><span class="t-foot muted">${verb}</span><span class="t-sub trunc" style="font-weight:600">${who}</span></span>${fixed ? '' : chev}</${fixed ? 'div' : 'button'}>`
      // Stacked at every width (names never truncate); the → is static, it does not swap.
      const arrow = `<span aria-hidden="true" class="muted" style="flex:none;height:20px;display:grid;place-items:center">${icon('arrow-down', { size: 18 })}</span>`
      const acc = c.role === 'ACCOUNTANT'
      const swap = acc
        ? `<button type="button" class="btn ghost" style="height:44px;align-self:flex-start;padding:0 12px;font-size:15px;font-weight:500;gap:8px">${icon('arrow-left-right', { size: 18 })}Поміняти напрямок</button>`
        : ''
      const from = acc
        ? card('Адміністратор 1', 'надсилає')
        : card('Ви · Адміністратор 1', 'надсилає', true)
      return `<div class="field"><label>Напрямок переказу</label><div class="col" style="gap:4px;align-items:stretch">${from}${arrow}${card('Адміністратор 2', 'отримує')}</div>${swap}</div>`
    }
    case 'DIVIDEND':
      return (
        pick('pt', 'Отримувач (партнер)', c.partner ?? 'Адміністратор 2', { loading: L }) +
        infoCard(
          'landmark',
          `Баланс рахунку компанії: <b class="num">18 420,00 USDT</b>. Сума не може його перевищувати.`,
        )
      )
    case 'SALARY': {
      const part = (m, a, how) =>
        `<div class="row" style="justify-content:space-between;gap:12px;min-height:44px;padding:0 14px;border-top:1px solid var(--separator)"><span class="t-foot">${m} · <span class="muted">${how}</span></span><span class="num t-foot" style="font-weight:600">${a}</span></div>`
      return `${pick('em', 'Співробітник', c.employee ?? 'Розробник 4', { loading: L })}${pick('mo', 'Місяць', 'Листопад 2026', { lead: `<span class="muted">${icon('calendar', { size: 18 })}</span>` })}
      <div class="group" style="margin:0"><div class="row" style="min-height:40px;padding:0 14px"><span class="t-over">Уже внесено за листопад</span></div>${part('05.11', '1 000,00 USD', 'Внесено вручну')}${part('10.11', '650,00 USD', 'Внесено автоматично')}</div>
      ${infoCard('info', 'Чек для зарплати додається під час виплати.')}`
    }
    default:
      return ''
  }
}

const URL_ATTRS =
  'type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"'
const usdtLink = (value) =>
  field({
    id: 'rl',
    label: 'Посилання на транзакцію в блокчейн-експлорері',
    value,
    ph: 'https://tronscan.org/#/transaction/…',
    hint: 'Чек для USDT — лише посилання на транзакцію',
    lead: `<span class="muted">${icon('link', { size: 18 })}</span>`,
    attrs: URL_ATTRS,
  })

/** Receipt first. SALARY has none (it is attached at pay time); USDT takes an explorer link only. */
function receiptSection(c) {
  if (c.kind === 'SALARY') return ''
  if (c.cur === 'USDT' && c.receipt === 'usdt-link')
    return usdtLink('https://tronscan.org/#/transaction/7f3a…c21e')
  const card = receiptCard(c.receipt ?? 'empty', { narrow: c.w < 360, cur: c.cur })
    .replaceAll('10 МБ', '10\u00a0МБ')
    .replaceAll('220 КБ', '220\u00a0КБ')
  return card.includes('Завантаження · 62%')
    ? must(
        card,
        'trunc" aria-hidden="true">Завантаження · 62%',
        '" aria-hidden="true">Завантаження · <span style="white-space:nowrap">62%</span>',
      )
    : card
}

/** Optional fields, collapsed into one line that states what will be saved. */
function defaults(c) {
  // Collapsed: the line wraps only between items (each item is nowrap); «змінити» is its own 44 × 44 target.
  const items = [
    'Сьогодні',
    c.note ? `«${c.note}»` : 'без опису',
    ...(c.kind === 'EXPENSE' && c.companyFunded ? ['Рахунок компанії'] : []),
  ]
  const line = items
    .map(
      (x, i) =>
        `<span style="${x.startsWith('«') ? 'max-width:100%;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' : 'white-space:nowrap'}">${x}${i < items.length - 1 ? ' ·' : ''}</span>`,
    )
    .join(' ')
  if (!c.expanded)
    return `<div class="row" style="justify-content:center;column-gap:6px;row-gap:0;min-height:44px;font-size:15px;flex-wrap:wrap;align-items:center"><span class="muted" style="display:grid">${icon('calendar', { size: 16 })}</span>${line}<button type="button" aria-expanded="false" aria-controls="opt" style="appearance:none;border:0;background:none;font:inherit;min-width:44px;min-height:44px;padding:0 4px;color:var(--primary);font-weight:600">змінити</button></div>`
  const date = field({
    id: 'dt',
    label: 'Дата',
    value: c.dateError ? '14 листопада 2026' : 'Сьогодні, 11 листопада',
    state: c.dateError ? 'error focus' : '',
    // Today's catalog: api-error.FINANCE_TX_DATE_IN_FUTURE (the foundation's «Жовтень уже закрито» is invented).
    err: c.dateError ? 'Для виконаної операції дата не може бути в майбутньому' : '',
    lead: `<span class="muted">${icon('calendar', { size: 18 })}</span>`,
  })
  const funding =
    c.kind === 'EXPENSE'
      ? `<div class="field"><label>Джерело коштів</label>${c.w < 360 ? wrapSeg(segmented(['Звичайна витрата', 'Рахунок компанії'], c.companyFunded ? 1 : 0)) : segmented(['Звичайна витрата', 'Рахунок компанії'], c.companyFunded ? 1 : 0)}${c.companyFunded ? '<div class="hint">Списується з рахунку компанії (USDT) <span style="white-space:nowrap">· баланс 18 420,00 USDT</span></div>' : ''}</div>`
      : ''
  const note = multiline(
    field({
      id: 'n',
      label: 'Опис',
      value: c.note ?? '',
      ph: 'Необов’язково',
      tag: 'div',
    }),
    'n',
  )
  return `<div id="opt" class="col" style="gap:16px">${date}${funding}${note}</div>`
}

/**
 * Admin edit's own fields after «Що зміниться»: today's TxDateField (+ «Причина зміни дати» once the
 * day changes) and Примітки. c.dateMove: 'near' (7 Nov, reason optional) | 'far' (2 Oct, past the
 * 31-day window) | 'far-error' (the server's FINANCE_TX_DATE_EDIT_REASON_REQUIRED, field focused).
 */
function adminEditFields(c) {
  const moved = c.dateMove ?? ''
  const date = field({
    id: 'ed',
    label: 'Дата транзакції',
    value: moved === 'near' ? '7 листопада 2026' : moved ? '2 жовтня 2026' : '11 листопада 2026',
    lead: `<span class="muted">${icon('calendar', { size: 18 })}</span>`,
  })
  const reason = moved
    ? field({
        id: 'er',
        label: 'Причина зміни дати',
        value: '',
        ph: 'Для дат давніших за 31 день',
        state: moved === 'far-error' ? 'error focus' : moved === 'far' ? 'focus' : '',
        err:
          moved === 'far-error'
            ? 'Дата надто далеко в минулому — вкажіть причину в полі «Причина зміни дати»'
            : '',
      })
    : ''
  const notes = multiline(
    field({
      id: 'en',
      label: 'Примітки',
      value: c.note ?? '',
      ph: 'Додаткова інформація…',
    }),
    'en',
  )
  return `<div class="col" style="gap:16px">${date}${reason}${notes}</div>`
}

const lockedNote = (t = 'Надіслано 11 листопада о 14:32 · змінити не можна') =>
  `<div class="t-foot row num" style="gap:6px;justify-content:center;color:var(--fg)">${icon('lock', { size: 14 })}<span style="text-align:center">${t
    .split(' · ')
    .map((p) => `<span style="white-space:nowrap">${p}</span>`)
    .join(' · ')}</span></div>`

/** The sign the list row uses: − for money out, + for incomes, none for a transfer between admins. */
export const signOf = (kind) =>
  kind.endsWith('INCOME') ? '+' : kind === 'ADMIN_TRANSFER' ? '' : '−'

/**
 * A sent (locked) draft is a record, not a disabled form (M12): the values exactly as sent, at full
 * contrast, with an absolute date; no inputs, no chevrons, no «змінити».
 */
function record(c) {
  const file = `<span class="row" style="gap:8px">${thumb(28)}<span>receipt-office-nov.jpg</span></span>`
  const rows =
    c.recordRows ??
    (c.adminEdit
      ? [
          ['Дата', '11 листопада 2026'],
          ['Примітки', 'Без приміток'],
          ['Чек', file],
        ]
      : [
          ['Категорія', 'Оплата послуги'],
          ['Дата', '11 листопада 2026'],
          ['Опис', 'Без опису'],
          ['Чек', file],
        ])
  const sub = c.subtitle ?? KIND[c.kind]
  const head = `<div style="padding:6px 0 0;text-align:center"><div class="num" style="font-size:40px;line-height:48px;font-weight:700;letter-spacing:-0.03em;color:var(--fg);white-space:nowrap">${signOf(c.kind)}${c.amount} ${c.cur}</div><div class="t-foot num" style="margin-top:4px;color:var(--fg)">${sub}</div></div>`
  return `${head}${readOnlyList(rows)}`
}

/** The form body: alert, receipt, amount (+ currency + kind), kind fields, optional fields. */
export function formBody(c) {
  if (c.readOnly) {
    // permission-limited: nothing is editable, so nothing looks like a control.
    const head = `<div style="padding:10px 0 4px;text-align:center"><div class="num" style="font-size:40px;line-height:48px;font-weight:700;letter-spacing:-0.03em;color:var(--fg)">${c.amount} ${c.cur}</div><div class="t-foot" style="margin-top:4px;color:var(--fg)">${c.readOnly.sub}</div></div>`
    return `<div class="col" style="gap:14px;padding:${c.pad}">${c.banner ?? ''}${head}${readOnlyList(c.readOnly.rows)}</div>`
  }
  if (c.locked)
    return `<div class="col" style="gap:14px;padding:${c.pad};transform:translateY(-${c.scroll ?? 0}px)">${c.banner ?? ''}${c.alert ?? ''}${lockedNote(c.lockedText)}${record(c)}${c.extra ?? ''}</div>`
  const sub = c.subtitle
    ? `<div class="t-foot muted num" style="text-align:center;margin-bottom:-4px">${c.subtitle}</div>`
    : ''
  // Admin edit = today's AdminEditTransactionDialog field set: no project, no receiver, no kind.
  const kindFields = c.adminEdit ? (c.kind === 'EXPENSE' ? categoryField(c) : '') : kindBlock(c)
  // Admin edit keeps today's receipt field only for ADMIN_INCOME, SENIOR_INCOME and EXPENSE.
  const receipt =
    c.adminEdit && !['ADMIN_INCOME', 'SENIOR_INCOME', 'EXPENSE'].includes(c.kind)
      ? ''
      : receiptSection(c)
  const parts = [
    sub,
    c.banner ?? '',
    c.alert ?? '',
    c.kind === 'SALARY' ? kindBlock(c) : c.hideReceipt ? '' : receipt,
    c.hideAmount ? '' : amountSection(c),
    c.kind === 'SALARY' ? '' : (c.kindFields ?? kindFields),
    c.extra ?? '',
    c.adminEdit ? adminEditFields(c) : c.hideDefaults ? '' : defaults(c),
    c.after ?? '',
  ].join('')
  return `<div class="col" style="gap:14px;padding:${c.pad};transform:translateY(-${c.scroll ?? 0}px)">${parts}</div>`
}

// ---------------------------------------------------------------- footers
const spinner = `<span style="display:grid;animation:none">${icon('loader-circle', { size: 16 })}</span>`
export const FOOT = {
  save: (fine, label = 'Зберегти') =>
    `<span class="btn primary" role="button" style="width:100%">${label}${fine ? kbd('⌘↵', true) : ''}</span>`,
  inflight: (label = 'Зберігаємо…') =>
    `<span class="btn primary" role="button" aria-disabled="true" aria-describedby="if-st" style="width:100%">${spinner}${label}</span><span id="if-st" role="status" style="${SR}">Зберігаємо</span>`,
  // Foundation change request: «після завантаження чека» (the council's copy), not «після чека».
  // The amount is signed (M11): «Збережеться −1 250,50 USD після завантаження чека».
  armed: (amount = '−1 250,50') =>
    armedBtn({ amount, cur: 'USD' }).replaceAll('після чека', 'після завантаження чека'),
  retry: () => primaryBtn('Повторити збереження', 'rotate-cw') + discardBtn,
  resubmit: () => primaryBtn('Надіслати ще раз', 'send') + discardBtn,
  plain: (label) => primaryBtn(label),
}

// ---------------------------------------------------------------- containers
const panelWidth = (w) => (w >= 1440 ? 480 : w >= 1024 ? 420 : 400)

/** Phone: ResponsiveSheet at full height over the role's Фінанси tab. */
export function phoneSheet(c) {
  const { w, h } = c
  const kbdH = c.keyboard ? DECIMAL_H : 0
  // < 360: a text lead squeezes the title, so it becomes an icon button with the same accessible name.
  const lead =
    w < 360
      ? `<span aria-label="${c.lead ?? 'Скасувати'}" style="display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center">${icon(c.lead === 'Згорнути' ? 'chevron-down' : 'x', { size: 22 })}</span>`
      : `<span style="font-size:17px">${c.lead ?? 'Скасувати'}</span>`
  const body = formBody({ ...c, pad: c.pad ?? '4px 16px 160px' })
  const bar = c.footer ? submitBar({ w, kbdH, inner: c.footer }) : ''
  const narrow =
    w < 360
      ? '<style>.sheethead{grid-template-columns:minmax(52px,1fr) minmax(0,max-content) minmax(52px,1fr)}</style>'
      : ''
  const overlay = `${narrow}${sheet({ w, h, top: c.top ?? safeTop(w) + 10, title: c.title, lead, trail: c.trail ?? '', body, footer: bar })}${c.keyboard ? decimalPad() : ''}${c.over ?? ''}`
  return tabScreen({
    w,
    h,
    role: c.role,
    active: '/finance',
    title: 'Фінанси',
    body: c.listBody ?? financeBody(c.role),
    overlay,
    showFab: false,
  })
}

/** Tablet / desktop: the same body in a right side panel. Modal below 1440, non-modal at ≥ 1440. */
export function widePanel(c) {
  const { w, h } = c
  const pw = panelWidth(w)
  const fine = w >= 1024
  const modal = w < 1440
  // ≥ 1440 is non-modal: no scrim, and the list reflows beside the panel instead of sitting under it.
  const scrim = modal
    ? '<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:60"></div>'
    : `<style>.device > main{margin-right:${pw}px}</style>`
  const aside = `${scrim}<aside role="dialog" ${modal ? 'aria-modal="true" ' : ''}aria-labelledby="tp-t" style="position:absolute;top:0;right:0;bottom:0;width:${pw}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 8px;border-bottom:1px solid var(--border)"><button type="button" class="btn ghost" style="height:44px;font-size:16px;font-weight:400;padding:0 12px">${c.lead ?? 'Скасувати'}${fine ? ` ${kbd('Esc')}` : ''}</button><div id="tp-t" class="grow t-head" style="padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.title}</div></div>
  <div class="grow" style="min-height:0;overflow:hidden">${formBody({ ...c, w: pw, pad: '12px 24px 24px' }).replace('Камера, фото або файл', fine ? 'Перетягніть файл сюди або оберіть' : 'Камера, фото або файл')}</div>
  ${c.footer ? `<div style="padding:12px 24px 20px;border-top:1px solid var(--border)">${typeof c.footer === 'function' ? c.footer(fine) : c.footer}</div>` : ''}</aside>${c.over ?? ''}`
  const html = shellFixtures(
    c,
    w >= 1024
      ? desktop({ w, h, role: c.role, overlay: aside, content: c.content ?? '' })
      : tablet({ w, h, role: c.role, overlay: aside, list: c.list ?? roleList(c.role) }),
  )
  return modal ? html : reflow(html)
}

/** ≥ 1440 beside the panel: no «Проєкт» column, the title yields, «Сума» and the amount never clip. */
const reflow = (html) =>
  must(
    html.replace(
      /<th style="[^"]*"><span style="display:inline-flex;align-items:center;gap:4px">Проєкт<\/span><\/th>/,
      '',
    ),
    '</style>',
    'td:last-child,th:last-child{max-width:none;overflow:visible;text-overflow:clip}</style>',
  ).replace(/<td class="muted trunc">[^<]*<\/td>/g, '')

/**
 * Fixture pass over the foundation shells: no personal name (the profile card becomes a role label) and a
 * no-break space between a number and its unit in the background panes too (R3-04).
 */
export const anon = (html) =>
  html
    .replaceAll('Віктор Кравець', 'Адміністратор 1')
    .replaceAll('>ВК</div>', '>А1</div>')
    .replace(/(\d) ([МК]Б)/g, '$1\u00a0$2')

const ROLE_UA = { ADMIN: 'Адміністратор', ACCOUNTANT: 'Бухгалтер', SENIOR: 'Сеньйор', DROP: 'Дроп' }
const wideRole = (role) => !['ADMIN', 'ACCOUNTANT'].includes(role)
/** Tablet list for a role that sees only its own rows (the foundation tablet list is the ADMIN one). */
const roleList = (role) =>
  wideRole(role)
    ? `<section aria-label="Транзакції" class="col" style="width:360px;flex:none;border-right:1px solid var(--border)"><div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Фінанси</div></div><div style="flex:1;min-height:0;overflow:hidden">${financeBody(role)}</div></section>`
    : ''
/**
 * M13 fixtures on the foundation shells: the profile card names the viewer's role; SENIOR and DROP see
 * only income rows; behind an edit the highlighted row is the edited income, behind a create none is.
 */
function shellFixtures(c, html) {
  let out = html.replace(
    '<div class="t-cap muted">Адміністратор</div>',
    `<div class="t-cap muted">${ROLE_UA[c.role] ?? 'Адміністратор'}</div>`,
  )
  if (wideRole(c.role))
    out = out.replace(
      /<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<td class="muted">(?!Дохід<)[^<]*<\/td>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g,
      '',
    )
  if (c.edit && !wideRole(c.role))
    out = out
      .replace(
        '<span class="trunc">Оренда офісу</span>',
        '<span class="trunc">Оплата від клієнта</span>',
      )
      .replace('<td class="muted">Витрата</td>', '<td class="muted">Дохід</td>')
      .replace('−1 200,00 USD', c.rowAmount ?? '+1 200,00 USD')
  else if (c.edit)
    // The selected row (an expense) was filtered out: select the first income row, the edited one.
    out = out
      .replace(
        '<tr ><td class="num muted">11.11</td>',
        '<tr aria-selected="true" style="background:var(--raised)"><td class="num muted">11.11</td>',
      )
      .replace('<td class="muted trunc">Бета</td>', '<td class="muted trunc">Альфа</td>')
      .replace('+4 800,00 USD', c.rowAmount ?? '+2 400,00 USD')
  else out = out.replace('<tr aria-selected="true" style="background:var(--raised)">', '<tr>')
  return out
}

/** One state, drawn for any width: phone sheet below 640, side panel above. */
export function txSheet(c) {
  const footer =
    typeof c.footer === 'function' ? c.footer(c.w >= 1024) : (c.footer ?? FOOT.save(c.w >= 1024))
  return c.w < 640 ? phoneSheet({ ...c, footer }) : widePanel({ ...c, footer })
}

export { page, icon, field, segmented, sheet, closeBtn, safeTop, safeBottom, tabScreen }
export { financeBody, txnRow, TXNS, searchField, chips, txnList, desktop, tablet }
export { moneyPill, pinnedRows, DRAFT, errAlert, discardBtn, primaryBtn, thumb, ring, kbd, sk, SR }
export { infoCard, pick, chev, MF, checkDialog }
