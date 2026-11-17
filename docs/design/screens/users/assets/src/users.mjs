// Users list + add employee — HTML prototypes (design-gate: degraded). Built only from the foundation
// v2 tokens and primitives in docs/design/screens/_foundation/assets/src; sample data is invented.
import {
  icon,
  page,
  phone,
  field,
  segmented,
  safeBottom,
} from '../../../_foundation/assets/src/base.mjs'
import {
  tabScreen,
  topBar,
  largeTitle,
  searchField,
  chips,
  TABBAR_H,
} from '../../../_foundation/assets/src/mobile.mjs'
import {
  sheet,
  closeBtn,
  safeTop,
  skeletonList,
  stateBlock,
  offlineBanner,
} from '../../../_foundation/assets/src/mobile-overlays.mjs'
import {
  actionConfirm,
  primaryBtn,
  submitBar,
} from '../../../_foundation/assets/src/money-form.mjs'
import * as F from './users-forms.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'

const M = (name, w, h, body) => ({ name, w, h, dpr: 2, html: page(body, { width: w }) })
const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })

// ---------- invented sample data (no real people) ----------
const R = {
  ADMIN: 'Адміністратор',
  SENIOR: 'Сеньйор',
  JUNIOR: 'Джуніор',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
  DROP: 'Дроп',
}
const u = (i, name, email, role, tg, phone, tech, added, extra = {}) => ({
  i,
  name,
  email,
  role,
  tg,
  phone,
  tech,
  added,
  ...extra,
})
const USERS = [
  u(
    'АБ',
    'Анна Бондар',
    'anna.bondar@example.com',
    'SENIOR',
    '@anna_b',
    '+380 50 000 01 01',
    ['React', 'Node.js', 'PostgreSQL'],
    '2 дні тому',
  ),
  u(
    'ВК',
    'Віктор Кравець',
    'viktor.kravets@example.com',
    'ADMIN',
    '@vkravets',
    '',
    [],
    '1 рік тому',
    { self: true },
  ),
  u(
    'ДЛ',
    'Дмитро Лисенко',
    'dmytro.lysenko@example.com',
    'JUNIOR',
    '@d_lysenko',
    '',
    ['Vue', 'TypeScript'],
    '5 днів тому',
  ),
  u(
    'ІМ',
    'Ірина Мельник',
    'iryna.melnyk@example.com',
    'HR',
    '@iryna_hr',
    '+380 67 000 02 02',
    [],
    '3 тижні тому',
  ),
  u(
    'МП',
    'Марія Петренко',
    'mariia.petrenko@example.com',
    'ACCOUNTANT',
    '',
    '+380 63 000 03 03',
    [],
    '2 місяці тому',
  ),
  u('ОК', 'Олена Коваль', 'olena.koval@example.com', 'ADMIN', '@okoval', '', [], '8 місяців тому', {
    otherAdmin: true,
  }),
  u(
    'ОТ',
    'Олег Ткач',
    'oleh.tkach@example.com',
    'SENIOR',
    '@oleh_t',
    '',
    ['Python', 'Django', 'AWS', 'Docker', 'Redis', 'Celery', 'Go'],
    '1 місяць тому',
  ),
  u(
    'ТС',
    'Тарас Савчук',
    'taras.savchuk@example.com',
    'DROP',
    '@t_savchuk',
    '',
    [],
    '4 місяці тому',
  ),
  u(
    'ЮГ',
    'Юлія Гнатюк',
    'yuliia.hnatiuk@example.com',
    'JUNIOR',
    '',
    '',
    ['Java', 'Spring'],
    '6 днів тому',
  ),
  u(
    'СШ',
    'Сергій Шевчук',
    'serhii.shevchuk@example.com',
    'SENIOR',
    '@s_shevchuk',
    '+380 93 000 04 04',
    ['iOS', 'Swift'],
    '3 місяці тому',
  ),
]
const ARCHIVED = [
  u(
    'ПЗ',
    'Павло Зінченко',
    'pavlo.zinchenko@example.com',
    'JUNIOR',
    '',
    '',
    ['PHP'],
    '1 рік тому',
    { archived: '12.10.2026' },
  ),
  u(
    'НР',
    'Наталія Руденко',
    'nataliia.rudenko@example.com',
    'SENIOR',
    '@n_rudenko',
    '',
    ['C#', '.NET'],
    '2 роки тому',
    { archived: '03.09.2026' },
  ),
  u('КВ', 'Костянтин Волошин', 'kostiantyn.voloshyn@example.com', 'HR', '', '', [], '1 рік тому', {
    archived: '21.08.2026',
  }),
]
const LONG = u(
  'ОЛ',
  'Олександра-Вікторія Литвиненко-Старовойтенко',
  'oleksandra-viktoriia.lytvynenko-starovoitenko@example.com',
  'SENIOR',
  '@oleksandra_viktoriia_lytvynenko',
  '+380 50 000 05 05',
  ['TypeScript', 'React Native', 'GraphQL', 'Kubernetes', 'Terraform', 'Elixir', 'Rust', 'Kafka'],
  'щойно',
)

