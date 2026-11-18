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
  textKeyboard,
  TEXT_H,
} from '../../../_foundation/assets/src/money-form.mjs'
import * as F from './users-forms.mjs'
import { wideFrames } from './users-wide.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'

const M = (name, w, h, body) => ({ name, w, h, dpr: 2, html: page(body, { width: w }) })
const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })

// ---------- invented sample data (no real people) ----------
export const R = {
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
export const USERS = [
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
export const ARCHIVED = [
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
export const LONG = u(
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
export const youPill = `<span class="pill y" style="height:20px;font-size:11px;font-weight:600;padding:0 6px">Ви</span>`
const avatar = (x, size = 40) =>
  `<div class="lead av" aria-hidden="true" style="width:${size}px;height:${size}px;border-radius:${size / 2}px${x.archived ? ';background:var(--surface);color:var(--muted-fg)' : ''}">${x.i}</div>`
const CLAMP2 =
  'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'
/** Another ADMIN's row has no actions (as today); every other row has the 44 px «⋯» (M10). */
const hasActions = (x) => x.self || x.role !== 'ADMIN'
export const moreBtn = (x, focus = false) =>
  `<button type="button" aria-label="Дії: ${x.name}" aria-haspopup="dialog" style="appearance:none;border:0;background:none;color:var(--muted-fg);width:44px;height:44px;margin-right:4px;border-radius:22px;display:grid;place-items:center;flex:none${focus ? ';box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)' : ''}">${icon('ellipsis', { size: 20 })}</button>`

/**
 * Row: a link (avatar, name wrapping to two lines, «Роль · email» or «Архівовано {date}», optional match
 * line) + a sibling 44 px «⋯». The link and «⋯» are never nested. Swipe is a shortcut layer (aria-hidden).
 */
export function userRow(
  x,
  { selected = false, swipe = '', added = false, match = '', focusMore = false } = {},
) {
  const second = x.archived
    ? `<span style="color:oklch(0.8 0 0);font-weight:500">${R[x.role]}</span> · Архівовано ${x.archived}`
    : `<span style="color:oklch(0.8 0 0);font-weight:500">${R[x.role]}</span> · ${x.email}`
  const time =
    added && !x.archived ? `<span class="t-cap muted num" style="flex:none">${x.added}</span>` : ''
  const m = match ? `<div class="t-foot trunc" style="color:var(--fg)">${match}</div>` : ''
  const label = `${x.name}, ${R[x.role]}${x.archived ? `, архівовано ${x.archived}` : ''}${x.self ? ', це ви' : ''}${match ? `, ${match.replace(/<[^>]+>/g, '')}` : ''}`
  const row = `<div class="lrow two" style="padding:0;gap:0;--inset:68px;background:${selected ? 'var(--raised)' : 'var(--card)'}${swipe ? ';transform:translateX(-176px)' : ''}">
  <a href="#" aria-label="${label}"${selected ? ' aria-current="true"' : ''} style="flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:10px ${hasActions(x) ? 4 : 16}px 10px 16px;color:inherit;text-decoration:none;min-height:64px">${avatar(x)}
  <div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:6px;min-width:0;align-items:flex-start"><span class="t-body" style="font-weight:500;${CLAMP2};${x.archived ? 'color:var(--muted-fg)' : ''}">${x.name}</span>${x.self ? youPill : ''}<span class="grow"></span>${time}</div>
  <div class="t-foot muted trunc">${second}</div>${m}</div></a>${hasActions(x) ? moreBtn(x, focusMore) : ''}</div>`
  return swipe ? `<div style="position:relative;overflow:hidden">${swipe}${row}</div>` : row
}
const list = (rows, opts) =>
  `<div class="group">${rows.map((x) => userRow(x, opts)).join('')}</div>`
/** Count (sentence case, never the uppercase overline) + the sort control (a real 44 px button). */
export const sortHead = (count, sort = 'Ім’я', dir = '↑') =>
  `<div class="sechead" style="padding-top:12px;align-items:center"><span role="status" class="t-foot muted num" style="font-weight:500">${count}</span><button type="button" class="btn ghost" aria-haspopup="dialog" aria-label="Сортування: ${sort}, ${dir === '↑' ? 'за зростанням' : 'спочатку нові'}" style="height:44px;padding:0 4px 0 12px;margin-right:-4px;font-size:15px;font-weight:500;color:var(--muted-fg);gap:6px">${icon(dir === '↑' ? 'arrow-up' : 'arrow-down', { size: 16 })}${sort}</button></div>`

const STATUS = ['Активні', 'Архів', 'Усі']
/** Status (single choice, URL) + role chip; the row scrolls with a 16 px edge fade when it does not fit. */
export function filterRow(seg = 0, role = '') {
  const c = STATUS.map(
    (t, i) =>
      `<span class="row" role="radio" aria-checked="${i === seg}" style="flex:none;height:44px;padding:0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;${i === seg ? 'background:var(--fg);color:var(--bg)' : 'background:var(--surface);color:var(--fg);border:1px solid var(--border)'}">${t}</span>`,
  ).join('')
  const r = role
    ? `<span class="row" style="flex:none;gap:0;height:44px;padding:0 0 0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;background:var(--yellow-subtle);color:var(--primary);border:1px solid oklch(0.32 0.06 85)"><span role="button" aria-haspopup="dialog" aria-label="Роль: ${role}" style="display:flex;align-items:center;height:44px">${role}</span><span role="button" aria-label="Скинути роль" style="width:44px;height:44px;display:grid;place-items:center">${icon('x', { size: 16 })}</span></span>`
    : `<span class="row" role="button" aria-haspopup="dialog" style="flex:none;gap:4px;height:44px;padding:0 12px 0 16px;border-radius:22px;font-size:15px;font-weight:500;white-space:nowrap;background:var(--surface);color:var(--fg);border:1px dashed var(--input-border)">Роль${icon('chevron-down', { size: 15 })}</span>`
  const grp = `<span role="radiogroup" aria-label="Статус" class="row" style="gap:8px;flex:none">${c}</span>`
  return `<div class="row" style="gap:8px;padding:0 16px 6px;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 16px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 16px),transparent)">${role ? r + grp : grp + r}<span style="flex:none;width:8px"></span></div>`
}

function listBody({
  seg = 0,
  rows = USERS,
  count = '38 користувачів',
  role = '',
  sort,
  dir,
  extra = '',
  q = '',
  match = {},
} = {}) {
  const s = q ? searchWith(q) : searchField(SEARCH_PH)
  return `${s}${filterRow(seg, role)}${extra || `${sortHead(count, sort, dir)}<div class="group">${rows.map((x) => userRow(x, { added: sort === 'Додано', match: match[x.name] ?? '' })).join('')}</div>`}`
}

/** FAB clearance: the foundation tab-root spacer is tab bar + safe area + 80 (FAB 56 + 16 + 8). */
const usersScreen = (w, h, o = {}) =>
  tabScreen({
    w,
    h,
    role: o.navRole ?? 'ADMIN',
    active: o.active ?? '/users',
    title: 'Користувачі',
    sub: o.sub ?? '38 активних',
    body: o.body ?? listBody(o),
    banner: o.banner ?? '',
    overlay: `${SHEET_CSS}${o.overlay ?? ''}`,
    showFab: o.showFab ?? true,
  })
// R1-15: a gap between the sheet lead and the centred title at 375 / 320 (the grid itself is foundation).
const SHEET_CSS = `<style>.sheethead{grid-template-columns:minmax(0,1fr) max-content minmax(0,1fr);column-gap:8px;padding:0 12px}.sheethead .a{padding:0}</style>`

// ---------- mobile: list states ----------
const ROLE_SENIOR = USERS.filter((x) => x.role === 'SENIOR')
const resetBtn = `<span class="btn secondary" role="button">${icon('rotate-ccw', { size: 18 })}Скинути фільтри</span>`
const SEARCH_PH = 'Ім’я, email, Telegram…'
/** Relative created time → age in days, for the «Додано» order (fixtures carry relative strings only). */
const ageDays = (s) => {
  if (s === 'щойно') return 0
  const n = parseInt(s, 10) || 1
  if (/дн/.test(s)) return n
  if (/тиж/.test(s)) return n * 7
  if (/міс/.test(s)) return n * 30
  if (/рік|рок/.test(s)) return n * 365
  return n
}
const BY_ADDED = [...USERS].sort((a, b) => ageDays(a.added) - ageDays(b.added))

/** Skeleton in the final row geometry: avatar 40, two lines, «⋯» circle. */
const skRow = (wide = 60) =>
  `<div class="lrow two" style="--inset:68px"><div class="sk" style="width:40px;height:40px;border-radius:20px;flex:none"></div><div class="grow col" style="gap:8px"><div class="sk" style="height:14px;width:${wide}%;border-radius:7px"></div><div class="sk" style="height:12px;width:${wide + 22}%;border-radius:6px"></div></div><div class="sk" style="width:24px;height:24px;border-radius:12px;margin-right:10px;flex:none"></div></div>`
const loadingBody = () =>
  `${searchField(SEARCH_PH)}${filterRow(0)}<div class="sechead" style="padding-top:12px;height:44px"></div><div role="status" aria-label="Завантаження користувачів"><div class="group">${[58, 44, 62, 50, 40, 56, 48].map(skRow).join('')}</div></div>`
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
    action: `<span class="btn secondary" role="button">Показати активних</span>`,
  })
const loadError = () =>
  stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити користувачів',
    text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
    action: `<span class="btn secondary" role="button">${icon('rotate-cw', { size: 18 })}Спробувати ще раз</span>`,
  })
