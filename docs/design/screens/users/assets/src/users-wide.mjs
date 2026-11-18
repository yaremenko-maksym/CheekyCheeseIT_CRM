// Users screen — tablet (640–1023) and desktop (≥ 1024) frames. Same data and form bodies as the phone.
import { icon, page, segmented } from '../../../_foundation/assets/src/base.mjs'
import { searchField } from '../../../_foundation/assets/src/mobile.mjs'
import { stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'
import { textKeyboard } from '../../../_foundation/assets/src/money-form.mjs'
import * as F from './users-forms.mjs'
import {
  USERS,
  ARCHIVED,
  LONG,
  R,
  userRow,
  filterRow,
  sortHead,
  youPill,
  moreBtn,
  unknownBanner,
  failedBanner,
  archiveUnknownBanner,
  archiveFailedBanner,
  foldBanner,
  CHECK_FAILED_NOTE,
  permissionBlock,
} from './users.mjs'

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

// Desktop shell geometry (foundation desktop()): sidebar 248, main padding 24 + 24, card border 1 + 1.
const SIDE = 248
const MIN_EMAIL = 240
/**
 * P11: the foundation caps the content column at 1280 and leaves it left-aligned. The non-modal 480 panel is fixed to the
 * viewport's right edge, so the column gives up only the part the panel would cover: all 480 px up to 1528, less above it, none from 2008.
 */
const panelShift = (w) => Math.max(0, 480 - Math.max(0, w - SIDE - 1280))
const ACT_W = (touch) => (touch ? 124 : 84) // two 44 px targets + gap + padding, or two 32 px ones

/**
 * R2-12 / N11: Email is the one flexible column and is never squeezed below MIN_EMAIL.
 * Optional columns are dropped in this order until it fits: Telegram, Технології, Додано
 * (so with the 480 px panel open «Додано» goes). A coarse pointer below 1280 stacks the email under the name.
 */
export function tableCols(w, { touch = false, archivedCol = false, panelOpen = false } = {}) {
  const act = ACT_W(touch)
  if (touch && w < 1280)
    return {
      stacked: true,
      avail: w - SIDE - 50,
      cols: [
        ['Користувач', 0],
        ['Роль', 150],
        ...(archivedCol ? [['Архівовано', 124]] : []),
        ['Додано', 136],
        ['', act],
      ],
    }
  const avail = Math.min(w - SIDE, 1280) - 50 - (panelOpen ? panelShift(w) : 0)
  let opt = [
    ...(w >= 1440 ? [['Telegram', 128]] : []),
    ...(w >= 1280 ? [['Технології', 170]] : []),
    ...(archivedCol ? [['Архівовано', 124]] : []),
    ['Додано', 136],
  ]
  const fixed = () => 220 + 124 + act + opt.reduce((a, [, cw]) => a + cw, 0)
  for (const drop of ['Telegram', 'Технології', 'Додано'])
    if (avail - fixed() < MIN_EMAIL) opt = opt.filter(([c]) => c !== drop)
  return {
    stacked: false,
    avail,
    cols: [['Користувач', 220], ['Роль', 124], ['Email', 0], ...opt, ['', act]],
  }
}

function userTable(
  w,
  rows,
  {
    hover = -1,
    selected = -1,
    touch = false,
    sortCol = 'Користувач',
    skeleton = 0,
    archivedCol = false,
    panelOpen = false,
  } = {},
) {
  const { stacked, cols } = tableCols(w, { touch, archivedCol, panelOpen })
  const rowH = stacked ? 60 : 0
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
  const tdH = rowH ? ` style="height:${rowH}px"` : ''
  const tr = rows
    .map((x, i) => {
      const dim = x.archived ? 'color:var(--muted-fg)' : ''
      const name = stacked
        ? `<td${tdH}><a href="#" class="row" style="gap:10px;min-width:0;min-height:44px;color:inherit;text-decoration:none">${av(x)}<span class="col" style="gap:1px;min-width:0"><span class="row" style="gap:6px;min-width:0"><span class="trunc" style="font-weight:500;${dim}">${x.name}</span>${x.self ? youPill : ''}</span><span class="muted trunc" style="font-size:13px" title="${x.email}">${x.email}</span></span></a></td>`
        : `<td><span class="row" style="gap:10px;min-width:0">${av(x)}<a href="#" class="trunc" style="font-weight:500;color:inherit;text-decoration:none;${dim}">${x.name}</a>${x.self ? youPill : ''}</span></td>`
      const by = {
        Користувач: name,
        Роль: `<td style="${dim}${rowH ? `;height:${rowH}px` : ''}">${R[x.role]}</td>`,
        Email: `<td class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${x.email}">${link(`mailto:${x.email}`, x.email)}</td>`,
        Telegram: `<td class="muted">${x.tg ? link(`https://t.me/${x.tg.slice(1)}`, x.tg) : '—'}</td>`,
        Технології: `<td>${techCell(x.tech, 2)}</td>`,
        Архівовано: `<td class="num"${tdH}>${x.archived ?? ''}</td>`,
        Додано: `<td class="muted num"${tdH}>${x.added}</td>`,
        '': `<td${tdH} style="text-align:right;padding-right:8px${rowH ? `;height:${rowH}px` : ''}">${rowActions(x, { shown: i === hover, touch })}</td>`,
      }
      const st =
        i === selected
          ? ' aria-selected="true" style="background:var(--raised)"'
          : i === hover
            ? ' style="background:oklch(0.15 0.004 85)"'
            : ''
      return `<tr${st}>${cols.map(([c]) => by[c]).join('')}</tr>`
    })
    .join('')
  return `<table style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:14px">${colgroup}<thead><tr>${th}</tr></thead><tbody>${skRows}${tr}</tbody></table>`
}

const STATUS = ['Активні', 'Архів', 'Усі']
function toolbar(
  w,
  {
    seg = 0,
    role = '',
    q = '',
    count = '38 користувачів',
    touch = false,
    sort = false,
    panelOpen = false,
  } = {},
) {
  const hgt = touch ? 44 : 32
  const tabs = `<div role="radiogroup" aria-label="Статус" class="row" style="gap:2px;padding:2px;border-radius:9px;background:var(--surface);border:1px solid var(--border)">${STATUS.map(
    (t, i) =>
      `<span role="radio" aria-checked="${i === seg}" style="height:${touch ? 44 : hgt - 6}px;min-width:${touch ? 44 : 0}px;padding:0 12px;border-radius:7px;display:grid;place-items:center;font-size:13px;font-weight:600;${i === seg ? 'background:var(--fg);color:var(--bg)' : 'color:var(--muted-fg)'}">${t}</span>`,
  ).join('')}</div>`
  const roleChip = role
    ? `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:${hgt}px;padding:0 10px;border-radius:8px;background:var(--yellow-subtle);color:var(--primary);border:1px solid oklch(0.32 0.06 85);font-size:13px;font-weight:500">Роль: ${role}<span role="button" aria-label="Скинути роль" style="display:grid;place-items:center;width:${touch ? 44 : 24}px;height:${touch ? 44 : 24}px;margin:0 ${touch ? -12 : -6}px 0 ${touch ? -4 : 0}px">${icon('x', { size: touch ? 16 : 13 })}</span></span>`
    : `<span class="row" role="button" aria-haspopup="listbox" style="gap:6px;height:${hgt}px;padding:0 10px;border-radius:8px;border:1px dashed var(--input-border);font-size:13px;color:var(--muted-fg)">${icon('plus', { size: 13 })}Роль</span>`
  // P10: «Додано» is not a column here, so its sort lives in a menu beside the filters (same options as the phone sort sheet)
  const sortBtn = sort
    ? `<span class="row" role="button" aria-haspopup="listbox" aria-label="Сортування: ім’я, за зростанням" style="gap:6px;height:${hgt}px;padding:0 10px;border-radius:8px;border:1px solid var(--input-border);font-size:13px;color:var(--muted-fg);white-space:nowrap">${icon('arrow-up-down', { size: 14 })}Сортування</span>`
    : ''
  // w = the width of the content column; the search narrows with it (180 / 240 / 300)
  const searchW = w < 680 ? 180 : w < 900 ? 240 : 300
  return `<div class="row" style="gap:8px"><span class="row dsearch" style="gap:8px;height:${hgt}px;width:${searchW}px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:${q ? 'var(--fg)' : 'var(--muted-fg)'};font-size:${touch ? 16 : 13}px">${icon('search', { size: 14 })}<span class="grow trunc">${q || (touch || searchW < 300 ? 'Ім’я, email…' : 'Ім’я, email, Telegram…')}</span>${q ? icon('x', { size: 14 }) : touch ? '' : kbd('/')}</span>${tabs}${roleChip}${sortBtn}<span class="grow"></span><span class="t-foot muted num" role="status" style="white-space:nowrap">${count}</span></div>`
}
const card = (inner) =>
  `<div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)">${inner}</div>`

function usersDesk(w, h, o = {}) {
  const rows = o.rows ?? USERS
  const archivedCol = o.seg === 1
  const { cols } = tableCols(w, { touch: o.touch, archivedCol, panelOpen: o.panelOpen })
  const sort = !cols.some(([c]) => c === 'Додано')
  const inner =
    o.content ??
    `${o.banner ?? ''}${toolbar(Math.min(w - SIDE, 1280) - 48 - (o.panelOpen ? panelShift(w) : 0), { ...o, sort })}${card(o.inner ?? userTable(w, rows, { archivedCol, ...o }))}`
  const content = o.panelOpen
    ? `<div class="col grow" style="min-height:0;gap:14px;margin-right:${panelShift(w)}px">${inner}</div>`
    : inner
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
    title = 'Створення',
    step = 0,
    steps = F.STEPS,
    body,
    foot,
    z = 70,
    lead = 'Скасувати',
  },
) {
  // P1: the visible title is the short one; the long catalog title is the accessible name only.
  const LONG = { Створення: 'Новий користувач', Редагувати: 'Редагувати користувача' }
  const head = touch
    ? `<div style="display:grid;grid-template-columns:minmax(max-content,1fr) max-content minmax(max-content,1fr);column-gap:8px;align-items:center;height:60px;flex:none;padding:0 8px;border-bottom:1px solid var(--border)"><button type="button" class="btn ghost" style="justify-self:start;height:44px;font-size:17px;font-weight:400;padding:0 8px">${lead}</button><div id="pn-t" class="t-head" style="text-align:center;white-space:nowrap">${title}</div><span></span></div>`
    : `<div class="row" style="height:56px;flex:none;padding:0 12px 0 24px;border-bottom:1px solid var(--border)"><div id="pn-t" class="grow t-head">${title}</div>${kbd('Esc')}<button type="button" class="iconbtn" aria-label="Закрити" style="width:32px;height:32px;margin-left:6px">${icon('x', { size: 18 })}</button></div>`
  const pad = touch ? 24 : 24
  return `${modal ? SCRIM(z - 10) : ''}${touch ? '' : PANEL_CSS}<aside role="dialog"${modal ? ' aria-modal="true"' : ''} aria-label="${LONG[title] || title}" class="${touch ? '' : 'dpanel'}" style="position:absolute;top:0;right:0;bottom:0;width:${width}px;z-index:${z};background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / ${modal ? 0.5 : 0.35});display:flex;flex-direction:column">
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
  `<div class="row" style="gap:8px">${back ? '<span class="btn sm secondary" style="height:36px;font-size:14px">Назад</span>' : ''}<span class="grow"></span>${secondary ? `<span class="btn sm secondary" style="height:36px;font-size:14px">${secondary}</span>` : cancel ? `<span class="btn sm ghost" style="height:36px;font-size:14px">${cancel}</span>` : ''}<span class="btn sm primary" style="height:36px;font-size:14px"${pending ? ' aria-disabled="true"' : ''}>${pending ? '<span aria-hidden="true" style="width:14px;height:14px;border-radius:7px;border:2px solid oklch(0 0 0 / 0.25);border-top-color:var(--primary-fg)"></span>' : ''}${primary}${pending || !hint ? '' : kbd('⌘↵', true)}</span></div>`

const deskPanel = (w, o) => panel(w >= 1440 ? 480 : 420, { modal: w < 1440, ...o })

// ---------- desktop dialogs ----------
// top: N2 — with the soft keyboard up (coarse pointer) the dialog pins to the top edge of the visual viewport.
const dialog = (width, inner, { role = 'alertdialog', z = 80, top = null } = {}) =>
  `${SCRIM(z - 2)}<div role="${role}" aria-modal="true" aria-labelledby="dg-t" aria-describedby="dg-d" style="position:absolute;left:50%;${top === null ? 'top:50%;transform:translate(-50%,-50%)' : `top:${top}px;transform:translateX(-50%)`};width:${width}px;max-height:calc(100% - ${top === null ? 48 : top + 12}px);overflow:hidden;z-index:${z};background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:16px;box-shadow:0 30px 80px oklch(0 0 0 / 0.7);padding:22px 24px 18px">${inner}</div>`
const focusRing = 'box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)'
const dirtyDialog = ({ touch = false } = {}) =>
  dialog(
    420,
    `<div id="dg-t" class="t-head">Вийти без збереження?</div><div id="dg-d" class="t-foot muted" style="margin-top:6px;font-size:${touch ? 16 : 14}px;line-height:${touch ? 22 : 20}px">Користувача не створено — введені дані буде втрачено.</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:${touch ? 44 : 36}px;font-size:${touch ? 16 : 14}px;${focusRing}">Залишитися</span><span class="btn sm" style="height:${touch ? 44 : 36}px;font-size:${touch ? 16 : 14}px;background:var(--destructive);color:#fff">Вийти</span></div>`,
  )