// ---------- mobile list ----------
const sr = (t) =>
  `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${t}</span>`
const youPill = `<span class="pill y" style="height:20px;font-size:11px;font-weight:600;padding:0 6px">Ви</span>`
const avatar = (x, size = 36) =>
  `<div class="lead av" aria-hidden="true" style="width:${size}px;height:${size}px;border-radius:${size / 2}px${x.archived ? ';background:var(--surface);color:var(--muted-fg)' : ''}">${x.i}</div>`

/** Two-line row: name (+ «Ви»), «role · email»; trailing: added-time or the archive date. Opens the profile. */
function userRow(x, { selected = false, swipe = '', added = false } = {}) {
  // The added time shows only when the list is sorted by it; otherwise the trail stays free for the name.
  const meta = x.archived
    ? `<span class="pill" style="height:20px;font-size:11px;color:var(--muted-fg)">${icon('archive', { size: 12 })}${x.archived}</span>`
    : added
      ? `<span class="t-cap muted num">${x.added}</span>`
      : ''
  const row = `<a class="lrow two" href="#" aria-label="${x.name}, ${R[x.role]}${x.archived ? `, в архіві з ${x.archived}` : ''}${x.self ? ', це ви' : ''}" style="--inset:64px;background:${selected ? 'var(--raised)' : 'var(--card)'}${swipe ? ';transform:translateX(-176px)' : ''}"${selected ? ' aria-current="true"' : ''}>${avatar(x)}
  <div class="grow col" style="gap:2px"><div class="row" style="gap:6px;min-width:0"><span class="t-body trunc" style="font-weight:500;${x.archived ? 'color:var(--muted-fg)' : ''}">${x.name}</span>${x.self ? youPill : ''}</div>
  <div class="t-foot muted trunc"><span style="color:oklch(0.8 0 0);font-weight:500">${R[x.role]}</span> · ${x.email}</div></div>
  ${meta ? `<div class="trail">${meta}</div>` : ''}${icon('chevron-right', { size: 18, cls: 'chev' })}</a>`
  return swipe ? `<div style="position:relative;overflow:hidden">${swipe}${row}</div>` : row
}
const list = (rows, opts) =>
  `<div class="group">${rows.map((x) => userRow(x, opts)).join('')}</div>`
/** Section header: count on the left, the sort control (a real 44 px button) on the right. */
const sortHead = (count, sort = 'Ім’я') =>
  `<div class="sechead" style="padding-top:12px;align-items:center"><span class="t-over num">${count}</span><button type="button" class="btn ghost" aria-label="Сортування: ${sort}, за зростанням" style="height:44px;padding:0 4px 0 12px;margin-right:-4px;font-size:15px;font-weight:500;color:var(--muted-fg);gap:6px">${icon('arrow-up-down', { size: 16 })}${sort}</button></div>`

