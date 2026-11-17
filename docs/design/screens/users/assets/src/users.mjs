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
import { actionConfirm, primaryBtn } from '../../../_foundation/assets/src/money-form.mjs'
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
function userRow(x, { selected = false, swipe = '' } = {}) {
  const meta = x.archived
    ? `<span class="pill" style="height:20px;font-size:11px;color:var(--muted-fg)">${icon('archive', { size: 12 })}${x.archived}</span>`
    : `<span class="t-cap muted num">${x.added}</span>`
  const row = `<a class="lrow two" href="#" aria-label="${x.name}, ${R[x.role]}${x.archived ? `, в архіві з ${x.archived}` : ''}${x.self ? ', це ви' : ''}" style="--inset:64px;background:${selected ? 'var(--raised)' : 'var(--card)'}${swipe ? ';transform:translateX(-176px)' : ''}"${selected ? ' aria-current="true"' : ''}>${avatar(x)}
  <div class="grow col" style="gap:2px"><div class="row" style="gap:6px;min-width:0"><span class="t-body trunc" style="font-weight:500;${x.archived ? 'color:var(--muted-fg)' : ''}">${x.name}</span>${x.self ? youPill : ''}</div>
  <div class="t-foot muted trunc"><span style="color:oklch(0.8 0 0);font-weight:500">${R[x.role]}</span> · ${x.email}</div></div>
  <div class="trail">${meta}</div>${icon('chevron-right', { size: 18, cls: 'chev' })}</a>`
  return swipe ? `<div style="position:relative;overflow:hidden">${swipe}${row}</div>` : row
}
const list = (rows, opts) =>
  `<div class="group">${rows.map((x) => userRow(x, opts)).join('')}</div>`
/** Section header: count on the left, the sort control (a real 44 px button) on the right. */
const sortHead = (count, sort = 'Ім’я') =>
  `<div class="sechead" style="padding-top:12px"><span class="t-over num">${count}</span><button type="button" class="btn ghost" aria-label="Сортування: ${sort}, за зростанням" style="height:44px;padding:0 4px 0 12px;margin-right:-4px;font-size:15px;font-weight:500;color:var(--muted-fg);gap:6px">${icon('arrow-up-down', { size: 16 })}${sort}</button></div>`

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
  return `${searchField('Ім’я, email, Telegram…')}${filterRow(seg, role)}${extra || `${sortHead(count, sort)}${list(rows)}`}`
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

// ---------- frames ----------
export function frames() {
  return [
    M('list-320', 320, 568, usersScreen(320, 568)),
    M('list-375', 375, 812, usersScreen(375, 812)),
  ]
}