/**
 * Archive confirm dialog. impact: 'shown' | 'plain' (N5: nothing attached, no typed name) | 'summary' (keyboard up).
 * unknown (N6): no answer → «Перевірити». pending (N3): read-only, both buttons aria-disabled, «Скасувати» stays.
 */
const archiveDialog = ({
  armed = false,
  touch = false,
  impact = 'shown',
  pending = false,
  failed = false,
  unknown = false,
  top = null,
} = {}) => {
  const plain = impact === 'plain'
  const on = plain || armed || pending || failed
  const typed = armed || pending || failed || unknown ? 'Олег Ткач' : 'Олег Тк'
  const hgt = touch ? 44 : 36
  const fs = touch ? 16 : 14
  const spin = `<span aria-hidden="true" style="width:14px;height:14px;border-radius:7px;border:2px solid oklch(0 0 0 / 0.25);border-top-color:#fff"></span>`
  const primary = unknown
    ? `<span class="btn sm primary" style="height:${hgt}px;font-size:${fs}px">Перевірити</span>`
    : `<span class="btn sm" style="height:${hgt}px;font-size:${fs}px;background:var(--destructive);color:#fff;${on && !pending ? '' : 'opacity:0.45'}"${on && !pending ? '' : ' aria-disabled="true"'}>${pending ? spin : icon('archive', { size: 15 })}${pending ? 'Архівуємо…' : 'Архівувати'}</span>`
  return dialog(
    520,
    `<div id="dg-t" class="t-head">Архівувати користувача</div><div class="${touch ? '' : 'dpanel'}" style="margin-top:12px">${touch ? '' : PANEL_CSS}${F.archiveBody({ typed, impact, pending, failed, unknown }).replace('id="ar-d"', 'id="dg-d"')}</div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:${hgt}px;font-size:${fs}px">${unknown ? 'Закрити' : 'Скасувати'}</span>${primary}</div>`,
    { top },
  )
}
const emailDialog = () =>
  dialog(
    420,
    `<div id="dg-t" class="t-head">Змінити email?</div><div id="dg-d" class="t-foot" style="margin-top:8px;font-size:14px;line-height:22px"><span class="muted">Старий:</span> oleh.tkach@example.com<br><span class="muted">Новий:</span> oleh.tkach@example.org<div class="muted" style="margin-top:10px;line-height:20px">Зміна email може розірвати вхід через Google для <b style="font-weight:600;color:var(--fg)">Олег Ткач</b>. Переконайтеся, що користувач знає про зміну і за потреби змінить свій обліковий запис Google.</div></div>
  <div class="row" style="gap:8px;justify-content:flex-end;margin-top:20px"><span class="btn sm secondary" style="height:36px;font-size:14px;${focusRing}">Скасувати</span><span class="btn sm primary" style="height:36px;font-size:14px">Підтвердити зміну</span></div>`,
  )