const STATUS = ['Активні', 'Архів', 'Усі']
/** Status (single choice, URL) + role filter: one chip row, the same pattern as the finance list. */
function filterRow(seg = 0, role = '') {
  const c = STATUS.map(
    (t, i) =>
      `<span class="row" role="radio" aria-checked="${i === seg}" style="height:44px;padding:0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;${i === seg ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${t}</span>`,
  ).join('')
  const r = `<span class="row" role="button" aria-haspopup="dialog" style="gap:4px;height:44px;padding:0 12px 0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;${role ? 'background:var(--yellow-subtle);color:var(--primary);border:1px solid oklch(0.32 0.06 85)' : 'background:var(--surface);color:var(--fg);border:1px dashed var(--input-border)'}">${role || 'Роль'}${icon('chevron-down', { size: 15 })}</span>`
  return `<div class="row" style="gap:8px;padding:0 16px 6px;overflow:hidden"><span role="radiogroup" aria-label="Статус" class="row" style="gap:8px">${c}</span>${r}</div>`
}

function listBody({
  seg = 0,
  rows = USERS,
  count = '38 користувачів',
  role = '',
  sort,
  extra = '',
} = {}) {
  return `${searchField('Ім’я, email, Telegram…')}${filterRow(seg, role)}${extra || `${sortHead(count, sort)}${list(rows, { added: sort === 'Додано' })}`}`
}

const usersScreen = (w, h, o = {}) =>
  tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/users',
    title: 'Користувачі',
    sub: o.sub ?? '38 активних',
    body: o.body ?? listBody(o),
    banner: o.banner ?? '',
    overlay: o.overlay ?? '',
    showFab: o.showFab ?? true,
  })

// ---------- mobile: list states ----------
const ROLE_SENIOR = USERS.filter((x) => x.role === 'SENIOR')
const resetBtn = `<span class="btn secondary" role="button">${icon('rotate-ccw', { size: 18 })}Скинути фільтри</span>`
const SEARCH_PH = 'Ім’я, email, Telegram…'

const loadingBody = () =>
  `${searchField(SEARCH_PH)}${filterRow(0)}<div role="status" aria-label="Завантаження користувачів" style="display:contents">${skeletonList(7)}</div>`
const noResults = () =>
  stateBlock({
    ic: 'search-x',
    title: 'Нічого не знайдено — скиньте фільтри',
    text: 'Немає користувачів, що відповідають пошуку «Залізняк» і ролі «Сеньйор».',
    action: resetBtn,
  })
const archiveEmpty = () =>
  stateBlock({
    ic: 'archive',
    title: 'В архіві нікого немає',
    text: 'Тут з’являться архівовані користувачі. Будь-кого з них можна відновити.',
  })
const loadError = () =>
  stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити користувачів',
    text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
    action: `<span class="btn secondary" role="button">${icon('rotate-cw', { size: 18 })}Спробувати ще</span>`,
  })
/** The search field with a typed query and its 44 px clear button. */
const searchWith = (q) =>
  searchField(SEARCH_PH).replace(
    `<span>${SEARCH_PH}</span>`,
    `<span class="grow" style="color:var(--fg)">${q}</span><span role="button" aria-label="Очистити пошук" style="width:44px;height:44px;margin-right:-12px;display:grid;place-items:center">${icon('circle-x', { size: 18 })}</span>`,
  )

