// Users screen — form bodies shared by the phone sheet, the tablet panel and the desktop side panel.
// One body per step; the container (sheet / panel) only changes the frame around it. Sample data is invented.
import { icon, field, segmented, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { errAlert } from '../../../_foundation/assets/src/money-form.mjs'

// ---------- small pieces ----------
const chevDown = `<span class="muted">${icon('chevron-down', { size: 18 })}</span>`
/** Picker field = a button with the value and a chevron; opens the PickerSheet (same as prims-mobile `pickerField`). */
export const pickerField = (id, label, value, { hint = '', state = '', ph = '' } = {}) =>
  field({
    id,
    label,
    value,
    ph,
    hint,
    state,
    suffix: chevDown,
    tag: 'button',
    attrs: 'aria-haspopup="dialog"',
  })

const KB = {
  name: 'autocomplete="name" autocapitalize="words" enterkeyhint="next"',
  email:
    'type="email" inputmode="email" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"',
  tel: 'type="tel" inputmode="tel" autocomplete="off" enterkeyhint="next"',
  num: 'inputmode="decimal" enterkeyhint="next"',
}

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

const note = (text, ic = 'info') =>
  `<div class="row t-foot" style="gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border)"><span class="muted" style="margin-top:1px">${icon(ic, { size: 16 })}</span><span class="grow">${text}</span></div>`

export const okNote = (text) =>
  `<div role="status" class="row t-foot" style="gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:oklch(0.2 0.04 150);border:1px solid oklch(0.36 0.08 150)"><span style="color:var(--positive);margin-top:1px">${icon('circle-check', { size: 16 })}</span><span class="grow">${text}</span></div>`

// ---------- stepper (no foundation primitive: overline + title + thin bars; see spec "Open points") ----------
export const STEPS = ['Особа', 'Роль і команда', 'Оплата', 'Контракт', 'Підтвердження']
export const DROP_STEPS = STEPS.slice(0, 3)
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
export function stepIdentity({ emailErr = false, focus = 'email' } = {}) {
  return [
    field({ id: 'un', label: 'Ім’я та прізвище', value: 'Ірина Мельник', attrs: KB.name }),
    field({
      id: 'ue',
      label: 'Email',
      value: 'iryna.melnyk@example.com',
      state: emailErr ? 'error' : focus === 'email' ? 'focus' : '',
      err: emailErr ? 'Ця електронна адреса вже зайнята. Введіть іншу' : '',
      attrs: KB.email,
    }),
    field({
      id: 'up',
      label: 'Особистий email (необов’язково)',
      ph: 'name@example.com',
      hint: 'На цю адресу одразу піде запрошення. Увійти з цією адресою співробітник зможе лише після її підтвердження.',
      attrs: KB.email,
    }),
    `<div class="field"><label>Мова інтерфейсу</label>${segmented(['Українська', 'English'], 0, { size: 15 })}<div class="hint">Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.</div></div>`,
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

export function stepRole(role = 'SENIOR') {
  const roleF = pickerField(
    'ur',
    'Роль',
    { SENIOR: 'Сеньйор', JUNIOR: 'Джуніор', DROP: 'Дроп' }[role],
  )
  if (role === 'JUNIOR')
    return [
      roleF,
      secTitle('Команда'),
      pickerField('uj', 'Проєкт', '', {
        ph: 'Без проєкту',
        hint: 'Можна прикріпити пізніше в розділі «Проєкти»',
      }),
      secTitle('Професія'),
      techField(['JavaScript']),
    ].join('')
  if (role === 'DROP')
    return [
      roleF,
      secTitle('Команда дропа'),
      `<div class="field"><label>HR</label>${personChips(['Ірина Мельник'])}<button type="button" class="btn ghost" style="justify-content:flex-start;height:44px;padding:0;color:var(--primary);font-weight:500">${icon('plus', { size: 18 })}Додати HR</button></div>`,
      pickerField('uda', 'Бухгалтер (необов’язково)', '', { ph: 'Не обрано' }),
      field({
        id: 'udc',
        label: 'Telegram-канал команди',
        ph: 'https://t.me/…',
        hint: 'Необов’язково. Канал для спілкування команди.',
      }),
    ].join('')
  return [
    roleF,
    secTitle('Команда'),
    `<div class="field"><label>Тип команди</label>${segmented(['Своя команда', 'Команда дропа'], 0, { size: 15 })}<div class="hint">Нова команда сеньйора. Оберіть склад нижче.</div></div>`,
    `<div class="field"><label>HR</label>${personChips(['Ірина Мельник'])}<button type="button" class="btn ghost" style="justify-content:flex-start;height:44px;padding:0;color:var(--primary);font-weight:500">${icon('plus', { size: 18 })}Додати HR</button></div>`,
    pickerField('usa', 'Бухгалтер', 'Марія Петренко'),
    secTitle('Професія'),
    techField(),
  ].join('')
}

export function stepPay(role = 'SENIOR', { alert = '' } = {}) {
  const contract = [
    secTitle('Дані для контракту', true),
    field({ id: 'ul', label: 'Юридичне ПІБ', value: 'Мельник Ірина Олегівна', attrs: KB.name }),
    field({
      id: 'ua',
      label: 'Адреса реєстрації (ФОП)',
      ph: 'Місто, вулиця, будинок',
      hint: 'Ця адреса підставляється в текст контракту',
    }),
  ]
  const wallet = [
    field({
      id: 'uw',
      label: 'Гаманець USDT (ERC-20)',
      ph: '0x…',
      attrs: 'autocapitalize="none" autocorrect="off" spellcheck="false"',
    }),
    field({ id: 'uwl', label: 'Мітка гаманця (необов’язково)', ph: 'Наприклад, основний' }),
  ]
  if (role === 'JUNIOR')
    return [
      alert,
      ...contract,
      secTitle('Фінанси'),
      `<div class="row" style="gap:12px;align-items:flex-start"><div class="grow">${field({ id: 'us', label: 'Сума', value: '1 200', attrs: KB.num })}</div><div style="width:38%">${pickerField('uc', 'Валюта', 'USD')}</div></div>`,
      secTitle('Реквізити для виплат'),
      `<div class="field"><label>Спосіб виплати</label>${segmented(['USDT ERC-20', 'ФОП (UAH)'], 1, { size: 15 })}</div>`,
      field({ id: 'uf', label: 'ПІБ отримувача (ФОП)', value: 'Мельник Ірина Олегівна' }),
      field({ id: 'ui', label: 'РНОКПП', ph: '10 цифр', attrs: 'inputmode="numeric"' }),
      field({ id: 'ub', label: 'Банк (необов’язково)', ph: 'Назва банку' }),
    ].join('')
  if (role === 'DROP')
    return [
      alert,
      ...contract,
      secTitle('Фінанси'),
      field({
        id: 'ud',
        label: 'Частка дропа (%)',
        value: '5',
        hint: 'Скільки дроп залишає собі з кожної виплати. За замовчуванням 5%',
        attrs: KB.num,
      }),
      secTitle('Реквізити для виплат'),
      ...wallet,
    ].join('')
  return [
    alert,
    ...contract,
    secTitle('Фінанси'),
    field({ id: 'uss', label: 'Частка сеньйора (%)', value: '40', attrs: KB.num }),
    secTitle('Реквізити для виплат'),
    note('Для ролі «Сеньйор» доступні лише виплати в USDT ERC-20.'),
    ...wallet,
  ].join('')
}

export const unknownAlert = errAlert(
  'Невідомо, чи користувача створено',
  'Відповідь не надійшла. Введене залишилось у формі. Повторити безпечно: двічі одного користувача система не створить.',
  85,
)
export const failAlert = errAlert(
  'Не вдалося створити користувача',
  'Сервер не відповів. Нічого не створено — введене залишилось у формі.',
)

/** Contract step: the role's template in the TextEditor primitive (placeholders highlighted), or the no-template note. */
export function stepContract({ none = false } = {}) {
  const done = okNote(
    'Користувача створено. Контракт можна додати зараз або пізніше з профілю користувача.',
  )
  if (none)
    return `${done}${note('Немає активного шаблону контракту для цієї ролі. Натисніть «Далі», щоб продовжити без контракту.', 'file-x')}`
  const tok = (t) =>
    `<span style="background:var(--yellow-subtle);color:var(--primary);border-radius:4px;padding:0 3px">{{${t}}}</span>`
  const text = `<p style="margin:0 0 10px;font-weight:600">ДОГОВІР ПРО НАДАННЯ ПОСЛУГ № ${tok('number')}</p>
  <p style="margin:0 0 10px">${tok('city')}, ${tok('date')}</p>
  <p style="margin:0 0 10px">Фізична особа-підприємець ${tok('legalName')}, що зареєстрована за адресою ${tok('registrationAddress')}, надалі «Виконавець», з однієї сторони, та Замовник, з іншої сторони, уклали цей договір про таке.</p>
  <p style="margin:0">1. Предмет договору. Виконавець надає послуги з розробки програмного забезпечення…</p>`
  // Seeded from the role's active template (no template choice today — kept as is).
  return `${done}<div class="field"><label for="ce">Текст контракту</label><div id="ce" role="textbox" aria-multiline="true" style="padding:12px 14px;border-radius:12px;background:var(--surface);border:1px solid var(--input-border);font-size:15px;line-height:22px;max-height:320px;overflow:hidden">${text}</div><div class="hint">Поля в {{дужках}} заповняться з профілю користувача.</div></div>`
}

export function stepConfirm() {
  const row = (k, v) =>
    `<div class="lrow" style="min-height:48px"><div class="grow t-body muted">${k}</div><span class="t-body trunc" style="max-width:60%;text-align:right">${v}</span></div>`
  return `${okNote('Користувача створено')}
  <div class="group" style="margin:0">${row('Ім’я', 'Ірина Мельник')}${row('Роль', 'Сеньйор')}${row('Email', 'iryna.melnyk@example.com')}${row('Контракт', 'Чернетка')}</div>
  <div class="t-foot muted">«Готовий до підписання» — контракт піде на підпис. Чернетку можна доробити пізніше в профілі.</div>`
}

// ---------- action bars ----------
const spin = `<span aria-hidden="true" style="width:18px;height:18px;border-radius:9px;border:2px solid oklch(0 0 0 / 0.25);border-top-color:var(--primary-fg)"></span>`
export function actions({ back = false, primary = 'Далі', pending = false, secondary = '' } = {}) {
  const p = `<span class="btn primary" role="button"${pending ? ' aria-disabled="true"' : ''} style="flex:2;min-width:0">${pending ? spin : ''}${primary}</span>`
  const b = back
    ? `<span class="btn secondary" role="button" style="flex:1;min-width:0"${pending ? ' aria-disabled="true"' : ''}>Назад</span>`
    : ''
  const s = secondary
    ? `<span class="btn ghost" role="button" style="width:100%;height:44px;margin-top:4px;font-size:15px;font-weight:500">${secondary}</span>`
    : ''
  return `<div class="row" style="gap:8px">${b}${p}</div>${s}`
}

// ---------- edit ----------
export function editBody({ self = false, loading = true } = {}) {
  const sk = (h = 48) => `<div class="sk" style="height:${h}px;border-radius:12px"></div>`
  const skField = (l) => `<div class="field"><label>${l}</label>${sk()}</div>`
  return [
    loading
      ? `<div role="status" class="row t-foot muted" style="gap:8px">${spin.replace('var(--primary-fg)', 'var(--muted-fg)').replace('oklch(0 0 0 / 0.25)', 'var(--border)')}Завантажуємо профіль…</div>`
      : '',
    secTitle('Основне', true),
    field({
      id: 'en',
      label: 'Ім’я та прізвище',
      value: self ? 'Віктор Кравець' : 'Олег Ткач',
      attrs: KB.name,
    }),
    field({
      id: 'ee',
      label: 'Email',
      value: self ? 'viktor.kravets@example.com' : 'oleh.tkach@example.com',
      attrs: KB.email,
    }),
    self
      ? pickerField('er', 'Роль', 'Адміністратор', {
          state: 'disabled',
          hint: 'Свою роль змінити не можна',
        })
      : pickerField('er', 'Роль', 'Сеньйор'),
    secTitle('Контакти'),
    field({ id: 'et', label: 'Telegram', value: self ? '@vkravets' : '@oleh_t' }),
    field({ id: 'ep', label: 'Телефон', value: '+380 67 000 07 07', attrs: KB.tel }),
    secTitle(self ? 'Реквізити для виплат' : 'Фінанси'),
    loading
      ? `${skField(self ? 'Гаманець USDT (ERC-20)' : 'Частка сеньйора (%)')}${skField('Гаманець USDT (ERC-20)')}`
      : `${self ? '' : field({ id: 'es', label: 'Частка сеньйора (%)', value: '40', attrs: KB.num })}${field({ id: 'ew', label: 'Гаманець USDT (ERC-20)', value: '0x0000…0a1b' })}`,
  ].join('')
}

// ---------- archive confirm ----------
export function archiveBody({ typed = 'Олег Тк' } = {}) {
  const impact = `<p style="margin:0"><b style="font-weight:600">Олег Ткач</b> та команда «<b style="font-weight:600">Альфа</b>» — пов’язана пара, архівувати окремо не можна. В архів підуть: профіль сеньйора, команда і всі її проєкти (2 проєкти: Проєкт «Альфа», Проєкт «Бета»). Вхід у CRM для цього акаунта буде закрито.</p>
  <p style="margin:8px 0 0">У команді 2 HR/бухгалтери, на її проєктах — 3 джуніори: їхні профілі залишаються активними, оплату вони отримують як і раніше. Після відновлення HR/бухгалтерів доведеться додати в команду заново.</p>
  <p style="margin:8px 0 0" class="muted">Відновлення можливе — пара «сеньйор+команда» повернеться, але проєкти відновлювати окремо.</p>`
  return `<div class="col" style="gap:14px"><div id="ar-d" class="t-foot" style="font-size:15px;line-height:21px">${impact}</div>
  ${field({ id: 'arn', label: 'Для підтвердження введіть ім’я: Олег Ткач', value: typed, state: 'focus', attrs: 'autocomplete="off" autocapitalize="words" enterkeyhint="done"' })}</div>`
}
export const archiveBtn = (armed = false) =>
  `<span class="btn" role="button"${armed ? '' : ' aria-disabled="true"'} style="width:100%;background:var(--destructive);color:#fff;${armed ? '' : 'opacity:0.45'}">${icon('archive', { size: 18 })}Архівувати</span>`