/** The search field with a typed query and its 44 px clear button. */
function searchWith(q) {
  return searchField(SEARCH_PH).replace(
    `<span>${SEARCH_PH}</span>`,
    `<span class="grow" style="color:var(--fg)">${q}</span><span role="button" aria-label="Очистити пошук" style="width:44px;height:44px;margin-right:-12px;display:grid;place-items:center">${icon('circle-x', { size: 18 })}</span>`,
  )
}
/** M4 banner: an unresolved create stays visible above the list after the wizard closed. */
export const writeBanner = (title, action = 'Перевірити', { failed = false } = {}) => {
  const tone = failed ? 22 : 85
  return `<div role="status" style="margin:0 12px 6px;padding:10px 12px;border-radius:12px;background:oklch(0.2 0.04 ${tone});border:1px solid oklch(0.38 0.09 ${tone})"><div class="row" style="gap:10px;align-items:flex-start"><span style="color:${failed ? 'var(--destructive)' : 'var(--warning)'};margin-top:1px">${icon(failed ? 'circle-alert' : 'circle-help', { size: 18 })}</span><div class="grow" style="min-width:0"><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">${title}</div><div class="row" style="gap:8px;margin-top:8px"><span class="btn secondary" role="button" style="height:44px;font-size:15px;flex:1">${action}</span><span class="btn ghost" role="button" style="height:44px;font-size:15px;flex:1">Приховати</span></div></div></div></div>`
}
export const unknownBanner = (email = F.NEW.email) => writeBanner(`Невідомо, чи створено ${email}`)
/** N3: an edit save that failed after the sheet was closed — one action reopens the same form with every value kept. */
export const failedBanner = (name = 'Олег Ткач') =>
  writeBanner(`Не вдалося зберегти зміни: ${name}`, 'Відкрити', { failed: true })