/** Swipe left on a row: «Змінити» + «Архівувати» (another ADMIN's row has no swipe; self — «Змінити» only). */
const swipeActions = (archived = false) =>
  `<div class="row" style="position:absolute;right:0;top:0;bottom:0" aria-hidden="true">${
    archived
      ? `<div class="col" style="width:176px;height:100%;background:oklch(0.42 0.08 150);justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('archive-restore', { size: 18 })}Відновити</div>`
      : `<div class="col" style="width:88px;height:100%;background:oklch(0.42 0.02 250);justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('pencil', { size: 18 })}Змінити</div><div class="col" style="width:88px;height:100%;background:var(--destructive);color:#fff;justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600">${icon('archive', { size: 18 })}Архівувати</div>`
  }</div>`

// ---------- mobile: create / edit sheets ----------
const lead = (t) => `<span style="font-size:17px">${t}</span>`
function formSheet(
  w,
  h,
  {
    title = 'Новий користувач',
    leadText = 'Скасувати',
    step = 0,
    steps = F.STEPS,
    body,
    bar,
    over = '',
  },
) {
  const s = sheet({
    w,
    h,
    top: safeTop(w) + 10,
    title,
    lead: lead(leadText),
    body: F.formBody(`${step ? F.stepper(step, steps) : ''}${body}`, { w }),
    footer: submitBar({ w, inner: bar }),
  })
  return usersScreen(w, h, { overlay: s + over, showFab: false })
}
// A sheet stacked above the form sheet (picker): its own scrim above the first sheet.
const stacked = (html) =>
  html
    .replace('class="scrim"', 'class="scrim" style="z-index:76"')
    .replace('style="top:', 'style="z-index:77;top:')

function rolePicker(w, h) {
  const opt = (label, cur = false) =>
    `<div class="lrow" role="option" aria-selected="${cur}" style="min-height:56px"><div class="grow t-body" style="${cur ? 'font-weight:600' : ''}">${label}</div>${cur ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`
  const body = `<div role="listbox" aria-label="Роль"><div class="group">${['Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп'].map((r) => opt(r, r === 'Сеньйор')).join('')}</div></div>`
  return stacked(sheet({ w, h, top: Math.round(h * 0.48), title: 'Роль', trail: closeBtn, body }))
}

function editSheet(w, h, o = {}) {
  return formSheet(w, h, {
    title: 'Редагувати',
    body: F.editBody(o),
    bar: `<span class="btn primary" role="button"${o.loading ? ' aria-disabled="true" style="width:100%;opacity:0.5"' : ' style="width:100%"'}>Зберегти</span>`,
    over: o.over ?? '',
  })
}

function archiveSheet(w, h, { armed = false } = {}) {
  const s = sheet({
    w,
    h,
    top: Math.round(h * 0.2),
    title: 'Архівувати',
    lead: lead('Скасувати'),
    body: `<div style="padding:4px 16px ${60 + safeBottom(w) + 24}px">${F.archiveBody({ typed: armed ? 'Олег Ткач' : 'Олег Тк' })}</div>`,
    footer: submitBar({ w, inner: F.archiveBtn(armed) }),
  })
    .replace('role="dialog"', 'role="alertdialog" aria-describedby="ar-d"')
    .replace('aria-label="Архівувати"', 'aria-label="Архівувати користувача"')
  return usersScreen(w, h, { overlay: s, showFab: false })
}

const dirtyConfirm = (w) =>
  actionConfirm(w, {
    id: 'dc',
    title: 'Вийти без збереження?',
    desc: 'Введені дані буде втрачено.',
    action: 'Вийти',
    cancel: 'Залишитися',
    overSheet: true,
    focusCancel: true,
  })
const emailConfirm = (w) =>
  actionConfirm(w, {
    id: 'ec',
    title: 'Змінити email?',
    desc: 'Старий: oleh.tkach@example.com<br>Новий: oleh.tkach@example.org',
    action: 'Підтвердити зміну',
    ink: 'var(--primary)',
    overSheet: true,
    focusCancel: true,
  })

function mobileFrames() {
  const w = 375
  const h = 812
  const back = { back: true }
  const create = (name, o) => M(name, w, h, formSheet(w, h, o))
  const CREATE = 'Створити користувача'
  return [
    M('list-320', 320, 568, usersScreen(320, 568)),
    M('list-375', w, h, usersScreen(w, h)),
    M('loading-375', w, h, usersScreen(w, h, { body: loadingBody() })),
    M(
      'filtered-375',
      w,
      h,
      usersScreen(w, h, {
        role: 'Сеньйор',
        rows: ROLE_SENIOR,
        count: `${ROLE_SENIOR.length} з 38`,
      }),
    ),
    M(
      'no-results-375',
      w,
      h,
      usersScreen(w, h, {
        body: `${searchWith('Залізняк')}${filterRow(0, 'Сеньйор')}${noResults()}`,
      }),
    ),
    M('sorted-added-375', w, h, usersScreen(w, h, { sort: 'Додано' })),
    M(
      'archive-375',
      w,
      h,
      usersScreen(w, h, { seg: 1, rows: ARCHIVED, count: '3 в архіві', sub: '3 в архіві' }),
    ),
    M(
      'archive-empty-375',
      w,
      h,
      usersScreen(w, h, {
        sub: 'Архів порожній',
        body: `${searchField(SEARCH_PH)}${filterRow(1)}${archiveEmpty()}`,
      }),
    ),
    M(
      'error-375',
      w,
      h,
      usersScreen(w, h, {
        sub: '',
        body: `${searchField(SEARCH_PH)}${filterRow(0)}${loadError()}`,
      }),
    ),
    M('offline-375', w, h, usersScreen(w, h, { banner: offlineBanner() })),
    M('long-320', 320, 568, usersScreen(320, 568, { rows: [LONG, ...USERS.slice(0, 5)] })),
    M('long-375', w, h, usersScreen(w, h, { rows: [LONG, ...USERS.slice(0, 7)] })),
    M(
      'swipe-375',
      w,
      h,
      usersScreen(w, h, {
        extra: `${sortHead('38 користувачів')}<div class="group">${USERS.map((x) =>
          userRow(x, x.name === 'Дмитро Лисенко' ? { swipe: swipeActions() } : {}),
        ).join('')}</div>`,
      }),
    ),
    // create — 5 steps (DROP: 3)
    create('create-1-375', { step: 1, body: F.stepIdentity(), bar: F.actions() }),
    create('create-2-375', { step: 2, body: F.stepRole('SENIOR'), bar: F.actions(back) }),
    create('create-2-junior-375', { step: 2, body: F.stepRole('JUNIOR'), bar: F.actions(back) }),
    create('create-2-drop-375', {
      step: 2,
      steps: F.DROP_STEPS,
      body: F.stepRole('DROP'),
      bar: F.actions(back),
    }),
    create('role-picker-375', {
      step: 2,
      body: F.stepRole('SENIOR'),
      bar: F.actions(back),
      over: rolePicker(w, h),
    }),
    create('create-3-375', {
      step: 3,
      body: F.stepPay('SENIOR'),
      bar: F.actions({ ...back, primary: CREATE }),
    }),
    create('create-3-junior-375', {
      step: 3,
      body: F.stepPay('JUNIOR'),
      bar: F.actions({ ...back, primary: CREATE }),
    }),
    create('create-pending-375', {
      step: 3,
      body: F.stepPay('SENIOR'),
      bar: F.actions({ ...back, primary: 'Створюємо…', pending: true }),
    }),
    create('create-error-375', {
      step: 1,
      body: F.stepIdentity({ emailErr: true }),
      bar: F.actions(),
    }),
    create('create-failed-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.failAlert }),
      bar: F.actions({ ...back, primary: CREATE }),
    }),
    create('create-unknown-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.unknownAlert }),
      bar: F.actions({ ...back, primary: 'Спробувати ще раз' }),
    }),
    create('create-4-375', {
      step: 4,
      leadText: 'Закрити',
      body: F.stepContract(),
      bar: F.actions(back),
    }),
    create('create-4-none-375', {
      step: 4,
      leadText: 'Закрити',
      body: F.stepContract({ none: true }),
      bar: F.actions(back),
    }),
    create('create-5-375', {
      step: 5,
      leadText: 'Закрити',
      body: F.stepConfirm(),
      bar: F.actions({
        primary: 'Позначити готовим до підписання',
        secondary: 'Зберегти чернетку',
      }),
    }),
    create('dirty-close-375', {
      step: 1,
      body: F.stepIdentity({ focus: '' }),
      bar: F.actions(),
      over: dirtyConfirm(w),
    }),
    M('edit-375', w, h, editSheet(w, h, { loading: true })),
    M('edit-loaded-375', w, h, editSheet(w, h, { loading: false })),
    M('edit-self-375', w, h, editSheet(w, h, { self: true, loading: false })),
    M('email-change-375', w, h, editSheet(w, h, { loading: false, over: emailConfirm(w) })),
    M('archive-confirm-375', w, h, archiveSheet(w, h)),
    M('archive-armed-375', w, h, archiveSheet(w, h, { armed: true })),
    M(
      'permission-375',
      w,
      h,
      phone({
        w,
        h,
        inner: `${topBar({ title: 'Користувачі', bell: false, search: false })}<div class="content">${stateBlock({ ic: 'lock', title: 'Доступ лише для адміністратора', text: 'Цей розділ відкривається тільки адміністраторам. Зазвичай вас одразу переносить на ваш головний екран.' })}</div>`,
      }),
    ),
  ]
}

// ---------- frames ----------
export function frames() {
  return [...mobileFrames()]
}
