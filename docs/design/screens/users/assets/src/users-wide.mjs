// Users screen — tablet (640–1023) and desktop (≥ 1024) frames. Same data and form bodies as the phone.
import { icon, page, segmented } from '../../../_foundation/assets/src/base.mjs'
import { searchField } from '../../../_foundation/assets/src/mobile.mjs'
import { stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'
import * as F from './users-forms.mjs'
import { USERS, ARCHIVED, LONG, R, userRow, filterRow, sortHead, youPill } from './users.mjs'

const D = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })
const T = (name, w, h, body) => ({ name, w, h, dpr: 1, html: page(body, { width: w }) })
const kbd = (k, onPrimary = false) =>
  `<span class="kbdkey"${onPrimary ? ' style="background:oklch(0 0 0 / 0.12);border-color:oklch(0 0 0 / 0.2);color:var(--primary-fg)"' : ''}>${k}</span>`
const SCRIM = (z = 60) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:${z}"></div>`

// ---------- desktop table ----------
const av = (x, s = 28) =>
  `<span aria-hidden="true" style="width:${s}px;height:${s}px;border-radius:${s / 2}px;flex:none;display:grid;place-items:center;font-size:11px;font-weight:600;${x.archived ? 'background:var(--surface);color:var(--muted-fg)' : 'background:var(--yellow-subtle);color:var(--primary)'}">${x.i}</span>`
const techCell = (t, max = 3) =>
  t.length
    ? `<span class="row" style="gap:4px">${t
        .slice(0, max)
        .map(
          (s) => `<span class="pill" style="height:22px;font-size:12px;padding:0 8px">${s}</span>`,
        )
        .join(
          '',
        )}${t.length > max ? `<span class="t-cap muted num">+${t.length - max}</span>` : ''}</span>`
    : '<span class="muted">—</span>'

/** Row actions: «Редагувати» icon + «⋯» menu; visible on hover / focus-within, always present for keyboard. */
function rowActions(x, { shown = false, touch = false } = {}) {
  if (x.otherAdmin) return '' // an ADMIN cannot edit or archive another ADMIN — no controls at all
  const s = touch ? 44 : 32
  const btn = (ic, label, extra = '') =>
    `<button type="button" class="iconbtn" aria-label="${label}" ${extra} style="width:${s}px;height:${s}px;color:var(--muted-fg)">${icon(ic, { size: 16 })}</button>`
  const set = x.archived
    ? btn('archive-restore', `Відновити з архіву ${x.name}`)
    : btn('pencil', `Редагувати ${x.name}`)
  return `<span class="row" style="gap:2px;justify-content:flex-end;${shown || touch ? '' : 'opacity:0'}">${set}${btn('ellipsis', `Дії: ${x.name}`, 'aria-haspopup="menu"')}</span>`
}

const SORTABLE = ['Користувач', 'Роль', 'Додано'] // today's sort keys: name / role / date added
const link = (href, v) => `<a href="${href}" style="color:inherit;text-decoration:none">${v}</a>`