/** N5: the undo toast, bottom-left of the content area (desktop) or of the list pane (tablet). */
const undoToast = ({ left, bottom, touch = false }) =>
  `<div class="toast" role="status" style="left:${left}px;right:auto;width:380px;bottom:${bottom}px"><span class="grow">${F.PLAIN_NAME}: архівовано</span><span role="button" style="height:${touch ? 44 : 36}px;padding:0 12px;display:flex;align-items:center;font-weight:600;color:var(--primary)">Відновити</span></div>`

/** A banner inside the desktop card column: no side margin, 36 px buttons. */
const deskBanner = (html) =>
  html
    .replaceAll('margin:0 12px 6px', 'margin:0 0 6px')
    .replace(
      /height:44px;font-size:15px;flex:1/g,
      'height:36px;font-size:14px;flex:none;padding:0 14px',
    )

/** Row «⋯» menu (anchored to the hovered row). Self: archive disabled with its reason. touch: 44 px rows. */
function rowMenu(top, right, { self = false, touch = false } = {}) {
  const hgt = touch ? 44 : 36
  const it = (ic, t, { danger = false, off = '' } = {}) =>
    `<div role="menuitem"${off ? ' aria-disabled="true"' : ''} class="row" style="gap:10px;height:${hgt}px;padding:0 12px;font-size:${touch ? 16 : 14}px;${danger ? 'color:var(--destructive)' : ''}"><span class="row grow" style="gap:10px;${off ? 'opacity:0.5' : ''}">${icon(ic, { size: 16 })}<span class="grow">${t}</span></span>${off ? `<span class="t-cap" style="color:var(--muted-fg)">${off}</span>` : ''}</div>`
  return `<div role="menu" aria-label="Дії з користувачем" style="position:absolute;top:${top}px;right:${right}px;width:${self ? 320 : touch ? 280 : 240}px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px 0">
  ${it('user-round', 'Відкрити профіль')}${it('pencil', 'Редагувати')}<div style="height:1px;background:var(--separator);margin:4px 0"></div>${self ? it('archive', 'Архівувати…', { danger: true, off: 'Не можна архівувати себе' }) : it('archive', 'Архівувати…', { danger: true })}</div>`
}