/** N6: archive / restore with no answer — nothing is claimed until «Перевірити» refetches. */
export const archiveUnknownBanner = (name = 'Олег Ткач', restore = false) =>
  writeBanner(`Невідомо, чи користувача ${name} ${restore ? 'відновлено' : 'архівовано'}`)
/** N5: the undo toast (left of the FAB, above the tab bar). */
export const undoToast = (w) =>
  `<div class="toast" role="status" style="left:12px;right:80px;bottom:${TABBAR_H + safeBottom(w) + 16}px;padding-left:16px"><span class="grow">Користувача архівовано</span><span role="button" style="height:44px;padding:0 12px;display:flex;align-items:center;font-weight:600;color:var(--primary)">Відновити</span></div>`

const swipeCell = (bg, ic, t, extra = '') =>
  `<div class="col" style="width:88px;height:100%;background:${bg};justify-content:center;align-items:center;gap:3px;font-size:12px;font-weight:600;text-align:center;${extra}">${ic ? icon(ic, { size: 18 }) : ''}${t}</div>`
/** Swipe left (a shortcut; «⋯» is the visible path): active «Змінити» + «Архівувати», archived «Змінити» + «Відновити», self «Змінити» + a muted reason. */
const swipeActions = (kind = 'active') =>
  `<div class="row" style="position:absolute;right:0;top:0;bottom:0" aria-hidden="true">${swipeCell('oklch(0.42 0.02 250)', 'pencil', 'Змінити')}${
    kind === 'archived'
      ? swipeCell('oklch(0.42 0.08 150)', 'archive-restore', 'Відновити')
      : kind === 'self'
        ? swipeCell(
            'var(--surface)',
            'ban',
            'Не можна архівувати себе',
            'color:var(--muted-fg);font-weight:500;line-height:14px;padding:0 6px',
          )
        : swipeCell('var(--destructive)', 'archive', 'Архівувати', 'color:#fff')
  }</div>`