function userTable(
  w,
  rows,
  { hover = -1, selected = -1, touch = false, sortCol = 'Користувач', skeleton = 0 } = {},
) {
  // Fixed layout: Email is the one flexible column, so nothing ever pushes «Додано» / actions off-screen.
  // Телефон is not a list column (it lives in the detail pane / profile); Технології ≥ 1280, Telegram ≥ 1440.
  const wide = w >= 1280
  const tg = w >= 1440
  const cols = wide
    ? [
        ['Користувач', 230],
        ['Роль', 124],
        ['Email', 0],
        ...(tg ? [['Telegram', 136]] : []),
        ['Технології', 210],
        ['Додано', 124],
        ['', touch ? 104 : 84],
      ]
    : [
        ['Користувач', 210],
        ['Роль', 128],
        ['Email', 0],
        ['Додано', touch ? 136 : 116],
        ['', touch ? 104 : 84],
      ]
  const colgroup = `<colgroup>${cols.map(([, cw]) => `<col${cw ? ` style="width:${cw}px"` : ''}>`).join('')}</colgroup>`
  const th = cols
    .map(
      ([c]) =>
        `<th scope="col" style="text-align:left"${SORTABLE.includes(c) ? ` aria-sort="${c === sortCol ? 'ascending' : 'none'}"` : ''}>${c ? `<span style="display:inline-flex;align-items:center;gap:4px">${c}${c === sortCol ? icon('arrow-up', { size: 12 }) : ''}</span>` : '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Дії</span>'}</th>`,
    )
    .join('')
  // Loading: skeleton rows in the final cell shapes, one per column.
  const skCell = (c, j) =>
    `<td>${
      j === 0
        ? '<span class="row" style="gap:10px"><span class="sk" style="width:28px;height:28px;border-radius:14px;flex:none"></span><span class="sk" style="height:12px;width:60%"></span></span>'
        : c
          ? `<span class="sk" style="display:block;height:12px;width:${[0, 70, 75, 60, 80, 55][j] ?? 60}%"></span>`
          : ''
    }</td>`
  const skRows = Array.from(
    { length: skeleton },
    () => `<tr>${cols.map(([c], j) => skCell(c, j)).join('')}</tr>`,
  ).join('')
  const tr = rows
    .map((x, i) => {
      const dim = x.archived ? 'color:var(--muted-fg)' : ''
      const cells = [
        `<td><span class="row" style="gap:10px;min-width:0">${av(x)}<a href="#" class="trunc" style="font-weight:500;color:inherit;text-decoration:none;${dim}">${x.name}</a>${x.self ? youPill : ''}${x.archived ? `<span class="pill" style="height:20px;font-size:11px;color:var(--muted-fg)">${icon('archive', { size: 12 })}В архіві</span>` : ''}</span></td>`,
        `<td style="${dim}">${R[x.role]}</td>`,
        `<td class="muted">${link(`mailto:${x.email}`, x.email)}</td>`,
        ...(wide
          ? [
              ...(tg
                ? [
                    `<td class="muted">${x.tg ? link(`https://t.me/${x.tg.slice(1)}`, x.tg) : '—'}</td>`,
                  ]
                : []),
              `<td>${techCell(x.tech, 2)}</td>`,
            ]
          : []),
        `<td class="muted num">${x.archived ? x.archived : x.added}</td>`,
        `<td style="text-align:right;padding-right:8px">${rowActions(x, { shown: i === hover, touch })}</td>`,
      ]
      const st =
        i === selected
          ? ' aria-selected="true" style="background:var(--raised)"'
          : i === hover
            ? ' style="background:oklch(0.15 0.004 85)"'
            : ''
      return `<tr${st}>${cells.join('')}</tr>`
    })
    .join('')
  return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:14px">${colgroup}<thead><tr>${th}</tr></thead><tbody>${skRows}${tr}</tbody></table>`
}

const STATUS = ['Активні', 'Архів', 'Усі']
function toolbar(w, { seg = 0, role = '', q = '', count = '38 користувачів', touch = false } = {}) {
  const hgt = touch ? 44 : 32
  const tabs = `<div role="radiogroup" aria-label="Статус" class="row" style="gap:2px;padding:2px;border-radius:9px;background:var(--surface);border:1px solid var(--border)">${STATUS.map(
    (t, i) =>
      `<span role="radio" aria-checked="${i === seg}" style="height:${touch ? 44 : hgt - 6}px;padding:0 12px;border-radius:7px;display:grid;place-items:center;font-size:13px;font-weight:600;${i === seg ? 'background:var(--fg);color:var(--bg)' : 'color:var(--muted-fg)'}">${t}</span>`,
  ).join('')}</div>`
  const roleChip = role
    ? `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:${hgt}px;padding:0 10px;border-radius:8px;background:var(--yellow-subtle);color:var(--primary);border:1px solid oklch(0.32 0.06 85);font-size:13px;font-weight:500">Роль: ${role}${icon('x', { size: 13 })}</span>`
    : `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:${hgt}px;padding:0 10px;border-radius:8px;border:1px dashed var(--input-border);font-size:13px;color:var(--muted-fg)">${icon('plus', { size: 13 })}Роль</span>`
  return `<div class="row" style="gap:8px"><span class="row dsearch" style="gap:8px;height:${hgt}px;width:${w >= 1280 ? 300 : 240}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:${q ? 'var(--fg)' : 'var(--muted-fg)'};font-size:13px">${icon('search', { size: 14 })}<span class="grow trunc">${q || 'Ім’я, email, Telegram…'}</span>${q ? icon('x', { size: 14 }) : kbd('/')}</span>${tabs}${roleChip}<span class="grow"></span><span class="t-foot muted num" role="status">${count}</span></div>`
}
const card = (inner) =>
  `<div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)">${inner}</div>`