// ---------- tablet ----------
const tabList = (
  w,
  {
    selected = -1,
    rows = USERS,
    seg = 0,
    role = '',
    count = '38 користувачів',
    banner = '',
    body = '',
  } = {},
) =>
  `<section aria-label="Користувачі" class="col" style="${w >= 900 ? 'width:360px;flex:none;border-right:1px solid var(--border)' : 'flex:1;min-width:0'}">
  <div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Користувачі</div><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  <div style="flex:1;min-height:0;overflow:hidden">${banner}${searchField('Ім’я, email, Telegram…')}${filterRow(seg, role)}${
    body ||
    `${sortHead(count)}<div class="group" style="margin:0 12px">${rows
      .map((x, i) =>
        w >= 900 ? userRow(x, { selected: i === selected, compact: true }) : tabletRow(x),
      )
      .join('')}</div>`
  }</div></section>`

/**
 * 768 row (R2-13): first column ~1.6fr = avatar + [name · «Ви» · role badge] over [email alone];
 * second column Telegram + 2 tech chips + «+N»; added time; «⋯». Nothing but a very long email truncates.
 */
function tabletRow(x) {
  const acts = x.self || x.role !== 'ADMIN'
  const badge = `<span class="pill" style="height:20px;font-size:12px;padding:0 8px;flex:none">${R[x.role]}</span>`
  return `<div class="lrow two" style="padding:0;gap:0;--inset:68px"><a href="#" aria-label="${x.name}, ${R[x.role]}${x.self ? ', це ви' : ''}" style="flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr) 100px;gap:16px;align-items:center;padding:10px 4px 10px 16px;color:inherit;text-decoration:none;min-height:64px">
  <span class="row" style="gap:12px;min-width:0">${av(x, 40).replace('font-size:11px', 'font-size:13px')}<span class="col" style="gap:3px;min-width:0"><span class="row" style="gap:2px 6px;min-width:0;flex-wrap:wrap"><span class="t-body trunc" style="font-weight:500;min-width:0;max-width:100%">${x.name}</span>${x.self ? youPill : ''}${badge}</span><span class="t-foot muted trunc">${x.email}</span></span></span>
  <span class="col" style="gap:4px;min-width:0"><span class="t-foot muted trunc">${x.tg || ' '}</span>${x.tech.length ? techCell(x.tech, 2) : ''}</span>
  <span class="t-cap muted num" style="text-align:right;white-space:nowrap">${x.added}</span></a>${acts ? moreBtn(x) : '<span aria-hidden="true" style="width:48px;flex:none"></span>'}</div>`
}