// ---------- mobile: create / edit sheets ----------
const lead = (t) => `<span style="font-size:17px">${t}</span>`
function formSheet(
  w,
  h,
  {
    title = 'Створення',
    leadText = 'Скасувати',
    step = 0,
    steps = F.STEPS,
    body,
    bar,
    over = '',
    kbdH = 0,
    kbd = '',
  },
) {
  const s = sheet({
    w,
    h,
    top: safeTop(w) + 10,
    title,
    lead: lead(leadText),
    body: F.formBody(`${step ? F.stepper(step, steps) : ''}${body}`, { w }),
    footer: submitBar({ w, kbdH, inner: bar }),
  })
  return usersScreen(w, h, { overlay: s + kbd + over, showFab: false })
}
// A sheet stacked above the form sheet (picker): its own scrim above the first sheet.
const stacked = (html) =>
  html
    .replace('class="scrim"', 'class="scrim" style="z-index:76"')
    .replace('style="top:', 'style="z-index:77;top:')

const roleOpt = (label, cur = false) =>
  `<div class="lrow" role="option" aria-selected="${cur}" style="min-height:56px"><div class="grow t-body" style="${cur ? 'font-weight:600' : ''}">${label}</div>${cur ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`

/** List filter «Роль»: «Усі ролі» + every role incl. Адміністратор (as today's select). */
function roleFilter(w, h) {
  const body = `<div role="listbox" aria-label="Фільтр за роллю"><div class="group">${['Усі ролі', 'Адміністратор', 'Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп'].map((r) => roleOpt(r, r === 'Усі ролі')).join('')}</div></div>`
  return sheet({ w, h, top: Math.round(h * 0.36), title: 'Роль', trail: closeBtn, body })
}

