// Users screen — form bodies shared by the phone sheet, the tablet panel and the desktop side panel.
// One body per step; the container (sheet / panel) only changes the frame around it. Sample data is invented.
// The person created in the wizard (Дарина Ярошенко) is deliberately not in the list fixtures (M15).
import { icon, field, segmented, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { errAlert } from '../../../_foundation/assets/src/money-form.mjs'

// ---------- small pieces ----------
const chevDown = `<span class="muted">${icon('chevron-down', { size: 18 })}</span>`
const unit = (t) => `<span class="muted num" style="font-size:16px;padding-left:8px">${t}</span>`
/** Picker field = a button with the value and a chevron; opens the PickerSheet (same as prims-mobile `pickerField`). */
export const pickerField = (
  id,
  label,
  value,
  { hint = '', state = '', ph = '', locked = false, describedby = 'lock-r' } = {},
) =>
  field({
    id,
    label,
    value,
    ph,
    hint,
    state,
    suffix: locked ? lockIc : chevDown,
    tag: locked ? 'div' : 'button',
    attrs: locked
      ? `aria-readonly="true" aria-describedby="${describedby}" style="background:var(--bg);color:var(--muted-fg)"`
      : 'aria-haspopup="dialog"',
  })

const KB = {
  name: 'autocomplete="name" autocapitalize="words" enterkeyhint="next"',
  email:
    'type="email" inputmode="email" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"',
  tel: 'type="tel" inputmode="tel" autocomplete="off" enterkeyhint="next"',
  num: 'inputmode="decimal" enterkeyhint="next"',
}
const lockIc = `<span class="muted">${icon('lock', { size: 16 })}</span>`
const RO = 'readonly aria-describedby="lock-r" style="background:var(--bg);color:var(--muted-fg)"'
/** M2: a field the PATCH cannot carry, read-only once the create POST is sent. */
const lockedField = (o) => field({ ...o, suffix: lockIc, attrs: `${o.attrs ?? ''} ${RO}` })

export const secTitle = (t, first = false) =>
  `<div class="t-over" style="margin-top:${first ? 0 : 8}px">${t}</div>`

/** Selected people inside a multi-select field: removable 32 px chips (each chip's × is a 44 px hit area). */
const personChips = (names) =>
  `<div class="row" style="gap:8px;flex-wrap:wrap">${names
    .map(
      (n) =>
        `<span class="row" style="gap:2px;height:32px;padding:0 0 0 12px;border-radius:16px;background:var(--surface);border:1px solid var(--border);font-size:15px">${n}<span role="button" aria-label="Прибрати ${n}" style="width:44px;height:44px;margin:-6px -6px -6px -8px;display:grid;place-items:center;color:var(--muted-fg)">${icon('x', { size: 15 })}</span></span>`,
    )
    .join('')}</div>`

export const note = (text, ic = 'info', id = '') =>
  `<div${id ? ` id="${id}"` : ''} class="row t-foot" style="gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)"><span class="muted" style="margin-top:1px">${icon(ic, { size: 16 })}</span><span class="grow">${text}</span></div>`

export const okNote = (text) =>
  `<div role="status" class="row t-foot" style="gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:oklch(0.2 0.04 150);border:1px solid oklch(0.36 0.08 150)"><span style="color:var(--positive);margin-top:1px">${icon('circle-check', { size: 16 })}</span><span class="grow">${text}</span></div>`

/** M2 reason line, shown once on the step that holds locked fields. */
export const lockNote = note(
  'Запит на створення вже надіслано, тому email, роль і команду тут не змінити. Потрібен інший email — закрийте форму й створіть нового користувача.',
  'lock',
  'lock-r',
)

// ---------- stepper (no foundation primitive: overline + title + thin bars; see spec "Open points") ----------
// N4: three steps up to the POST; «Контракт» is a post-create screen, not a step of the stepper.
export const STEPS = ['Особа', 'Роль і команда', 'Виплати']
export const DROP_STEPS = STEPS
export function stepper(n, steps = STEPS) {
  const bars = steps
    .map(
      (_, i) =>
        `<i style="flex:1;height:4px;border-radius:2px;background:${i < n ? 'var(--primary)' : 'var(--surface)'};${i < n ? '' : 'outline:1px solid var(--border);outline-offset:-1px'}"></i>`,
    )
    .join('')
  return `<div role="group" aria-label="Крок ${n} з ${steps.length}: ${steps[n - 1]}" style="padding:2px 0 6px"><div class="t-foot muted num" style="font-weight:500">Крок ${n} з ${steps.length}</div><div class="t-head" style="margin-top:2px">${steps[n - 1]}</div><div class="row" aria-hidden="true" style="gap:4px;margin-top:10px">${bars}</div></div>`
}

/** Scroll body of a step; bottom padding clears the sticky action bar. */
export const formBody = (inner, { w = 375, pad = 16, bar = true } = {}) =>
  `<div class="col" style="gap:16px;padding:4px ${pad}px ${bar ? 60 + safeBottom(w) + 24 : 24}px">${inner}</div>`

// ---------- step bodies ----------
export const NEW = {
  name: 'Дарина Ярошенко',
  email: 'darina.yaroshenko@example.com',
  other: 'darina.s@example.com',
  legal: 'Ярошенко Дарина Ігорівна',
}
export function stepIdentity({
  emailErr = false,
  focus = 'email',
  locked = false,
  alert = '',
} = {}) {
  const email = {
    id: 'ue',
    label: 'Email',
    value: NEW.email,
    state: emailErr ? 'error' : focus === 'email' && !locked ? 'focus' : '',
    err: emailErr ? 'Цей email уже зайнятий. Введіть інший' : '',
    attrs: KB.email,
  }
  const personal = {
    id: 'up',
    label: 'Особистий email (необов’язково)',
    ph: 'name@example.com',
    hint: 'На цю адресу одразу піде запрошення. Увійти з цією адресою співробітник зможе лише після її підтвердження.',
    attrs: KB.email,
  }
  const lang = locked
    ? `<div class="field"><label class="row" style="gap:6px">Мова інтерфейсу${lockIc}</label>${segmented(['Українська', 'English'], 0, { size: 15 }).replace('role="radiogroup"', 'role="radiogroup" aria-readonly="true" aria-describedby="lock-r" style="opacity:0.6"')}</div>`
    : `<div class="field"><label>Мова інтерфейсу</label>${segmented(['Українська', 'English'], 0, { size: 15 })}<div class="hint">Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.</div></div>`
  return [
    alert,
    locked ? lockNote : '',
    field({ id: 'un', label: 'Ім’я та прізвище', value: NEW.name, attrs: KB.name }),
    locked ? lockedField(email) : field(email),
    locked ? lockedField({ ...personal, hint: '' }) : field(personal),
    lang,
    secTitle('Контакти'),
    field({ id: 'ut', label: 'Telegram', ph: '@username', attrs: KB.email }),
    field({ id: 'uph', label: 'Телефон', ph: '+380', attrs: KB.tel }),
  ].join('')
}

const techField = (tags = ['React', 'TypeScript']) =>
  `<div class="field"><label>Технології</label><div class="input" style="height:auto;min-height:48px;padding:6px 12px;flex-wrap:wrap;gap:6px">${tags
    .map((t) => `<span class="pill" style="height:28px;font-size:14px">${t}</span>`)
    .join(
      '',
    )}<span class="ph" style="font-size:16px">Почніть вводити: React, Node.js…</span></div></div>`

const hrField = `<div class="field"><label>HR</label>${personChips(['Ірина Мельник'])}<button type="button" class="btn ghost" style="justify-content:flex-start;height:44px;padding:0;color:var(--primary);font-weight:500">${icon('plus', { size: 18 })}Додати HR</button></div>`
const channel = (locked) =>
  (locked ? lockedField : field)({
    id: 'udc',
    label: 'Telegram-канал команди',
    ph: 'https://t.me/…',
    hint: locked ? '' : 'Необов’язково. Канал для спілкування команди.',
  })

export function stepRole(role = 'SENIOR', { locked = false } = {}) {
  const roleF = pickerField(
    'ur',
    'Роль',
    { SENIOR: 'Сеньйор', JUNIOR: 'Джуніор', DROP: 'Дроп' }[role],
    { locked },
  )
  const head = [locked ? lockNote : '', roleF]
  if (role === 'JUNIOR')
    return [
      ...head,
      secTitle('Команда'),
      pickerField('uj', 'Проєкт', '', {
        ph: 'Без проєкту',
        hint: locked ? '' : 'Можна прикріпити пізніше в розділі «Проєкти»',
        locked,
      }),
      secTitle('Професія'),
      techField(['JavaScript']),
    ].join('')
  if (role === 'DROP')
    return [
      ...head,
      secTitle('Команда дропа'),
      hrField,
      pickerField('uda', 'Бухгалтер (необов’язково)', '', { ph: 'Не обрано' }),
      channel(locked),
      secTitle('Професія'),
      techField(['Python']),
    ].join('')
  const type = locked
    ? `<div class="field"><label class="row" style="gap:6px">Тип команди${lockIc}</label>${segmented(['Своя команда', 'Команда дропа'], 0, { size: 15 }).replace('role="radiogroup"', 'role="radiogroup" aria-readonly="true" aria-describedby="lock-r" style="opacity:0.6"')}</div>`
    : `<div class="field"><label>Тип команди</label>${segmented(['Своя команда', 'Команда дропа'], 0, { size: 15 })}<div class="hint">Нова команда сеньйора. Оберіть склад нижче.</div></div>`
  return [
    ...head,
    secTitle('Команда'),
    type,
    hrField,
    pickerField('usa', 'Бухгалтер', 'Марія Петренко'),
    channel(locked),
    secTitle('Професія'),
    techField(),
  ].join('')
}

const contractFields = (legal = '', address = '') => [
  secTitle('Дані для контракту', true),
  field({
    id: 'ul',
    label: 'Юридичне ПІБ',
    value: legal,
    ph: 'Прізвище Ім’я По батькові',
    hint: 'Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.',
    attrs: KB.name,
  }),
  field({
    id: 'ua',
    label: 'Адреса реєстрації (ФОП)',
    value: address,
    ph: 'Місто, вулиця, будинок',
    hint: 'Ця адреса підставляється в текст контракту',
  }),
]
const walletFields = (wallet = '') => [
  field({
    id: 'uw',
    label: 'Гаманець USDT (ERC-20)',
    value: wallet,
    ph: '0x…',
    attrs: 'autocapitalize="none" autocorrect="off" spellcheck="false"',
  }),
  field({ id: 'uwl', label: 'Мітка гаманця (необов’язково)', ph: 'Наприклад, основний' }),
]
const fopFields = (name = NEW.legal, iban = '', tin = '') => [
  field({ id: 'uf', label: 'ПІБ отримувача (ФОП)', value: name }),
  field({
    id: 'uib',
    label: 'IBAN',
    value: iban,
    ph: 'UA00 0000 0000 0000 0000 0000 000',
    attrs: 'autocapitalize="characters" autocorrect="off" spellcheck="false"',
  }),
  field({ id: 'ui', label: 'РНОКПП', value: tin, ph: '10 цифр', attrs: 'inputmode="numeric"' }),
  field({ id: 'ub', label: 'Банк (необов’язково)', ph: 'Назва банку' }),
]
const method = (i) =>
  `<div class="field"><label>Спосіб виплати</label>${segmented(['USDT ERC-20', 'ФОП (UAH)'], i, { size: 15 })}<div class="hint">${i ? 'Використовуватиметься український банківський рахунок ФОП.' : 'Використовуватиметься адреса гаманця в мережі Ethereum.'}</div></div>`
/** «Місячна зарплата»: Сума + Валюта; «≈ … USD» only when the currency is not USD (as today). */
const salary = (amount = '48 000', cur = 'UAH', approx = '≈ 1 160 USD') =>
  `<div class="field" style="gap:8px"><label>Місячна зарплата</label><div class="row" style="gap:12px;align-items:flex-start"><div class="grow">${field({ id: 'us', label: 'Сума', value: amount, suffix: unit(cur), attrs: KB.num })}</div><div style="width:38%">${pickerField('uc', 'Валюта', cur)}</div></div>${cur === 'USD' ? '' : `<div class="hint num">${approx}</div>`}</div>`
/** N1: today's ShareSlider (split bar company | role, range input, number input), then the hint, then (edit only) the pending-share notice. */
export function shareField(role, value, { pending = null, ro = false } = {}) {
  const drop = role === 'DROP'
  const side = drop ? 'дропа' : 'сеньйора'
  const label = drop ? 'Частка дропа (%)' : 'Частка сеньйора (%)'
  const co = 100 - value
  const cell = (pc, txt, bg, ink) =>
    `<div style="width:${pc}%;display:grid;place-items:center;overflow:hidden;white-space:nowrap;background:${bg};color:${ink};font-size:11px;font-weight:600">${pc >= 12 ? txt : pc >= 4 ? `${pc}%` : ''}</div>`
  const bar = `<div aria-hidden="true" style="display:flex;height:28px;border-radius:8px;overflow:hidden">${cell(co, `${co}% компанії`, 'var(--yellow-subtle)', 'var(--primary)')}${cell(value, `${value}% ${side}`, 'oklch(0.24 0.05 150)', 'var(--positive)')}</div>`
  const min = drop ? 0 : 1
  const pos = ((value - min) / (100 - min)) * 100
  const slider = `<div role="slider" aria-label="Частка ${side} у відсотках" aria-valuemin="${min}" aria-valuemax="100" aria-valuenow="${value}" style="flex:1;min-width:0;height:44px;position:relative${ro ? ';opacity:0.6' : ''}"><i style="position:absolute;left:0;right:0;top:20px;height:4px;border-radius:2px;background:var(--surface);outline:1px solid var(--border);outline-offset:-1px"></i><i style="position:absolute;left:0;width:${pos}%;top:20px;height:4px;border-radius:2px;background:var(--primary)"></i><i style="position:absolute;left:calc(${pos}% - ${(pos * 0.22).toFixed(1)}px);top:11px;width:22px;height:22px;border-radius:11px;background:var(--primary);box-shadow:0 0 0 3px var(--bg)"></i></div>`
  const num = `<div class="input num" style="width:84px;flex:none;height:44px;padding:0 12px;justify-content:space-between${ro ? ';color:var(--muted-fg);background:var(--bg)' : ''}"><span>${value}</span><span class="muted">%</span></div>`
  const hint = drop
    ? `<div class="hint">Скільки дроп залишає собі з кожної виплати. За замовчуванням 5%</div>`
    : `<div class="hint">Те, що сеньйор залишає собі. Нове значення набуде чинності після підтвердження сеньйора.</div>`
  const notice = pending
    ? note(
        `Запропоновано <b style="font-weight:600;color:var(--fg)">${pending.percent}%</b>. Підтверджує ${pending.approver}. Нове значення замінить пропозицію.`,
        'hourglass',
      ) +
      `<span class="btn secondary" role="button" style="height:44px;font-size:15px;align-self:flex-start">Скасувати пропозицію</span>`
    : ''
  return `<div class="field"><label>${label}</label>${bar}<div class="row" style="gap:12px">${slider}${num}</div>${hint}${notice}</div>`
}

/** N8: values of the post-submit frames — every required field of the role is filled. */
const FILLED = {
  address: 'Львів, вул. Зелена, 10',
  wallet: '0x71C7…9a3F',
  iban: 'UA21 3223 1300 0002 6007 2335 6600 1',
  tin: '3012345678',
}

/** filled: a frame drawn after the POST shows every required field of the role filled (N8). */
export function stepPay(role = 'SENIOR', { alert = '', filled = false } = {}) {
  const f = filled
    ? { legal: NEW.legal, ...FILLED }
    : { legal: '', address: '', wallet: '', iban: '', tin: '' }
  if (role === 'JUNIOR')
    return [
      alert,
      ...contractFields(f.legal, f.address),
      secTitle('Фінанси'),
      salary(),
      secTitle('Реквізити для виплат'),
      method(1),
      ...fopFields(NEW.legal, f.iban, f.tin),
    ].join('')
  if (role === 'DROP')
    return [
      alert,
      ...contractFields(f.legal, f.address),
      secTitle('Фінанси'),
      shareField('DROP', 5),
      secTitle('Реквізити для виплат'),
      method(0),
      ...walletFields(f.wallet),
    ].join('')
  return [
    alert,
    ...contractFields(f.legal, f.address),
    secTitle('Фінанси'),
    shareField('SENIOR', 26),
    secTitle('Реквізити для виплат'),
    note(
      'Для ролі «Сеньйор» доступні лише виплати в USDT <span style="white-space:nowrap">ERC-20</span>.',
    ),
    ...walletFields(f.wallet),
  ].join('')
}

// ---------- create alerts (§2.5) ----------
export const unknownAlert = errAlert(
  'Невідомо, чи користувача створено',
  'Відповідь не надійшла. Введене залишилось у формі. «Спробувати ще раз» спершу перевірить, чи користувача вже створено.',
  85,
).replace('role="alert"', 'role="alert" tabindex="-1"')
export const failAlert = errAlert(
  'Не вдалося створити користувача',
  'Сервер відхилив запит. Нічого не створено — введене залишилось у формі.',
).replace('role="alert"', 'role="alert" tabindex="-1"')
/** 409 under M2 + N7: the email is locked, so the primary of the state is «Почати з іншим email»; «Створити користувача» stays aria-disabled and points at this alert. */
export const conflictAlert = errAlert(
  'Цей email уже зайнятий',
  `${NEW.email}: запит на створення вже надіслано, тому тут email не змінити. Єдиний вихід — «Почати з іншим email».`,
).replace('role="alert"', 'role="alert" id="cf-r" tabindex="-1"')
/** M3: a refetched row with this email but createdAt before the first submit is not ours → the same 409 state. */
export const olderAlert = errAlert(
  'Цей email уже зайнятий',
  'Його має користувач, створений раніше. Єдиний вихід — «Почати з іншим email».',
).replace('role="alert"', 'role="alert" id="cf-r" tabindex="-1"')
/** N7 bar: primary «Почати з іншим email», then the disabled «Створити користувача» with its reason. */
export const conflictBar = (create = 'Створити користувача') =>
  `<span class="btn primary" role="button" style="width:100%">Почати з іншим email</span><span class="btn secondary" role="button" aria-disabled="true" aria-describedby="cf-r" style="width:100%;margin-top:8px;opacity:0.45">${create}</span>`
export const contractFailAlert = errAlert(
  'Не вдалося зберегти контракт',
  'Текст залишився в редакторі. Спробуйте ще раз.',
).replace('role="alert"', 'role="alert" tabindex="-1"')

// ---------- result screen + contract (N4) ----------
const DRAFT_NOTE = 'Контракт можна додати зараз або пізніше з профілю користувача.'
/**
 * N4 result screen after the POST: «Користувача створено», what exists, «Готово» (+ «Додати контракт»).
 * none: no active template for the role → «Готово» only and today's sentence.
 */
export function stepResult({ none = false, role = 'Сеньйор' } = {}) {
  const row = (k, v, wrap = false) =>
    `<div class="lrow" style="min-height:48px;align-items:flex-start;padding-top:12px;padding-bottom:12px"><div class="t-body muted" style="flex:none;width:96px">${k}</div><span class="grow t-body" style="text-align:right;min-width:0;${wrap ? 'overflow-wrap:anywhere' : ''}">${v}</span></div>`
  const head = `<div class="row" style="gap:10px;padding:2px 0 6px"><span style="color:var(--positive)">${icon('circle-check', { size: 24 })}</span><div class="t-head" role="status">Користувача створено</div></div>`
  const tail = none
    ? note(
        'Контракт не створено (немає активного шаблону для ролі). Його можна додати пізніше через профіль користувача.',
        'file-x',
      )
    : `<div class="t-foot muted">${DRAFT_NOTE}</div>`
  return `${head}<div class="group" style="margin:0">${row('Ім’я', NEW.name)}${row('Роль', role)}${row('Email', NEW.email, true)}${row('Контракт', 'Не додано')}</div>${tail}`
}

/**
 * Contract step (the merged old «Контракт» + «Підтвердження»): the role's template in the TextEditor primitive.
 * Two endings: «Зберегти чернетку» (save the text, close) and «Позначити готовим до підписання» (save, then POST /ready).
 * saving: fields read-only, both aria-disabled (N3). failed: alert, text stays in the editor.
 */
export function stepContract({ saving = false, failed = false } = {}) {
  const tok = (t) =>
    `<span style="background:var(--yellow-subtle);color:var(--primary);border-radius:4px;padding:0 3px">{{${t}}}</span>`
  const text = `<p style="margin:0 0 10px;font-weight:600">ДОГОВІР ПРО НАДАННЯ ПОСЛУГ № ${tok('number')}</p>
  <p style="margin:0 0 10px">${tok('city')}, ${tok('date')}</p>
  <p style="margin:0 0 10px">Фізична особа-підприємець ${tok('legalName')}, що зареєстрована за адресою ${tok('registrationAddress')}, надалі «Виконавець», з однієї сторони, та Замовник, з іншої сторони, уклали цей договір про таке.</p>
  <p style="margin:0">1. Предмет договору. Виконавець надає послуги з розробки програмного забезпечення…</p>`
  const head = `<div class="row" style="gap:10px;padding:2px 0 6px"><span style="color:var(--positive)">${icon('circle-check', { size: 20 })}</span><div class="t-head">Контракт</div></div>`
  return `${head}${failed ? contractFailAlert : ''}<div class="field"><label for="ce">Текст контракту</label><div id="ce" role="textbox" aria-multiline="true"${saving ? ' aria-readonly="true"' : ''} style="padding:12px 14px;border-radius:12px;background:${saving ? 'var(--bg)' : 'var(--surface)'};border:1px solid var(--input-border);font-size:15px;line-height:22px;max-height:320px;overflow:hidden${saving ? ';color:var(--muted-fg)' : ''}">${text}</div><div class="hint">Поля в {{дужках}} заповняться з профілю користувача.</div></div>
  <div class="t-foot muted">«Готовий до підписання» — контракт піде на підпис. Чернетку можна доробити пізніше в профілі.</div>`
}

// ---------- action bars ----------
/** N3: while a request is in flight every field is read-only: what is shown is what was sent. */
export const ro = (html) =>
  `<style>.rodim .input{background:var(--bg)!important;color:var(--muted-fg)}.rodim .caret{display:none}</style><div class="rodim col" style="gap:16px" aria-busy="true">${html}</div>`
export const spin = `<span aria-hidden="true" style="width:18px;height:18px;border-radius:9px;border:2px solid oklch(0 0 0 / 0.25);border-top-color:var(--primary-fg)"></span>`
export function actions({
  back = false,
  primary = 'Далі',
  pending = false,
  secondary = '',
  secondaryOff = false,
  stack = false,
} = {}) {
  const p = `<span class="btn primary${pending ? ' pend' : ''}" role="button"${pending ? ' aria-disabled="true"' : ''} style="${stack ? 'width:100%' : 'flex:2;min-width:0'}">${pending ? spin : ''}${primary}</span>`
  const b = back
    ? `<span class="btn secondary" role="button" style="${stack ? 'width:100%' : 'flex:1;min-width:0'}"${pending ? ' aria-disabled="true"' : ''}>Назад</span>`
    : ''
  const s = secondary
    ? `<span class="btn ghost" role="button"${secondaryOff ? ' aria-disabled="true"' : ''} style="width:100%;height:44px;margin-top:4px;font-size:15px;font-weight:500${secondaryOff ? ';opacity:0.45' : ''}">${secondary}</span>`
    : ''
  const status = pending
    ? `<span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${primary}</span>`
    : ''
  // Stack (320): the primary on top, «Назад» under it, both full width — a long label never truncates.
  return stack
    ? `<div class="col" style="gap:8px">${p}${b}</div>${s}${status}`
    : `<div class="row" style="gap:8px">${b}${p}</div>${s}${status}`
}

// ---------- edit (§2.9, §2.10) ----------
const sk = (h = 48) => `<div class="sk" style="height:${h}px;border-radius:12px"></div>`
const skField = (l) => `<div class="field"><label>${l}</label>${sk()}</div>`
const loadingLine = () =>
  `<div role="status" class="row t-foot muted" style="gap:8px">${spin.replace('var(--primary-fg)', 'var(--muted-fg)').replace('oklch(0 0 0 / 0.25)', 'var(--border)')}Завантажуємо профіль…</div>`
export const editFailAlert = errAlert(
  'Не вдалося зберегти зміни',
  'Дані залишилися у формі, спробуйте ще раз.',
).replace('role="alert"', 'role="alert" tabindex="-1"')
export const editUnknownAlert = errAlert(
  'Невідомо, чи зміни збережено',
  'Відповідь не надійшла. Введене залишилось у формі. Перед повтором профіль оновиться, тож уже збережене не надішлеться вдруге.',
  85,
).replace('role="alert"', 'role="alert" tabindex="-1"')
const loadFailed = `<div role="alert" tabindex="-1" class="col" style="gap:10px;padding:16px;border-radius:14px;background:var(--surface);border:1px solid var(--border);align-items:flex-start"><div class="row" style="gap:10px"><span style="color:var(--destructive)">${icon('cloud-alert', { size: 20 })}</span><span style="font-size:15px;font-weight:600">Не вдалося завантажити профіль</span></div><div class="t-foot muted">Дані зі списку показано, решту — ні. Зберегти можна після завантаження.</div><span class="btn secondary" role="button" style="height:44px;font-size:15px;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)">${icon('rotate-cw', { size: 18 })}Повторити</span></div>`

const PEOPLE = {
  SENIOR: {
    name: 'Олег Ткач',
    email: 'oleh.tkach@example.com',
    tg: '@oleh_t',
    legal: 'Ткач Олег Петрович',
    tech: ['Python', 'Django', 'AWS', 'Docker', 'Redis', 'Celery', 'Go'],
  },
  JUNIOR: {
    name: 'Дмитро Лисенко',
    email: 'dmytro.lysenko@example.com',
    tg: '@d_lysenko',
    legal: 'Лисенко Дмитро Сергійович',
    tech: ['Vue', 'TypeScript'],
  },
  DROP: {
    name: 'Тарас Савчук',
    email: 'taras.savchuk@example.com',
    tg: '@t_savchuk',
    legal: 'Савчук Тарас Іванович',
    tech: ['Python'],
  },
  SELF: {
    name: 'Віктор Кравець',
    email: 'viktor.kravets@example.com',
    tg: '@vkravets',
    legal: '',
    tech: [],
  },
}

/**
 * Edit body. role: SENIOR | JUNIOR | DROP; self = the admin's own row (role locked, salary + wallet).
 * state: '' | 'loading' | 'loadFailed' | 'pending' | 'failed' | 'unknown'.
 */
export function editBody({ self = false, loading, role = 'SENIOR', state = '' } = {}) {
  if (loading === true) state = 'loading'
  const p = self ? PEOPLE.SELF : PEOPLE[role]
  const roAttr = state === 'pending' ? ' readonly style="color:var(--muted-fg)"' : ''
  const F = (o) => field({ ...o, attrs: `${o.attrs ?? ''}${roAttr}` })
  const roleLabel = self
    ? 'Адміністратор'
    : { SENIOR: 'Сеньйор', JUNIOR: 'Джуніор', DROP: 'Дроп' }[role]
  const top = [
    state === 'loading' ? loadingLine() : '',
    state === 'failed' ? editFailAlert : '',
    state === 'unknown' ? editUnknownAlert : '',
    secTitle('Основне', true),
    F({ id: 'en', label: 'Ім’я та прізвище', value: p.name, attrs: KB.name }),
    F({ id: 'ee', label: 'Email', value: p.email, attrs: KB.email }),
    self
      ? pickerField('er', 'Роль', roleLabel, {
          locked: true,
          describedby: 'er-h',
          hint: 'Свою роль змінити не можна',
        })
      : pickerField('er', 'Роль', roleLabel),
    secTitle('Контакти'),
    F({ id: 'et', label: 'Telegram', value: p.tg }),
    F({ id: 'ep', label: 'Телефон', value: '+380 67 000 07 07', attrs: KB.tel }),
  ]
  // R2-20: the failure block opens the body (it was under the fold). R2-21: Технології comes from the list row.
  if (state === 'loadFailed') return [loadFailed, ...top].join('')
  const techRo = (tags) =>
    `<div class="field"><label>Технології</label><div class="input" style="height:auto;min-height:48px;padding:6px 12px;flex-wrap:wrap;gap:6px;background:var(--bg)">${tags.map((t) => `<span class="pill" style="height:28px;font-size:14px">${t}</span>`).join('')}</div></div>`
  if (state === 'loading')
    return [
      ...top,
      ...(self ? [] : [secTitle('Професія'), techRo(p.tech)]),
      secTitle('Фінанси'),
      skField(self ? 'Місячна зарплата' : 'Частка сеньйора'),
      secTitle('Реквізити для виплат'),
      skField('Гаманець USDT (ERC-20)'),
    ].join('')
  const tech = (tags) =>
    `<div class="field"><label>Технології</label><div class="input" style="height:auto;min-height:48px;padding:6px 12px;flex-wrap:wrap;gap:6px">${tags.map((t) => `<span class="pill" style="height:28px;font-size:14px">${t}</span>`).join('')}</div></div>`
  const contract = [
    secTitle('Дані для контракту'),
    F({ id: 'el', label: 'Юридичне ПІБ', value: p.legal, ph: 'Прізвище Ім’я По батькові' }),
    F({ id: 'ea', label: 'Адреса реєстрації (ФОП)', value: 'Львів, вул. Зелена, 10' }),
  ]
  const wallet = [
    F({ id: 'ew', label: 'Гаманець USDT (ERC-20)', value: '0x0000…0a1b' }),
    F({ id: 'ewl', label: 'Мітка гаманця (необов’язково)', value: 'Основний' }),
  ]
  let body
  if (self)
    body = [
      secTitle('Фінанси'),
      salary('2 400', 'USD'),
      secTitle('Реквізити для виплат'),
      note(
        'Для ролі «Адміністратор» доступні лише виплати в USDT <span style="white-space:nowrap">ERC-20</span>.',
      ),
      ...wallet,
    ]
  else if (role === 'JUNIOR')
    body = [
      secTitle('Професія'),
      tech(p.tech),
      ...contract,
      secTitle('Фінанси'),
      salary('52 000', 'UAH', '≈ 1 257 USD'),
      secTitle('Реквізити для виплат'),
      method(1),
      F({ id: 'ef', label: 'ПІБ отримувача (ФОП)', value: p.legal }),
      F({ id: 'eib', label: 'IBAN', value: 'UA00 0000 0000 0000 0000 0000 123' }),
      F({ id: 'ei', label: 'РНОКПП', value: '0000000123', attrs: 'inputmode="numeric"' }),
      F({ id: 'eb', label: 'Банк (необов’язково)', value: 'Банк «Приклад»' }),
      secTitle('Команда'),
      `<div class="field"><label>Активні проєкти</label><div class="group" style="margin:0"><div class="lrow" style="min-height:48px"><span class="grow t-body">Проєкт «Альфа»</span></div></div><a href="#" class="t-foot" style="color:var(--primary);min-height:44px;display:flex;align-items:center">Керувати в розділі «Проєкти» →</a></div>`,
    ]
  else if (role === 'DROP')
    body = [
      secTitle('Професія'),
      tech(p.tech),
      ...contract,
      secTitle('Фінанси'),
      shareField('DROP', 5, { ro: state === 'pending' }),
      secTitle('Реквізити для виплат'),
      method(0),
      ...wallet,
    ]
  else
    body = [
      secTitle('Професія'),
      tech(p.tech),
      ...contract,
      secTitle('Фінанси'),
      shareField('SENIOR', 26, {
        pending: { percent: 40, approver: p.name },
        ro: state === 'pending',
      }),
      secTitle('Реквізити для виплат'),
      note(
        'Для ролі «Сеньйор» доступні лише виплати в USDT <span style="white-space:nowrap">ERC-20</span>.',
      ),
      ...wallet,
      secTitle('Команда'),
      hrField,
      pickerField('eac', 'Бухгалтер', 'Марія Петренко'),
      F({ id: 'ech', label: 'Telegram-канал команди', value: 'https://t.me/alpha_team' }),
    ]
  const html = [...top, ...body].join('')
  // P2: a pending save dims every field, the role select included (the shared read-only style of N3)
  return state === 'pending' ? ro(html) : html
}

// ---------- archive confirm ----------
export const archiveFailAlert = errAlert(
  'Не вдалося архівувати користувача — спробуйте ще раз',
  'Нічого не змінено. Введене ім’я залишилось.',
).replace('role="alert"', 'role="alert" tabindex="-1"')
/** N6: no answer — nothing may be claimed until a refetch proves it. */
export const archiveUnknownAlert = errAlert(
  'Невідомо, чи користувача архівовано',
  'Відповідь не надійшла. «Перевірити» оновить список — тоді стане ясно, чи користувача архівовано.',
  85,
).replace('role="alert"', 'role="alert" tabindex="-1"')
const IMPACT = `<p style="margin:0"><b style="font-weight:600">Олег Ткач</b> та команда «<b style="font-weight:600">Альфа</b>» — пов’язана пара, архівувати окремо не можна. В архів підуть: профіль сеньйора, команда і всі її проєкти (2 проєкти: Проєкт «Альфа», Проєкт «Бета»). Вхід у CRM для цього акаунта буде закрито.</p>
  <p style="margin:8px 0 0">У команді 2 HR/бухгалтери, на її проєктах — 3 джуніори: їхні профілі залишаються активними, оплату вони отримують як і раніше. Після відновлення HR/бухгалтерів доведеться додати в команду заново.</p>
  <p style="margin:8px 0 0" class="muted">Відновлення можливе — пара «сеньйор+команда» повернеться, але проєкти відновлювати окремо.</p>`
/** N9: today's ArchivePendingTransactionsList — it renders nothing when the list is empty. */
export const TX = [
  ['Зарплата · Жовтень 2026', '48 000 UAH'],
  ['Дохід сеньйора (неоплачена частка) · 14.10.2026', '1 250 USD'],
]
export const txBlock = (rows = TX) =>
  `<div style="padding:12px;border-radius:12px;background:oklch(0.2 0.04 22);border:1px solid oklch(0.38 0.09 22)"><div style="font-size:15px;font-weight:500;color:var(--destructive)">Незакриті транзакції, що чекають виплати (${rows.length}) — залишаться в системі і підлягатимуть виплаті</div><ul style="list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px;font-size:14px">${rows.map(([k, v]) => `<li class="row" style="gap:12px;justify-content:space-between;align-items:flex-start"><span class="muted" style="min-width:0">${k}</span><span class="num" style="flex:none;font-weight:500">${v}</span></li>`).join('')}</ul></div>`
/** N2: with the field focused the impact collapses to this one line. */
export const impactSummary = `<p style="margin:0"><b style="font-weight:600">Олег Ткач</b>, команда «Альфа» і 2 проєкти підуть в архів.</p>`
/** P6: the impact count failed — one retry inside the block (refetch of ['users-archive-impact', id]); no typed field until it loads. */
const impactRetry = `<div role="alert" tabindex="-1" class="col" style="gap:10px;align-items:flex-start"><p style="margin:0;color:var(--destructive)">Не вдалося порахувати наслідки архівації</p><span class="btn secondary" role="button" style="height:44px;font-size:15px">${icon('refresh-cw', { size: 18 })}Повторити</span></div>`
/** N5 + P7: nothing attached → a plain confirm (no typed name) and an undo toast. Drawn with an HR user: a JUNIOR's team memberships are not in the impact answer, so a JUNIOR always types the name. */
export const PLAIN_NAME = 'Ірина Мельник'
const PLAIN = `<p style="margin:0">В архів піде профіль <b style="font-weight:600">${PLAIN_NAME}</b>. Вхід у CRM для цього акаунта буде закрито.</p><p style="margin:8px 0 0" class="muted">Профіль можна відновити з архіву.</p>`
/**
 * impact: 'shown' | 'loading' | 'failed' | 'plain' | 'summary' (keyboard open); pending makes the typed field read-only.
 */
export function archiveBody({
  typed = 'Олег Тк',
  impact = 'shown',
  pending = false,
  failed = false,
  unknown = false,
} = {}) {
  const imp =
    impact === 'loading'
      ? `<div role="status" aria-label="Рахуємо наслідки архівації" class="col" style="gap:8px">${sk(16)}${sk(16)}${sk(16)}<div style="width:60%">${sk(16)}</div></div>`
      : impact === 'failed'
        ? impactRetry
        : impact === 'plain'
          ? PLAIN
          : impact === 'summary'
            ? impactSummary
            : `${IMPACT}`
  const tx = impact === 'shown' ? txBlock() : ''
  const label = `Для підтвердження введіть ім’я: <b style="font-weight:700;color:var(--fg)">Олег Ткач</b>`
  const ro = pending || unknown
  // P6: the typed-name field appears only once the impact has loaded (no impact, no confirm)
  const typedField =
    impact === 'plain' || impact === 'loading' || impact === 'failed'
      ? ''
      : field({
          id: 'arn',
          label,
          value: typed,
          state: ro || failed ? '' : 'focus',
          attrs: `autocomplete="off" autocapitalize="words" enterkeyhint="done"${ro ? ' readonly style="color:var(--muted-fg)"' : ''}`,
        })
  const alert = failed ? archiveFailAlert : unknown ? archiveUnknownAlert : ''
  return `<div class="col" style="gap:14px">${alert}<div id="ar-d" class="t-foot" style="font-size:15px;line-height:21px">${imp}</div>${tx}
  ${typedField}</div>`
}
export const archiveBtn = (armed = false, pending = false, label = 'Архівувати') =>
  `<span class="btn${pending ? ' pend' : ''}" role="button"${armed && !pending ? '' : ' aria-disabled="true"'} style="width:100%;background:var(--destructive);color:#fff;${armed ? '' : 'opacity:0.45'}">${pending ? spin.replace('var(--primary-fg)', '#fff') : icon('archive', { size: 18 })}${pending ? 'Архівуємо…' : label}</span>${pending ? '<span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Архівуємо…</span>' : ''}`