/** ≥ 900 detail pane: built only from the list row (0 extra requests) + «Відкрити профіль». */
function detailPane(x, { archived = false } = {}) {
  // An empty contact is omitted, not shown as a bare label.
  const line = (ic, label, v, href = true) =>
    !v
      ? ''
      : `<div class="lrow" style="--inset:52px;min-height:52px"><span class="muted" style="width:24px;display:grid;place-items:center">${icon(ic, { size: 18 })}</span><div class="grow col" style="gap:1px;min-width:0"><div class="t-cap muted">${label}</div><div class="t-body trunc" style="${href ? 'color:var(--primary)' : ''}">${v}</div></div></div>`
  return `<section aria-label="Користувач" class="grow col" style="background:var(--bg);min-width:0">
  <div class="row" style="height:56px;padding:0 8px 0 20px;gap:4px;border-bottom:1px solid var(--border);flex:none"><div class="grow"></div><button type="button" class="btn ghost" style="height:44px;padding:0 10px;font-size:17px;font-weight:500;color:var(--primary)">${archived ? `${icon('archive-restore', { size: 18 })}Відновити з архіву` : 'Редагувати'}</button><button type="button" class="iconbtn" aria-label="Дії з користувачем" aria-haspopup="menu">${icon('ellipsis', { size: 22 })}</button></div>
  <div style="flex:1;min-height:0;overflow:hidden;padding:20px 16px 24px" class="col">
  <div class="row" style="gap:14px;padding:0 4px 18px">${av(x, 64).replace('font-size:11px', 'font-size:20px')}<div class="col" style="gap:4px;min-width:0"><div class="t-title trunc">${x.name}</div><div class="t-sub muted">${R[x.role]} · ${x.archived ? `архівовано ${x.archived}` : `додано ${x.added}`}</div></div></div>
  <div class="group" style="margin:0">${line('mail', 'Email', x.email)}${line('send', 'Telegram', x.tg)}${line('phone', 'Телефон', x.phone)}</div>
  <div class="t-over" style="padding:18px 4px 8px">Технології</div><div class="row" style="gap:6px;flex-wrap:wrap;padding:0 4px">${x.tech.map((t) => `<span class="pill" style="height:28px;font-size:14px">${t}</span>`).join('')}</div>
  <div style="padding:22px 4px 0"><span class="btn secondary" role="link" style="width:100%">${icon('user-round', { size: 18 })}Відкрити профіль</span></div>
  <div class="t-foot muted" style="padding:10px 4px 0">Фінанси, контракти й документи — у профілі.</div></div></section>`
}

/** P12: two-pane with no selection — the detail pane says what to do, the list pane keeps working. */
const detailEmpty = `<section aria-label="Користувач" class="grow col" style="background:var(--bg);min-width:0">${stateBlock({ ic: 'user-round', title: 'Оберіть користувача', text: 'Профіль і контакти з’являться тут.' })}</section>`
/** P12: loading in the list pane — rows in the final shape, announced once. */
const listSkeleton = `<div role="status" aria-label="Завантаження користувачів" class="group" style="margin:12px 12px 0">${Array.from(
  { length: 9 },
  () =>
    `<div class="lrow" style="min-height:64px;gap:12px"><span class="sk" style="width:40px;height:40px;border-radius:20px;flex:none"></span><span class="grow col" style="gap:8px"><span class="sk" style="height:12px;width:50%"></span><span class="sk" style="height:10px;width:72%"></span></span></div>`,
).join('')}</div>`
/** P10: the sort menu (same options as the phone sort sheet) for a layout where «Додано» is not a column. */
const sortMenu = (top, left) => {
  const opts = [
    ['За ім’ям', 'А → Я', true],
    ['За ім’ям', 'Я → А'],
    ['За роллю', 'А → Я'],
    ['За роллю', 'Я → А'],
    ['Спочатку нові', 'Додано'],
    ['Спочатку старі', 'Додано'],
  ]
  return `<div role="listbox" aria-label="Сортування" style="position:absolute;top:${top}px;left:${left}px;width:260px;z-index:40;background:var(--popover);border:1px solid var(--border);border-radius:12px;box-shadow:0 20px 50px oklch(0 0 0 / 0.6);padding:4px 0">${opts.map(([t, s, cur]) => `<div role="option" aria-selected="${Boolean(cur)}" class="row" style="gap:10px;height:40px;padding:0 12px;font-size:14px"><span class="grow row" style="gap:8px"><span style="${cur ? 'font-weight:600' : ''}">${t}</span><span class="muted">${s}</span></span>${cur ? `<span style="color:var(--primary)">${icon('check', { size: 16, stroke: 2.6 })}</span>` : ''}</div>`).join('')}</div>`
}