/** Sort sheet «Сортування»: name / role / added, each direction a 56 px option; the current one checked. */
function sortSheet(w, h) {
  const opts = [
    ['За ім’ям', 'А → Я', true],
    ['За ім’ям', 'Я → А'],
    ['За роллю', 'А → Я'],
    ['За роллю', 'Я → А'],
    ['Спочатку нові', 'Додано'],
    ['Спочатку старі', 'Додано'],
  ]
  const body = `<div role="listbox" aria-label="Сортування"><div class="group">${opts.map(([t, s, cur]) => `<div class="lrow" role="option" aria-selected="${Boolean(cur)}" style="min-height:56px"><div class="grow col"><span class="t-body" style="${cur ? 'font-weight:600' : ''}">${t}</span><span class="t-foot muted">${s}</span></div>${cur ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`).join('')}</div></div>`
  return sheet({ w, h, top: Math.round(h * 0.4), title: 'Сортування', trail: closeBtn, body })
}

/** «⋯» action sheet «Дії з користувачем» (foundation action-sheet pattern; the M10 in-screen path). */
function rowActionsSheet(w, x) {
  const item = (ic, t, ink = 'var(--fg)') =>
    `<button type="button" style="appearance:none;margin:0;border:0;border-top:1px solid var(--separator);background:none;font:inherit;width:100%;height:56px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:17px;color:${ink}">${icon(ic, { size: 18 })}${t}</button>`
  return `<div class="scrim" style="z-index:70"></div><div role="dialog" aria-modal="true" aria-label="Дії з користувачем" style="position:absolute;left:8px;right:8px;bottom:${safeBottom(w) + 8}px;z-index:75;display:grid;gap:8px">
  <div style="background:var(--popover);border-radius:14px;border:1px solid var(--border);overflow:hidden;text-align:center"><div style="padding:14px 20px 12px"><div class="t-foot muted">Дії з користувачем</div><div class="t-sub" style="font-weight:600;margin-top:2px">${x.name}</div></div>
  ${item('user-round', 'Відкрити профіль', 'var(--primary)')}${item('pencil', 'Редагувати', 'var(--primary)')}${item('archive', 'Архівувати користувача', 'var(--destructive)')}</div>
  <button type="button" data-initial-focus style="appearance:none;margin:0;border:1px solid var(--border);background:var(--popover);border-radius:14px;font:inherit;width:100%;height:56px;font-size:17px;font-weight:600;color:var(--fg)">Скасувати</button></div>`
}

/** Create picker: every role except ADMIN (the create role list today). */
function rolePicker(w, h) {
  const body = `<div role="listbox" aria-label="Роль"><div class="group">${['Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп'].map((r) => roleOpt(r, r === 'Сеньйор')).join('')}</div></div>`
  return stacked(sheet({ w, h, top: Math.round(h * 0.48), title: 'Роль', trail: closeBtn, body }))
}

/** Edit sheet. state: '' | 'loading' | 'loadFailed' | 'pending' | 'failed' | 'unknown' (§2.9). */
function editSheet(w, h, o = {}) {
  const state = o.loading ? 'loading' : (o.state ?? '')
  const blocked = state === 'loading' || state === 'loadFailed'
  const pending = state === 'pending'
  const primary = pending ? 'Зберігаємо…' : state === 'unknown' ? 'Спробувати ще раз' : 'Зберегти'
  const bar = `<span class="btn primary" role="button"${blocked || pending ? ' aria-disabled="true"' : ''} style="width:100%${blocked ? ';opacity:0.5' : ''}">${pending ? F.spin : ''}${primary}</span>${pending ? '<span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Зберігаємо…</span>' : ''}`
  return formSheet(w, h, {
    title: 'Редагувати',
    leadText: 'Скасувати',
    body: F.editBody({ ...o, state }),
    bar,
    over: o.over ?? '',
  })
}

function archiveSheet(
  w,
  h,
  {
    armed = false,
    impact = 'shown',
    pending = false,
    failed = false,
    keyboard = false,
    unknown = false,
  } = {},
) {
  // The foundation textKeyboard() renders 301 px tall in this frame while TEXT_H says 290; the bar rides the real top edge.
  const kbdH = keyboard ? TEXT_H + 11 : 0
  const typed = armed || pending || failed || unknown ? 'Олег Ткач' : 'Олег Тк'
  // N2: with the keyboard up the impact collapses to one line, so the label and the field stay above the bar.
  const imp = keyboard ? 'summary' : impact
  const short = ['plain', 'loading', 'failed'].includes(imp) || unknown
  const bar = unknown
    ? `<span class="btn primary" role="button" style="width:100%">Перевірити</span>`
    : F.archiveBtn(armed || pending || failed, pending)
  const s = sheet({
    w,
    h,
    top: short ? Math.round(h * 0.28) : safeTop(w) + 10,
    title: 'Архівувати',
    lead: lead(unknown ? 'Закрити' : 'Скасувати'),
    body: `<div style="padding:4px 16px ${60 + (kbdH || safeBottom(w)) + 24}px">${F.archiveBody({ typed, impact: imp, pending, failed, unknown })}</div>`,
    footer: submitBar({ w, kbdH, inner: bar }),
  })
    .replace('role="dialog"', 'role="alertdialog" aria-describedby="ar-d"')
    .replace('aria-label="Архівувати"', 'aria-label="Архівувати користувача"')
  return usersScreen(w, h, { overlay: s + (keyboard ? textKeyboard() : ''), showFab: false })
}

const dirtyConfirm = (w, created = false) =>
  actionConfirm(w, {
    id: 'dc',
    title: 'Вийти без збереження?',
    desc: created
      ? 'Користувача вже створено. Незбережені зміни на цьому кроці буде втрачено.'
      : 'Користувача не створено — введені дані буде втрачено.',
    action: 'Вийти',
    cancel: 'Залишитися',
    overSheet: true,
    focusCancel: true,
  })
/** M4: closing while the create outcome is unknown says nothing is lost and what happens next. */
const closeUnknownConfirm = (w) =>
  actionConfirm(w, {
    id: 'cu',
    title: 'Закрити форму?',
    desc: `Ще невідомо, чи створено ${F.NEW.email}. Список оновиться, а над ним залишиться нагадування, доки це не з’ясується.`,
    action: 'Закрити',
    cancel: 'Залишитися',
    ink: 'var(--primary)',
    overSheet: true,
    focusCancel: true,
  })
/** M7: today's consequence sentence, from the catalog. */
const emailConfirm = (w) =>
  actionConfirm(w, {
    id: 'ec',
    title: 'Змінити email?',
    desc: 'Старий: oleh.tkach@example.com<br>Новий: oleh.tkach@example.org<br><br>Зміна email може розірвати вхід через Google для <b style="font-weight:600;color:var(--fg)">Олег Ткач</b>. Переконайтеся, що користувач знає про зміну і за потреби змінить свій обліковий запис Google.',
    action: 'Підтвердити зміну',
    ink: 'var(--primary)',
    overSheet: true,
    focusCancel: true,
  })

/** Full-height frame: the device grows to the content height (foundation primitives pattern). */
const C = (name, w, h, body) => ({ name, w, h, dpr: 2, full: true, html: page(body, { width: w }) })

const READY = 'Позначити готовим до підписання'
const DRAFT = 'Зберегти чернетку'
// Full-height frame heights (measured by measure.mjs: the sheet body must not clip)
const CREATE_3_H = 1150
const CREATE_3_JUNIOR_H = 1270
const CREATE_3_DROP_H = 1150
const CREATE_3_320_H = 1250
const EDIT_H = 2040
const EDIT_DROP_H = 1610
const EDIT_320_H = 2005
/** The page's own fallback panel (reachable only until the redirect to the role home has run). */
export const permissionBlock = (action = 'На головний екран') =>
  stateBlock({
    ic: 'lock',
    title: 'Доступ лише для адміністратора',
    text: 'Цей розділ відкривається тільки адміністраторам. Зазвичай вас одразу переносить на ваш головний екран.',
    action: `<span class="btn secondary" role="button">${icon('house', { size: 18 })}${action}</span>`,
  })

function mobileFrames() {
  const w = 375
  const h = 812
  const back = { back: true }
  const create = (name, o) => M(name, w, h, formSheet(w, h, o))
  const CREATE = 'Створити користувача'
  const LIST_H = 1180
  const fullList = (ww, hh) => usersScreen(ww, hh)
  const OLEH = USERS.find((x) => x.name === 'Олег Ткач')
  const SELF = USERS.find((x) => x.self)
  const swipeList = (who, kind) =>
    usersScreen(w, h, {
      extra: `${sortHead('38 користувачів')}<div class="group">${USERS.map((x) =>
        userRow(x, x.name === who ? { swipe: swipeActions(kind) } : {}),
      ).join('')}</div>`,
    })
  return [
    C('list-320', 320, LIST_H + 40, fullList(320, LIST_H + 40)),
    C('list-375', w, LIST_H, fullList(w, LIST_H)),
    M('role-filter-375', w, h, usersScreen(w, h, { overlay: roleFilter(w, h) })),
    M('sort-sheet-375', w, h, usersScreen(w, h, { overlay: sortSheet(w, h) })),
    M('loading-375', w, h, usersScreen(w, h, { sub: '', body: loadingBody() })),
    M(
      'filtered-375',
      w,
      h,
      usersScreen(w, h, {
        role: 'Сеньйор',
        rows: ROLE_SENIOR,
        count: `${ROLE_SENIOR.length} з 38`,
        sub: `${ROLE_SENIOR.length} з 38 активних`,
      }),
    ),
    M(
      'search-match-375',
      w,
      h,
      usersScreen(w, h, {
        q: 'go',
        rows: USERS.filter((x) => x.name === 'Олег Ткач'),
        count: '1 з 38',
        sub: '1 з 38 активних',
        match: {
          'Олег Ткач':
            'Технології: Djan<mark style="background:var(--yellow-subtle);color:var(--primary)">go</mark>, <mark style="background:var(--yellow-subtle);color:var(--primary)">Go</mark>',
        },
      }),
    ),
    M(
      'no-results-375',
      w,
      h,
      usersScreen(w, h, {
        sub: '0 з 38 активних',
        body: `${searchWith('Залізняк')}${filterRow(0, 'Сеньйор')}${noResults()}`,
      }),
    ),
    M('sorted-added-375', w, h, usersScreen(w, h, { sort: 'Додано', dir: '↓', rows: BY_ADDED })),
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
    M(
      'offline-375',
      w,
      h,
      usersScreen(w, h, {
        banner: offlineBanner(),
        rows: USERS.slice(0, 3),
        count: '3 користувачі',
        sub: '3 активні',
      }),
    ),
    M(
      'list-unknown-banner-375',
      w,
      h,
      usersScreen(w, h, {
        body: `${unknownBanner()}${listBody({ rows: USERS.slice(0, 3), count: '3 користувачі' })}`,
        sub: '3 активні',
      }),
    ),
    C('long-320', 320, 940, usersScreen(320, 940, { rows: [LONG, ...USERS.slice(0, 5)] })),
    M('long-375', w, h, usersScreen(w, h, { rows: [LONG, ...USERS.slice(0, 7)] })),
    M('swipe-375', w, h, swipeList('Дмитро Лисенко', 'active')),
    M('swipe-self-375', w, h, swipeList(SELF.name, 'self')),
    M(
      'row-actions-375',
      w,
      h,
      usersScreen(w, h, {
        extra: `${sortHead('38 користувачів')}<div class="group">${USERS.map((x) => userRow(x, { focusMore: x === OLEH })).join('')}</div>`,
        overlay: rowActionsSheet(w, OLEH),
      }),
    ),
    // create — three steps, then the result screen and the contract (N4)
    create('create-1-375', { step: 1, body: F.stepIdentity(), bar: F.actions() }),
    create('create-1-locked-375', {
      step: 1,
      body: F.stepIdentity({ locked: true, focus: '' }),
      bar: F.actions(),
    }),
    create('create-2-375', { step: 2, body: F.stepRole('SENIOR'), bar: F.actions(back) }),
    create('create-2-locked-375', {
      step: 2,
      body: F.stepRole('SENIOR', { locked: true }),
      bar: F.actions(back),
    }),
    create('create-2-junior-375', { step: 2, body: F.stepRole('JUNIOR'), bar: F.actions(back) }),
    create('create-2-drop-375', { step: 2, body: F.stepRole('DROP'), bar: F.actions(back) }),
    create('role-picker-375', {
      step: 2,
      body: F.stepRole('SENIOR'),
      bar: F.actions(back),
      over: rolePicker(w, h),
    }),
    C(
      'create-3-375',
      w,
      CREATE_3_H,
      formSheet(w, CREATE_3_H, {
        step: 3,
        body: F.stepPay('SENIOR'),
        bar: F.actions({ ...back, primary: CREATE }),
      }),
    ),
    C(
      'create-3-junior-375',
      w,
      CREATE_3_JUNIOR_H,
      formSheet(w, CREATE_3_JUNIOR_H, {
        step: 3,
        body: F.stepPay('JUNIOR'),
        bar: F.actions({ ...back, primary: CREATE }),
      }),
    ),
    C(
      'create-3-drop-375',
      w,
      CREATE_3_DROP_H,
      formSheet(w, CREATE_3_DROP_H, {
        step: 3,
        body: F.stepPay('DROP'),
        bar: F.actions({ ...back, primary: 'Створити дропа' }),
      }),
    ),
    C(
      'create-3-320',
      320,
      CREATE_3_320_H,
      formSheet(320, CREATE_3_320_H, {
        step: 3,
        body: F.stepPay('JUNIOR'),
        bar: F.actions({ ...back, primary: CREATE, stack: true }),
      }),
    ),
    // N3: while the POST is in flight the fields are read-only, the primary and «Назад» are aria-disabled, «Скасувати» stays
    create('create-pending-375', {
      step: 3,
      body: F.ro(F.stepPay('SENIOR', { filled: true })),
      bar: F.actions({ ...back, primary: 'Створюємо…', pending: true }),
    }),
    create('create-error-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.conflictAlert, filled: true }),
      bar: F.conflictBar(),
    }),
    M(
      'create-error-320',
      320,
      568,
      formSheet(320, 568, {
        step: 3,
        body: F.stepPay('SENIOR', { alert: F.conflictAlert, filled: true }),
        bar: F.conflictBar(),
      }),
    ),
    create('create-retry-older-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.olderAlert, filled: true }),
      bar: F.conflictBar(),
    }),
    create('create-failed-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.failAlert, filled: true }),
      bar: F.actions({ ...back, primary: CREATE }),
    }),
    create('create-unknown-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.unknownAlert, filled: true }),
      bar: F.actions({ ...back, primary: 'Спробувати ще раз' }),
    }),
    create('close-unknown-375', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.unknownAlert, filled: true }),
      bar: F.actions({ ...back, primary: 'Спробувати ще раз' }),
      over: closeUnknownConfirm(w),
    }),
    // result screen + contract
    create('create-result-375', {
      leadText: 'Закрити',
      body: F.stepResult(),
      bar: F.actions({ primary: 'Готово', secondary: 'Додати контракт' }),
    }),
    create('create-result-none-375', {
      leadText: 'Закрити',
      body: F.stepResult({ none: true }),
      bar: F.actions({ primary: 'Готово' }),
    }),
    create('create-4-375', {
      leadText: 'Закрити',
      body: F.stepContract(),
      bar: F.actions({ primary: READY, secondary: DRAFT }),
    }),
    create('create-4-saving-375', {
      leadText: 'Закрити',
      body: F.ro(F.stepContract({ saving: true })),
      bar: F.actions({
        primary: 'Зберігаємо…',
        pending: true,
        secondary: DRAFT,
        secondaryOff: true,
      }),
    }),
    create('create-4-save-failed-375', {
      leadText: 'Закрити',
      body: F.stepContract({ failed: true }),
      bar: F.actions({ primary: READY, secondary: DRAFT }),
    }),
    create('dirty-close-375', {
      step: 1,
      body: F.stepIdentity({ focus: '' }),
      bar: F.actions(),
      over: dirtyConfirm(w),
    }),
    M('edit-375', w, h, editSheet(w, h, { loading: true })),
    M('edit-load-failed-375', w, h, editSheet(w, h, { state: 'loadFailed' })),
    C('edit-loaded-375', w, EDIT_H, editSheet(w, EDIT_H, {})),
    C('edit-junior-375', w, 1950, editSheet(w, 1950, { role: 'JUNIOR' })),
    C('edit-drop-375', w, EDIT_DROP_H, editSheet(w, EDIT_DROP_H, { role: 'DROP' })),
    C('edit-320', 320, EDIT_320_H, editSheet(320, EDIT_320_H, {})),
    M('edit-self-375', w, h, editSheet(w, h, { self: true })),
    M('edit-save-pending-375', w, h, editSheet(w, h, { state: 'pending' })),
    M('edit-save-failed-375', w, h, editSheet(w, h, { state: 'failed' })),
    M('edit-save-unknown-375', w, h, editSheet(w, h, { state: 'unknown' })),
    M('email-change-375', w, h, editSheet(w, h, { over: emailConfirm(w) })),
    // N3: the sheet was closed while the save was in flight and it failed — the banner reopens the form
    M(
      'list-write-failed-banner-375',
      w,
      h,
      usersScreen(w, h, {
        body: `${failedBanner()}${listBody({ rows: USERS.slice(0, 3), count: '3 користувачі' })}`,
        sub: '3 активні',
      }),
    ),
    // N6: archive / restore that got no answer — the sheet closed, the banner keeps the doubt visible until «Перевірити»
    M(
      'list-archive-unknown-banner-375',
      w,
      h,
      usersScreen(w, h, {
        body: `${archiveUnknownBanner()}${listBody({ rows: USERS.slice(0, 3), count: '3 користувачі' })}`,
        sub: '3 активні',
      }),
    ),
    M('archive-impact-loading-375', w, h, archiveSheet(w, h, { impact: 'loading' })),
    M('archive-impact-failed-375', w, h, archiveSheet(w, h, { impact: 'failed' })),
    M('archive-confirm-375', w, h, archiveSheet(w, h)),
    M('archive-confirm-keyboard-375', w, h, archiveSheet(w, h, { keyboard: true })),
    M('archive-armed-375', w, h, archiveSheet(w, h, { armed: true })),
    M('archive-pending-375', w, h, archiveSheet(w, h, { pending: true })),
    M('archive-failed-375', w, h, archiveSheet(w, h, { failed: true })),
    M('archive-unknown-375', w, h, archiveSheet(w, h, { unknown: true })),
    // N5: nothing attached → plain confirm, then the toast with «Відновити»
    M('archive-plain-confirm-375', w, h, archiveSheet(w, h, { impact: 'plain', armed: true })),
    M(
      'archive-undo-toast-375',
      w,
      h,
      usersScreen(w, h, {
        rows: USERS.filter((x) => x.name !== 'Юлія Гнатюк'),
        count: '37 користувачів',
        sub: '37 активних',
        overlay: undoToast(w),
      }),
    ),
    M(
      'permission-375',
      w,
      h,
      usersScreen(w, h, {
        sub: '',
        showFab: false,
        navRole: 'SENIOR',
        active: '',
        body: permissionBlock(),
      }),
    ),
    // N13: HR and ACCOUNTANT get the same panel with their own navigation (no «Користувачі» entry)
    M(
      'permission-hr-375',
      w,
      h,
      usersScreen(w, h, {
        sub: '',
        showFab: false,
        navRole: 'HR',
        active: '',
        body: permissionBlock(),
      }),
    ),
    M(
      'permission-accountant-375',
      w,
      h,
      usersScreen(w, h, {
        sub: '',
        showFab: false,
        navRole: 'ACCOUNTANT',
        active: '',
        body: permissionBlock(),
      }),
    ),
  ]
}

// ---------- frames ----------
export function frames() {
  return [...mobileFrames(), ...wideFrames()]
}