function usersDesk(w, h, o = {}) {
  const rows = o.rows ?? USERS
  const content = o.content ?? `${toolbar(w, o)}${card(o.inner ?? userTable(w, rows, o))}`
  return desktop({
    w,
    h,
    active: '/users',
    crumb: ['Люди', 'Користувачі'],
    cta: 'Додати користувача',
    content,
    overlay: o.overlay ?? '',
    touch: o.touch ?? false,
  })
}

// ---------- side panel (≥ 1440 non-modal 480; 1024–1439 modal 420; tablet 400 touch) ----------
const PANEL_CSS = `<style>.dpanel .field label{font-size:13px}.dpanel .input{height:40px;font-size:14px;border-radius:8px}.dpanel .hint{font-size:12px;line-height:16px}.dpanel [role=radiogroup]{min-height:36px}.dpanel [role=radiogroup]>span{height:36px}.dpanel [role=radiogroup]>span>span{height:28px;font-size:13px}.dpanel .t-over{font-size:11px}</style>`
function panel(
  width,
  {
    modal = true,
    touch = false,
    title = 'Новий користувач',
    step = 0,
    steps = F.STEPS,
    body,
    foot,
    z = 70,
  },
) {
  const head = touch
    ? `<div class="row" style="height:60px;flex:none;padding:0 8px;border-bottom:1px solid var(--border)"><button type="button" class="btn ghost" style="height:44px;font-size:17px;font-weight:400;padding:0 12px">Скасувати</button><div id="pn-t" class="grow t-head" style="text-align:center">${title}</div><span style="width:104px"></span></div>`
    : `<div class="row" style="height:56px;flex:none;padding:0 12px 0 24px;border-bottom:1px solid var(--border)"><div id="pn-t" class="grow t-head">${title}</div>${kbd('Esc')}<button type="button" class="iconbtn" aria-label="Закрити" style="width:32px;height:32px;margin-left:6px">${icon('x', { size: 18 })}</button></div>`
  const pad = touch ? 24 : 24
  return `${modal ? SCRIM(z - 10) : ''}${touch ? '' : PANEL_CSS}<aside role="dialog"${modal ? ' aria-modal="true"' : ''} aria-labelledby="pn-t" class="${touch ? '' : 'dpanel'}" style="position:absolute;top:0;right:0;bottom:0;width:${width}px;z-index:${z};background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / ${modal ? 0.5 : 0.35});display:flex;flex-direction:column">
  ${head}<div class="grow" style="min-height:0;overflow:hidden"><div class="col" style="gap:${touch ? 16 : 14}px;padding:16px ${pad}px 24px">${step ? F.stepper(step, steps) : ''}${body}</div></div>
  <div style="padding:12px ${pad}px ${touch ? 20 : 14}px;border-top:1px solid var(--border)">${foot}</div></aside>`
}
/** Desktop footer: «Назад» left, «Скасувати» + primary (⌘↵) right; tablet uses the phone action bar. */
// cancel: «Скасувати» before the create POST, «Закрити» after it (the user exists, nothing to discard).
const dFoot = ({
  back = false,
  primary = 'Далі',
  pending = false,
  secondary = '',
  cancel = 'Скасувати',
  hint = true, // the ⌘↵ hint is dropped when the primary label is long (still works)
} = {}) =>
  `<div class="row" style="gap:8px">${back ? '<span class="btn sm secondary" style="height:36px;font-size:14px">Назад</span>' : ''}<span class="grow"></span>${secondary ? `<span class="btn sm secondary" style="height:36px;font-size:14px">${secondary}</span>` : `<span class="btn sm ghost" style="height:36px;font-size:14px">${cancel}</span>`}<span class="btn sm primary" style="height:36px;font-size:14px"${pending ? ' aria-disabled="true"' : ''}>${pending ? '<span aria-hidden="true" style="width:14px;height:14px;border-radius:7px;border:2px solid oklch(0 0 0 / 0.25);border-top-color:var(--primary-fg)"></span>' : ''}${primary}${pending || !hint ? '' : kbd('⌘↵', true)}</span></div>`

const deskPanel = (w, o) => panel(w >= 1440 ? 480 : 420, { modal: w < 1440, ...o })

// ---------- desktop dialogs ----------
const dialog = (width, inner, { role = 'alertdialog', z = 80 } = {}) =>
  `${SCRIM(z - 2)}<div role="${role}" aria-modal="true" aria-labelledby="dg-t" aria-describedby="dg-d" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${width}px;z-index:${z};background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">${inner}</div>`