const touchFoot = (o) => F.actions(o)

export function wideFrames() {
  const CREATE = 'Створити користувача'
  const EDIT = 'Редагувати'
  const READY = 'Позначити готовим до підписання'
  const DRAFT = 'Зберегти чернетку'
  const T768 = (o = {}) =>
    tablet({
      w: 768,
      h: 1024,
      active: '/users',
      list: tabList(768, o.listOpts),
      overlay: o.overlay ?? '',
    })
  const touchPanel = (o) => panel(400, { touch: true, ...o })
  // M11: the ≥ 1440 panel is non-modal, so the table reflows (Додано dropped) beside it.
  const P = (o) => ({ panelOpen: true, ...o })
  const SENIORS = USERS.filter((x) => x.role === 'SENIOR')
  const WITHOUT_YULIIA = USERS.filter((x) => x.name !== F.PLAIN_NAME)
  const errorBlock = (h = 36, fs = 14) =>
    stateBlock({
      ic: 'cloud-alert',
      tone: 'var(--destructive)',
      role: 'alert',
      title: 'Не вдалося завантажити користувачів',
      text: 'Сервер не відповів. Нічого не змінено — спробуйте ще раз.',
      action: `<span class="btn sm secondary" style="height:${h}px;font-size:${fs}px">${icon('rotate-cw', { size: 15 })}Спробувати ще раз</span>`,
    })
  // N7 footer: the way out is the primary, the create button stays disabled and points at the alert.
  const dConflictFoot = `<div class="row" style="gap:8px"><span class="grow"></span><span class="btn sm secondary" aria-disabled="true" aria-describedby="cf-r" style="height:36px;font-size:14px;opacity:0.45">${CREATE}</span><span class="btn sm primary" style="height:36px;font-size:14px">Почати з іншим email</span></div>`
  const desk = (name, o) => D(name, 1440, 900, usersDesk(1440, 900, o))
  const deskPanelFrame = (name, panelOpts, o = {}) =>
    desk(name, P({ ...o, overlay: deskPanel(1440, panelOpts) + (o.over ?? '') }))
  const tab = (name, o) => T(name, 768, 1024, T768(o))
  return [
    // ---------- tablet ----------
    tab('list-768', {}),
    tab('error-768', { listOpts: { body: errorBlock(44, 16) } }),
    tab('long-768', { listOpts: { rows: [LONG, ...USERS] } }),
    tab('filtered-768', {
      listOpts: { role: 'Сеньйор', rows: SENIORS, count: `${SENIORS.length} з 38` },
    }),
    tab('row-actions-768', {
      overlay: `${SCRIM(30)}${rowMenu(404, 24, { touch: true })}`,
    }),
    T(
      'list-960',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, { selected: 0 }),
        detail: detailPane(USERS[0]),
      }),
    ),
    T(
      'list-960-archived',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, { selected: 0, rows: ARCHIVED, seg: 1, count: '3 в архіві' }),
        detail: detailPane(ARCHIVED[0], { archived: true }),
      }),
    ),
    // P12: two-pane (≥ 900) states are frames, not rules. The banner lives in the list pane; the detail pane has no selection.
    T(
      'list-960-none',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, {}),
        detail: detailEmpty,
      }),
    ),
    T(
      'list-960-loading',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, { body: listSkeleton }),
        detail: detailEmpty,
      }),
    ),
    T(
      'list-960-banner',
      960,
      720,
      tablet({
        w: 960,
        h: 720,
        active: '/users',
        list: tabList(960, {
          selected: 0,
          banner: unknownBanner(),
          rows: USERS.slice(0, 8),
          count: '8 користувачів',
        }),
        detail: detailPane(USERS[0]),
      }),
    ),
    tab('create-768', {
      overlay: touchPanel({ step: 1, body: F.stepIdentity(), foot: touchFoot({}) }),
    }),
    tab('create-2-768', {
      overlay: touchPanel({ step: 2, body: F.stepRole('SENIOR'), foot: touchFoot({ back: true }) }),
    }),
    tab('create-3-768', {
      overlay: touchPanel({
        step: 3,
        body: F.stepPay('SENIOR'),
        foot: touchFoot({ back: true, primary: CREATE }),
      }),
    }),
    tab('create-3-junior-768', {
      overlay: touchPanel({
        step: 3,
        body: F.stepPay('JUNIOR'),
        foot: touchFoot({ back: true, primary: CREATE }),
      }),
    }),
    tab('create-3-drop-768', {
      overlay: touchPanel({
        step: 3,
        body: F.stepPay('DROP'),
        foot: touchFoot({ back: true, primary: 'Створити дропа' }),
      }),
    }),
    tab('create-pending-768', {
      overlay: touchPanel({
        step: 3,
        body: F.ro(F.stepPay('SENIOR', { filled: true })),
        foot: touchFoot({ back: true, primary: 'Створюємо…', pending: true }),
      }),
    }),
    tab('create-error-768', {
      overlay: touchPanel({
        step: 3,
        body: F.stepPay('SENIOR', { alert: F.conflictAlert, filled: true }),
        foot: F.conflictBar(),
      }),
    }),
    tab('create-result-768', {
      overlay: touchPanel({
        lead: 'Закрити',
        body: F.stepResult(),
        foot: touchFoot({ primary: 'Готово', secondary: 'Додати контракт' }),
      }),
    }),
    tab('edit-768', {
      overlay: touchPanel({
        title: EDIT,
        body: F.editBody({ role: 'SENIOR' }),
        foot: touchFoot({ primary: 'Зберегти' }),
      }),
    }),
    tab('archive-confirm-768', { overlay: archiveDialog({ touch: true }) }),
    // N2: soft keyboard up → dialog pinned to the top, impact collapsed, field and buttons above the keyboard
    tab('archive-confirm-keyboard-768', {
      overlay: archiveDialog({ touch: true, impact: 'summary', top: 16 }) + textKeyboard(),
    }),
    tab('archive-undo-toast-768', {
      listOpts: { rows: WITHOUT_YULIIA, count: '37 користувачів' },
      overlay: undoToast({ left: 96, bottom: 28, touch: true }),
    }),
    tab('list-write-failed-banner-768', {
      listOpts: { banner: failedBanner(), rows: USERS.slice(0, 8), count: '8 користувачів' },
    }),
    // P12: the remaining closed-container outcomes and the dialogs that were rules at 768
    tab('list-unknown-banner-768', {
      listOpts: { banner: unknownBanner(), rows: USERS.slice(0, 8), count: '8 користувачів' },
    }),
    tab('list-archive-unknown-banner-768', {
      listOpts: {
        banner: archiveUnknownBanner(),
        rows: USERS.slice(0, 8),
        count: '8 користувачів',
      },
    }),
    tab('dirty-close-768', {
      overlay:
        touchPanel({
          step: 1,
          body: F.stepIdentity({ focus: '' }),
          foot: touchFoot({}),
        }) + dirtyDialog({ touch: true }),
    }),
    tab('archive-impact-failed-768', {
      overlay: archiveDialog({ touch: true, impact: 'failed' }),
    }),
    // ---------- desktop main ----------
    D('list-1024', 1024, 768, usersDesk(1024, 768, { hover: 2 })),
    D('list-1280', 1280, 800, usersDesk(1280, 800, { hover: 2 })),
    D('list-1440', 1440, 900, usersDesk(1440, 900, { hover: 2 })),
    D('touch-1024', 1024, 768, usersDesk(1024, 768, { touch: true })),
    // R2-18: the chip's «Скинути роль» is a 44 × 44 target on a coarse pointer
    D(
      'filtered-touch-1024',
      1024,
      768,
      usersDesk(1024, 768, {
        touch: true,
        role: 'Сеньйор',
        rows: SENIORS,
        count: `${SENIORS.length} з 38`,
      }),
    ),
    desk('list-unknown-banner-1440', { banner: deskBanner(unknownBanner()) }),
    desk('list-write-failed-banner-1440', { banner: deskBanner(failedBanner()) }),
    desk('list-archive-unknown-banner-1440', {
      banner: deskBanner(archiveUnknownBanner()),
    }),
    // P3 / P4: banners stack newest first (two shown, the rest fold); a failed check keeps the unknown banner and says so
    desk('list-banners-stack-1440', {
      banner: deskBanner(
        `${unknownBanner()}${archiveFailedBanner('Тарас Савчук', true)}${foldBanner(2)}`,
      ),
    }),
    desk('list-banner-check-failed-1440', {
      banner: deskBanner(archiveUnknownBanner('Олег Ткач', false, CHECK_FAILED_NOTE)),
    }),
    // P10: at 1024 «Додано» is not a column, so the sort lives in a menu beside the filters
    D('sort-menu-1024', 1024, 768, usersDesk(1024, 768, { overlay: sortMenu(150, 612) })),
    // ---------- desktop states ----------
    D(
      'loading-1440',
      1440,
      900,
      usersDesk(1440, 900, {
        inner: `<div role="status" aria-label="Завантаження користувачів">${userTable(1440, [], { skeleton: 10 })}</div>`,
        count: '',
      }),
    ),
    desk('filtered-1440', { role: 'Сеньйор', rows: SENIORS, count: `${SENIORS.length} з 38` }),
    desk('no-results-1440', {
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
    desk('archive-1440', { seg: 1, rows: ARCHIVED, count: '3 в архіві', hover: 0 }),
    desk('archive-empty-1440', {
      seg: 1,
      count: '0 в архіві',
      inner: stateBlock({
        ic: 'archive',
        title: 'В архіві нікого немає',
        text: 'Тут з’являться архівовані користувачі. Будь-кого з них можна відновити.',
        action: `<span class="btn sm secondary" style="height:36px;font-size:14px">Показати активних</span>`,
      }),
    }),
    D('error-1440', 1440, 900, usersDesk(1440, 900, { count: '', inner: errorBlock() })),
    D('long-1440', 1440, 900, usersDesk(1440, 900, { rows: [LONG, ...USERS] })),
    D('long-1024', 1024, 768, usersDesk(1024, 768, { rows: [LONG, ...USERS] })),
    desk('row-menu-1440', { hover: 2, overlay: rowMenu(275, 40) }),
    desk('row-menu-self-1440', { hover: 1, overlay: rowMenu(235, 40, { self: true }) }),
    // ---------- desktop create ----------
    deskPanelFrame('create-1-1440', { step: 1, body: F.stepIdentity(), foot: dFoot() }),
    D(
      'create-1-1024',
      1024,
      768,
      usersDesk(1024, 768, {
        overlay: deskPanel(1024, { step: 1, body: F.stepIdentity(), foot: dFoot() }),
      }),
    ),
    deskPanelFrame('create-2-1440', {
      step: 2,
      body: F.stepRole('SENIOR'),
      foot: dFoot({ back: true }),
    }),
    deskPanelFrame('create-3-1440', {
      step: 3,
      body: F.stepPay('SENIOR'),
      foot: dFoot({ back: true, primary: CREATE }),
    }),
    deskPanelFrame('create-3-junior-1440', {
      step: 3,
      body: F.stepPay('JUNIOR'),
      foot: dFoot({ back: true, primary: CREATE }),
    }),
    deskPanelFrame('create-3-drop-1440', {
      step: 3,
      body: F.stepPay('DROP'),
      foot: dFoot({ back: true, primary: 'Створити дропа' }),
    }),
    // N3: while the POST is in flight fields are read-only, «Створити» and «Назад» are aria-disabled, ✕ / Esc stay enabled
    deskPanelFrame('create-pending-1440', {
      step: 3,
      body: `${F.ro(F.stepPay('SENIOR', { filled: true }))}<span class="sr-only" role="status">Створюємо користувача…</span>`,
      foot: dFoot({ back: true, primary: 'Створюємо…', pending: true }).replace(
        '<span class="btn sm secondary" style="height:36px;font-size:14px">Назад',
        '<span class="btn sm secondary" aria-disabled="true" style="height:36px;font-size:14px;opacity:0.45">Назад',
      ),
    }),
    deskPanelFrame('create-error-1440', {
      step: 3,
      body: F.stepPay('SENIOR', { alert: F.conflictAlert, filled: true }),
      foot: dConflictFoot,
    }),
    deskPanelFrame('create-unknown-1440', {
      step: 3,
      body: F.ro(F.stepPay('SENIOR', { alert: F.unknownAlert, filled: true })),
      foot: dFoot({ back: true, primary: 'Спробувати ще раз' }),
    }),
    // N4: result screen after the POST, then the contract
    deskPanelFrame('create-result-1440', {
      lead: 'Закрити',
      body: F.stepResult(),
      foot: dFoot({ primary: 'Готово', secondary: 'Додати контракт', hint: false }),
    }),
    deskPanelFrame('create-result-none-1440', {
      body: F.stepResult({ none: true }),
      foot: dFoot({ primary: 'Готово', cancel: '', hint: false }),
    }),
    deskPanelFrame('create-4-1440', {
      body: F.stepContract(),
      foot: dFoot({ primary: READY, secondary: DRAFT, hint: false }),
    }),
    // P11: above 1440 the column keeps its 1280 cap, stays left-aligned and gives up only what the 480 panel would cover
    D(
      'create-1-1920',
      1920,
      1080,
      usersDesk(1920, 1080, {
        panelOpen: true,
        overlay: deskPanel(1920, { step: 1, body: F.stepIdentity(), foot: dFoot() }),
      }),
    ),
    deskPanelFrame(
      'dirty-close-1440',
      { step: 1, body: F.stepIdentity({ focus: '' }), foot: dFoot() },
      { over: dirtyDialog() },
    ),
    // R2-21: Технології comes from the list row, so the loading frame shows the real chips
    deskPanelFrame(
      'edit-1440',
      {
        title: EDIT,
        body: F.editBody({ loading: true }),
        foot: dFoot({ primary: 'Зберегти' }).replace(
          'class="btn sm primary" style="',
          'class="btn sm primary" aria-disabled="true" style="opacity:0.5;',
        ),
      },
      { selected: 6 },
    ),
    deskPanelFrame(
      'email-change-1440',
      { title: EDIT, body: F.editBody({ loading: false }), foot: dFoot({ primary: 'Зберегти' }) },
      { selected: 6, over: emailDialog() },
    ),
    // ---------- desktop archive ----------
    desk('archive-confirm-1440', { selected: 6, overlay: archiveDialog() }),
    // P6: the impact count failed — one retry in the block, no typed-name field until it loads
    desk('archive-impact-failed-1440', {
      selected: 6,
      overlay: archiveDialog({ impact: 'failed' }),
    }),
    desk('archive-armed-1440', { selected: 6, overlay: archiveDialog({ armed: true }) }),
    // P7 + R3-20: an HR user (list index 3) with nothing attached; the selected-row cue is on the row being archived
    desk('archive-plain-confirm-1440', {
      selected: 3,
      overlay: archiveDialog({ impact: 'plain' }),
    }),
    desk('archive-undo-toast-1440', {
      rows: WITHOUT_YULIIA,
      count: '37 користувачів',
      overlay: undoToast({ left: 272, bottom: 24 }),
    }),
    desk('archive-unknown-1440', {
      selected: 6,
      overlay: archiveDialog({ unknown: true }),
    }),
    // ---------- permission ----------
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
        content: permissionBlock(),
      }).replace(/<span class="btn primary"[\s\S]*?<\/span><\/span><\/header>/, '</header>'),
    ),
  ]
}