const focusRing = 'box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)'
const dirtyDialog = () =>
  dialog(
    420,
    `<div id="dg-t" class="t-head">Вийти без збереження?</div><div id="dg-d" class="t-foot muted" style="margin-top:6px;font-size:14px;line-height:20px">Введені дані буде втрачено.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px;font-size:14px;${focusRing}">Залишитися</span><span class="btn sm" style="height:36px;font-size:14px;background:var(--destructive);color:#fff">Вийти</span></div>`,
  )
const archiveDialog = (armed = false) =>
  dialog(
    520,
    `<div id="dg-t" class="t-head">Архівувати користувача</div><div class="dpanel" style="margin-top:12px">${PANEL_CSS}${F.archiveBody({ typed: armed ? 'Олег Ткач' : 'Олег Тк' }).replace('id="ar-d"', 'id="dg-d"')}</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px;font-size:14px">Скасувати</span><span class="btn sm" style="height:36px;font-size:14px;background:var(--destructive);color:#fff;${armed ? '' : 'opacity:0.45'}"${armed ? '' : ' aria-disabled="true"'}>${icon('archive', { size: 15 })}Архівувати</span></div>`,
  )
const emailDialog = () =>
  dialog(
    420,
    `<div id="dg-t" class="t-head">Змінити email?</div><div id="dg-d" class="t-foot" style="margin-top:8px;font-size:14px;line-height:22px"><span class="muted">Старий:</span> oleh.tkach@example.com<br><span class="muted">Новий:</span> oleh.tkach@example.org</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px;font-size:14px;${focusRing}">Скасувати</span><span class="btn sm primary" style="height:36px;font-size:14px">Підтвердити зміну</span></div>`,
  )

/** Row «⋯» menu (anchored to the hovered row). Self: archive disabled with its reason. */
function rowMenu(top, right, { self = false } = {}) {
  const it = (ic, t, { danger = false, off = '' } = {}) =>
    `<div role="menuitem"${off ? ' aria-disabled="true"' : ''} class="row" style="gap:10px;height:36px;padding:0 12px;font-size:14px;${danger ? 'color:var(--destructive)' : ''}${off ? ';opacity:0.5' : ''}">${icon(ic, { size: 16 })}<span class="grow">${t}</span>${off ? `<span class="t-cap muted">${off}</span>` : ''}</div>`
  return `<div role="menu" aria-label="Дії з користувачем" style="position:absolute;top:${top}px;right:${right}px;width:${self ? 320 : 240}px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px 0">
  ${it('user-round', 'Відкрити профіль')}${it('pencil', 'Редагувати')}<div style="height:1px;background:var(--separator);margin:4px 0"></div>${self ? it('archive', 'Архівувати…', { danger: true, off: 'Не можна архівувати себе' }) : it('archive', 'Архівувати…', { danger: true })}</div>`
}

// ---------- tablet ----------
const tabList = (w, { selected = -1, rows = USERS } = {}) =>
  `<section aria-label="Користувачі" class="col" style="width:360px;flex:none;border-right:1px solid var(--border)">
  <div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Користувачі</div><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  <div style="flex:1;min-height:0;overflow:hidden">${searchField('Ім’я, email, Telegram…')}${filterRow(0)}${sortHead('38 користувачів')}<div class="group" style="margin:0 12px">${rows
    .map((x, i) => userRow(x, { selected: i === selected }))
    .join('')}</div></div></section>`

/** ≥ 900 detail pane: built only from the list row (0 extra requests) + «Відкрити профіль». */
function detailPane(x) {
  // An empty contact is omitted, not shown as a bare label.
  const line = (ic, label, v, href = true) =>
    !v
      ? ''
      : `<div class="lrow" style="--inset:52px;min-height:52px"><span class="muted" style="width:24px;display:grid;place-items:center">${icon(ic, { size: 18 })}</span><div class="grow col" style="gap:1px;min-width:0"><div class="t-cap muted">${label}</div><div class="t-body trunc" style="${href ? 'color:var(--primary)' : ''}">${v}</div></div></div>`
  return `<section aria-label="Користувач" class="grow col" style="background:var(--bg);min-width:0">
  <div class="row" style="height:56px;padding:0 8px 0 20px;gap:4px;border-bottom:1px solid var(--border);flex:none"><div class="grow"></div><button type="button" class="btn ghost" style="height:44px;padding:0 10px;font-size:17px;font-weight:500;color:var(--primary)">Редагувати</button><button type="button" class="iconbtn" aria-label="Дії з користувачем" aria-haspopup="menu">${icon('ellipsis', { size: 22 })}</button></div>
  <div style="flex:1;min-height:0;overflow:hidden;padding:20px 16px 24px" class="col">
  <div class="row" style="gap:14px;padding:0 4px 18px">${av(x, 64).replace('font-size:11px', 'font-size:20px')}<div class="col" style="gap:4px;min-width:0"><div class="t-title trunc">${x.name}</div><div class="t-sub muted">${R[x.role]} · додано ${x.added}</div></div></div>
  <div class="group" style="margin:0">${line('mail', 'Email', x.email)}${line('send', 'Telegram', x.tg)}${line('phone', 'Телефон', x.phone)}</div>
  <div class="t-over" style="padding:18px 4px 8px">Технології</div><div class="row" style="gap:6px;flex-wrap:wrap;padding:0 4px">${x.tech.map((t) => `<span class="pill" style="height:28px;font-size:14px">${t}</span>`).join('')}</div>
  <div style="padding:22px 4px 0"><span class="btn secondary" role="link" style="width:100%">${icon('user-round', { size: 18 })}Відкрити профіль</span></div>
  <div class="t-foot muted" style="padding:10px 4px 0">Фінанси, контракти й документи — у профілі.</div></div></section>`
}

const touchFoot = (o) => F.actions(o)

export function wideFrames() {
  const STEPS_CREATE = { step: 1, body: F.stepIdentity({ focus: '' }) }
  const CREATE = 'Створити користувача'
  return [
    // tablet
    T('list-768', 768, 1024, tablet({ w: 768, h: 1024, active: '/users', list: tabList(768) })),
    T(
      'list-960',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, { selected: 6 }),
        detail: detailPane(USERS[6]),
      }),
    ),
    T(
      'create-768',
      768,
      1024,
      tablet({
        w: 768,
        h: 1024,
        active: '/users',
        list: tabList(768),
        overlay: panel(400, { touch: true, step: 1, body: F.stepIdentity(), foot: touchFoot({}) }),
      }),
    ),
    T(
      'create-3-768',
      768,
      1024,
      tablet({
        w: 768,
        h: 1024,
        active: '/users',
        list: tabList(768),
        overlay: panel(400, {
          touch: true,
          step: 3,
          body: F.stepPay('SENIOR'),
          foot: touchFoot({ back: true, primary: CREATE }),
        }),
      }),
    ),
    // desktop main
    D('list-1024', 1024, 768, usersDesk(1024, 768, { hover: 2 })),
    D('list-1280', 1280, 800, usersDesk(1280, 800, { hover: 2 })),
    D('list-1440', 1440, 900, usersDesk(1440, 900, { hover: 2 })),
    D('touch-1024', 1024, 768, usersDesk(1024, 768, { touch: true })),
    // desktop states
    D(
      'loading-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        inner: `<div role="status" aria-label="Завантаження користувачів">${userTable(1440, [], { skeleton: 10 })}</div>`,
        count: '',
      }),
    ),
    D(
      'filtered-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        role: 'Сеньйор',
        rows: USERS.filter((x) => x.role === 'SENIOR'),
        count: '3 з 38',
      }),
    ),
    D(
      'no-results-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        role: 'Сеньйор',
        q: 'Залізняк',
        count: '0 з 38',
        inner: stateBlock({
          ic: 'search-x',
          title: 'Нічого не знайдено — скиньте фільтри',
          text: 'Немає користувачів, що відповідають пошуку «Залізняк» і ролі «Сеньйор».',
          action: `<span class="btn sm secondary" style="height:36px;font-size:14px">${icon('rotate-ccw', { size: 15 })}Скинути фільтри</span>`,
        }),
      }),
    ),
    D(
      'archive-1440',
      1440,
      900,
      usersDesk(1440, 900, { seg: 1, rows: ARCHIVED, count: '3 в архіві', hover: 0 }),
    ),
    D(
      'archive-empty-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        seg: 1,
        count: '0 в архіві',
        inner: stateBlock({
          ic: 'archive',
          title: 'В архіві нікого немає',
          text: 'Тут з’являться архівовані користувачі. Будь-кого з них можна відновити.',
        }),
      }),
    ),
    D(
      'error-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        count: '',
        inner: stateBlock({
          ic: 'cloud-alert',
          tone: 'var(--destructive)',
          role: 'alert',
          title: 'Не вдалося завантажити користувачів',
          text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
          action: `<span class="btn sm secondary" style="height:36px;font-size:14px">${icon('rotate-cw', { size: 15 })}Спробувати ще раз</span>`,
        }),
      }),
    ),
    D('long-1440', 1440, 900, usersDesk(1440, 900, { rows: [LONG, ...USERS] })),
    D('long-1024', 1024, 768, usersDesk(1024, 768, { rows: [LONG, ...USERS] })),
    D('row-menu-1440', 1440, 900, usersDesk(1440, 900, { hover: 2, overlay: rowMenu(275, 40) })),
    D(
      'row-menu-self-1440',
      1440,
      900,
      usersDesk(1440, 900, { hover: 1, overlay: rowMenu(235, 40, { self: true }) }),
    ),
    // desktop create / edit
    D(
      'create-1-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, { step: 1, body: F.stepIdentity(), foot: dFoot() }),
      }),
    ),
    D(
      'create-1-1024',
      1024,
      768,
      usersDesk(1024, 768, {
        overlay: deskPanel(1024, { step: 1, body: F.stepIdentity(), foot: dFoot() }),
      }),
    ),
    D(
      'create-2-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, {
          step: 2,
          body: F.stepRole('SENIOR'),
          foot: dFoot({ back: true }),
        }),
      }),
    ),
    D(
      'create-3-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, {
          step: 3,
          body: F.stepPay('JUNIOR'),
          foot: dFoot({ back: true, primary: CREATE }),
        }),
      }),
    ),
    D(
      'create-unknown-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, {
          step: 3,
          body: F.stepPay('SENIOR', { alert: F.unknownAlert }),
          foot: dFoot({ back: true, primary: 'Спробувати ще раз' }),
        }),
      }),
    ),
    D(
      'create-4-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, {
          step: 4,
          body: F.stepContract(),
          foot: dFoot({ back: true, cancel: 'Закрити' }),
        }),
      }),
    ),
    D(
      'create-5-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, {
          step: 5,
          body: F.stepConfirm(),
          foot: dFoot({
            primary: 'Позначити готовим до підписання',
            secondary: 'Зберегти чернетку',
            hint: false,
          }),
        }),
      }),
    ),
    D(
      'dirty-close-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        overlay: deskPanel(1440, { ...STEPS_CREATE, foot: dFoot() }) + dirtyDialog(),
      }),
    ),
    D(
      'edit-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        selected: 6,
        overlay: deskPanel(1440, {
          title: 'Редагувати користувача',
          body: F.editBody({ loading: true }),
          foot: dFoot({ primary: 'Зберегти', pending: false }).replace(
            'class="btn sm primary" style="',
            'class="btn sm primary" aria-disabled="true" style="opacity:0.5;',
          ),
        }),
      }),
    ),
    D(
      'email-change-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        selected: 6,
        overlay:
          deskPanel(1440, {
            title: 'Редагувати користувача',
            body: F.editBody({ loading: false }),
            foot: dFoot({ primary: 'Зберегти' }),
          }) + emailDialog(),
      }),
    ),
    D(
      'archive-confirm-1440',
      1440,
      900,
      usersDesk(1440, 900, { selected: 6, overlay: archiveDialog(false) }),
    ),
    D(
      'archive-armed-1440',
      1440,
      900,
      usersDesk(1440, 900, { selected: 6, overlay: archiveDialog(true) }),
    ),
    D(
      'permission-1440',
      1440,
      900,
      // A non-admin has no «Додати користувача» CTA and no active «Користувачі» item: both removed.
      // shortcut: the foundation desktop() always draws the ADMIN sidebar; a real non-admin sees their own nav.
      desktop({
        w: 1440,
        h: 900,
        active: '',
        crumb: ['Люди', 'Користувачі'],
        content: stateBlock({
          ic: 'lock',
          title: 'Доступ лише для адміністратора',
          text: 'Цей розділ відкривається тільки адміністраторам. Зазвичай вас одразу переносить на ваш головний екран.',
        }),
      }).replace(/<span class="btn primary"[\s\S]*?<\/span><\/span><\/header>/, '</header>'),
    ),
  ]
}
