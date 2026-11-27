// Notifications panel (shell-v2 §2 / §4) and the Board primitive (primitives-v2 §3). Invented sample data.
import { icon, safeBottom } from './base.mjs'
import { tabScreen, financeBody, interviewsBody, searchField } from './mobile.mjs'
import { sheet, closeBtn, stateBlock, skRow } from './mobile-overlays.mjs'
import { desktop } from './desktop.mjs'
import { tablet } from './tablet.mjs'
import { toastUndo } from './prims-viz.mjs'
import { actionConfirm } from './money-form.mjs'

const NOTIFS = [
  {
    ic: 'clock',
    t: 'Запит на виплату чекає рішення',
    s: 'Олена Коваль · <span style="white-space:nowrap">1 200,00 USD</span>',
    at: '10 хв',
    unread: true,
  },
  {
    ic: 'square-kanban',
    t: 'Співбесіду призначено',
    s: 'Ігор Мельник · завтра, 11:00',
    at: '1 год',
    unread: true,
  },
  { ic: 'file-text', t: 'Договір підписано', s: 'Проєкт «Альфа»', at: 'вчора' },
  {
    ic: 'receipt',
    t: 'Транзакцію змінено',
    s: 'Хмарний хостинг · <span style="white-space:nowrap">−45,00 USD</span>',
    at: '9.11',
  },
]

// A row links to its target (opening it marks it read); unread = a dot on the icon tile and a 600 title.
// `more`: the phone's visible 44 px «…» (the swipe's single-pointer alternative, primitives-v2 §3).
const notifRow = (n, more = false) =>
  `<div class="lrow two" style="--inset:64px;align-items:flex-start${more ? ';padding-right:4px' : ''}"><a href="#" class="row grow" style="gap:12px;align-items:flex-start;min-width:0;min-height:44px;color:inherit;text-decoration:none"><div class="lead" style="margin-top:2px;position:relative">${icon(n.ic, { size: 18 })}${n.unread ? '<i aria-label="Непрочитане" style="position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:5px;background:var(--primary);box-shadow:0 0 0 2px var(--card)"></i>' : ''}</div><div class="grow col" style="gap:2px;min-width:0"><div class="t-body" style="font-weight:${n.unread ? 600 : 400};overflow-wrap:anywhere">${n.t}</div><div class="t-foot muted num" style="overflow-wrap:anywhere">${n.at} · ${n.s}</div></div></a>${more === 'del' ? `<span class="iconbtn" role="button" aria-label="Видалити сповіщення" style="color:var(--muted-fg)">${icon('trash-2', { size: 20 })}</span>` : more ? `<span class="iconbtn" role="button" aria-label="Дії зі сповіщенням" aria-haspopup="menu" style="color:var(--muted-fg)">${icon('ellipsis', { size: 20 })}</span>` : ''}</div>`

// «Прочитати все» (the shipped label): a text button with a 44 px hit area that adds no height (padding cancelled by margin).
const markAll = (pad = 14) =>
  `<a href="#" role="button" style="padding:${pad}px 8px;margin:-${pad}px -8px;font-size:13px;font-weight:600;color:var(--primary);text-decoration:none;white-space:nowrap">Прочитати все</a>`

// The count line «Непрочитаних: N» (server `unreadCount`): body text, not a section overline.
const sec = (label, trail = '', pad = '14px 16px 8px') =>
  `<div class="row" style="justify-content:space-between;gap:12px;padding:${pad}"><span class="num" style="font-size:13px;color:var(--muted-foreground)">${label}</span>${trail}</div>`

// The server's `unreadCount` from GET /api/notifications, never the loaded rows: 14 unread, 2 of them on the first page.
const UNREAD = 14
const BELL = `Сповіщення, ${UNREAD} нових`

// One newest-first list; the List footer auto-loads the next 10 at its end (here: the next page loading).
function notifList(more = false, deleted = 0) {
  const rows = NOTIFS.slice(deleted)
  const unread = UNREAD - NOTIFS.slice(0, deleted).filter((n) => n.unread).length
  return `${sec(`Непрочитаних: ${unread}`, markAll(), '4px 16px 8px')}<div class="group">${rows.map((n) => notifRow(n, more)).join('')}<div role="status" aria-label="Завантаження ще сповіщень" style="display:contents"><div aria-hidden="true" style="display:contents">${skRow()}</div></div></div>`
}

// Pinned under the scrolling list, so paging never pushes it out of reach.
const allLink = (pb = 0) =>
  `<div style="flex:none;border-top:1px solid var(--border);padding-bottom:${pb}px"><a href="#" class="row" style="justify-content:center;gap:6px;min-height:44px;font-size:15px;color:var(--primary);text-decoration:none">Усе, що чекає рішення${icon('chevron-right', { size: 16 })}</a></div>`

const EMPTY = () =>
  stateBlock({
    ic: 'bell',
    title: 'Сповіщень немає',
    text: 'Тут з’являться події за вашими проєктами, грошима та документами',
  }).replace('padding:56px 32px 0', 'padding:40px 32px 0')

/** Phone: a medium sheet over the page the bell was tapped on; the bell's page stays behind the scrim. */
// F0-34: first load = skeleton rows under the real header; a failed load = an inline alert with retry (the sheet stays).
// R1-06: the skeleton is the real list shape — the real count line and «Прочитати все» stay, rows are lead tile + two text lines (no amount column, as in notifRow).
const skNotif = () =>
  `<div class="lrow two" style="--inset:64px;align-items:flex-start"><div class="sk" style="width:36px;height:36px;border-radius:10px;margin-top:2px"></div><div class="grow col" style="gap:8px;min-width:0"><div class="sk" style="height:14px;width:68%"></div><div class="sk" style="height:11px;width:46%"></div></div></div>`
const LOADING = () =>
  `${sec(`Непрочитаних: ${UNREAD}`, markAll(), '4px 16px 8px')}<div role="status" aria-label="Завантаження сповіщень" style="display:contents"><div class="group" aria-hidden="true">${skNotif().repeat(4)}</div></div>`
const FAILED = () =>
  stateBlock({
    ic: 'cloud-alert',
    tone: 'var(--destructive)',
    role: 'alert',
    title: 'Не вдалося завантажити сповіщення',
    action: `<span class="btn secondary" role="button">${icon('rotate-cw', { size: 18 })}Повторити</span>`,
  }).replace('padding:56px 32px 0', 'padding:32px 32px 0')

// D-3: the same undo toast as every other delayed action (primitives-v2 §5), above the sheet; 5 s, paused by focus, hover and a touch.
const deleteToast = (w) =>
  `<div class="toast" role="status" style="left:12px;right:12px;bottom:${safeBottom(w) + 12}px;z-index:90;min-height:56px;overflow:hidden"><span style="color:var(--positive)">${icon('trash-2', { size: 18 })}</span><span class="grow">Сповіщення видалено</span><span class="btn ghost" role="button" style="color:var(--primary);height:44px;padding:0 10px;font-size:15px">Скасувати</span><i style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--primary);opacity:0.7"></i></div>`

export function notificationsSheet(w, h, { empty = false, state = '', undo = false } = {}) {
  const body = empty
    ? EMPTY()
    : state === 'loading'
      ? LOADING()
      : state === 'error'
        ? FAILED()
        : notifList(true, undo ? 1 : 0)
  const top = Math.round(h * (empty || state === 'error' ? 0.5 : 0.28))
  const footer = empty || state ? '' : allLink(safeBottom(w))
  const overlay = sheet({ w, h, top, title: 'Сповіщення', trail: closeBtn, body, footer }).replace(
    '<div style="flex:1;min-height:0;overflow:hidden;overscroll-behavior:contain">',
    `<div style="flex:1;min-height:0;overflow:hidden;overscroll-behavior:contain${empty ? `;padding-bottom:${safeBottom(w)}px` : ''}">`,
  )
  const screen = tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/finance',
    title: 'Фінанси',
    body: financeBody(),
    overlay,
    showFab: false,
  })
  // Nothing unread: the bell has no dot.
  if (undo) {
    // D-3 fixture assert: one unread row left the list, so the bell label and the count line both read UNREAD - 1.
    const out = screen
      .replace(/<\/div>\s*$/, `${deleteToast(w)}</div>`)
      .replace('Сповіщення, 2 нові', `Сповіщення, ${UNREAD - 1} нових`)
    if (
      !out.includes(`Сповіщення, ${UNREAD - 1} нових`) ||
      !out.includes(`Непрочитаних: ${UNREAD - 1}`)
    )
      throw new Error('notifications-undo: unread count mismatch')
    return out
  }
  return empty
    ? screen.replace(/<i class="dot"[^>]*><\/i>/, '')
    : screen.replace('Сповіщення, 2 нові', BELL)
}

/** Tablet and desktop: a non-modal popover anchored under the bell (no scrim; Esc and an outside click close it). */
export function notificationsDesktop(w, h) {
  return desktop({ w, h, overlay: notifPop('top:50px;right:206px', 12) }).replace(
    'Сповіщення, 2 нові',
    BELL,
  )
}

/** Tablet: the same popover under the list pane's bell, 44 px targets (coarse pointer). */
export function notificationsTablet(w, h) {
  return tablet({ w, h, overlay: notifPop('top:60px;right:12px', 14, 'del') }).replace(
    'Сповіщення, 2 нові',
    BELL,
  )
}

// D-3 on the tablet: the same undo toast in the one floating corner (bottom-right, 24 px from both edges, 420 wide).
export function notificationsTabletUndo(w, h) {
  const toast = `<div class="toast" role="status" style="left:auto;right:24px;bottom:24px;width:420px;z-index:90;min-height:56px;overflow:hidden"><span style="color:var(--positive)">${icon('trash-2', { size: 18 })}</span><span class="grow">Сповіщення видалено</span><span class="btn ghost" role="button" style="color:var(--primary);height:44px;padding:0 10px;font-size:15px">Скасувати</span><i style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--primary);opacity:0.7"></i></div>`
  const out = tablet({
    w,
    h,
    overlay: notifPop('top:60px;right:12px', 14, 'del', 1) + toast,
  }).replace('Сповіщення, 2 нові', `Сповіщення, ${UNREAD - 1} нових`)
  if (
    !out.includes(`Сповіщення, ${UNREAD - 1} нових`) ||
    !out.includes(`Непрочитаних: ${UNREAD - 1}`)
  )
    throw new Error('notifications-undo-768: unread count mismatch')
  return out
}

function notifPop(place, pad, rowAction = false, deleted = 0) {
  const unread = UNREAD - (deleted ? 1 : 0)
  return `<div role="dialog" aria-label="Сповіщення" style="position:absolute;${place};width:400px;z-index:70;background:var(--popover);border:1px solid oklch(0.28 0.006 85);border-radius:14px;box-shadow:0 24px 64px oklch(0 0 0 / 0.6);overflow:hidden;display:flex;flex-direction:column;max-height:640px">
  <div class="row" style="justify-content:space-between;gap:12px;height:48px;padding:0 16px;border-bottom:1px solid var(--border)"><span style="font-size:15px;font-weight:600">Сповіщення</span>${markAll(pad)}</div>
  <div style="padding-top:4px;flex:1;min-height:0;overflow:hidden">${notifList(rowAction, deleted)
    .replace(
      /<div class="group">/g,
      '<div class="group" style="margin:0;border:0;border-radius:0;background:transparent">',
    )
    .replace(
      sec(`Непрочитаних: ${unread}`, markAll(), '4px 16px 8px'),
      sec(`Непрочитаних: ${unread}`, '', '8px 16px 4px'),
    )}</div>${allLink()}</div>`
}

// ---------- Board (desktop drag board; the phone has no drag) ----------
const STAGES = [
  ['HR-скринінг', 4],
  ['Англійська', 2],
  ['Технічна', 2],
  ['Фінальна', 1],
  ['З клієнтом', 2],
  ['Офер', 1],
]
const CARDS = {
  'HR-скринінг': [
    ['ТС', 'Тарас Савчук', 'Frontend · «Альфа»', '12.11 · 10:00'],
    ['ДЛ', 'Дмитро Лисенко', 'QA · «Бета»', '12.11 · 15:30'],
    ['НГ', 'Наталія Гнатюк', 'Backend · «Гамма»', '13.11 · 09:00'],
    ['РК', 'Роман Кушнір', 'DevOps · «Дельта»', '14.11 · 12:00'],
  ],
  Англійська: [
    ['ОК', 'Олена Коваль', 'Frontend · «Альфа»', '12.11 · 11:00'],
    ['ВП', 'Віктор Попович', 'Data · «Бета»', '13.11 · 14:00'],
  ],
  Технічна: [
    ['ІМ', 'Ігор Мельник', 'Backend · «Гамма»', '12.11 · 16:00'],
    ['АБ', 'Анна Бондар', 'Frontend · «Альфа»', '13.11 · 10:30'],
  ],
  Фінальна: [['ЮС', 'Юлія Стасюк', 'PM · «Дельта»', '15.11 · 11:00']],
  'З клієнтом': [
    ['ЛМ', 'Лев Марченко', 'Mobile · «Бета»', '12.11 · 17:00'],
    ['СТ', 'Софія Ткач', 'Design · «Гамма»', '14.11 · 13:00'],
  ],
  Офер: [['МП', 'Марія Петренко', 'QA · «Альфа»', 'до 18.11']],
}

// Fine pointer: hover or focus reveals a 32 px button. Coarse pointer: always visible, 44 px hit area (foundation §13).
const stageBtn = (show, touch = false) =>
  touch
    ? `<span class="iconbtn" role="button" aria-label="Змінити етап" style="position:absolute;top:0;right:0;width:44px;height:44px;color:var(--muted-fg)"><span style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:var(--raised)">${icon('arrow-right-left', { size: 15 })}</span></span>`
    : `<span class="iconbtn" role="button" aria-label="Змінити етап" title="Змінити етап (M)" style="position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:8px;color:var(--muted-fg);background:var(--raised);${show ? '' : 'display:none'}">${icon('arrow-right-left', { size: 15 })}</span>`

function card([ini, name, sub, at], { state = '', touch = false } = {}) {
  const btn = touch || state === 'hover' || state === 'focus'
  const base =
    'position:relative;display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:10px;background:var(--card);border:1px solid var(--border)'
  const look = {
    '': '',
    hover: ';border-color:var(--input-border)',
    focus: ';box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--primary)',
    source: ';opacity:0.35;border-style:dashed',
    lifted:
      ';background:var(--raised);box-shadow:0 18px 40px oklch(0 0 0 / 0.55);border-color:var(--input-border)',
  }[state]
  return `<div role="listitem" tabindex="0" aria-roledescription="картка" style="${base}${look}"><span class="row" style="width:28px;height:28px;border-radius:14px;justify-content:center;flex:none;background:var(--yellow-subtle);color:var(--primary);font-size:11px;font-weight:600">${ini}</span><div class="grow col" style="gap:2px;min-width:0${btn ? `;padding-right:${touch ? 34 : 30}px` : ''}"><div style="font-size:14px;font-weight:600;overflow-wrap:anywhere">${name}</div><div class="t-foot muted" style="font-size:12px;overflow-wrap:anywhere">${sub.replaceAll(' · ', '\u00A0·\u00A0')}</div><div class="t-foot muted num" style="font-size:12px;white-space:nowrap">${at}</div></div>${stageBtn(btn, touch)}</div>`
}

function column([title, n], { target = false, states = {}, extra = '', touch = false } = {}) {
  const cards = (CARDS[title] || [])
    .map((c, i) => card(c, { state: states[i] || '', touch }))
    .join('')
  const ring = target
    ? 'background:var(--yellow-subtle);outline:2px dashed var(--primary);outline-offset:-2px'
    : 'background:var(--surface)'
  // Touch tablet (F0-38): fixed 200 px, so three columns fit whole at 768 and the fourth peeks under the fade, never a cut count badge.
  const size = touch ? 'flex:0 0 200px;width:200px' : 'flex:1 1 0;min-width:180px;max-width:280px'
  return `<section aria-label="${title}, ${n}" style="${size};display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:12px;${ring}"><div class="row" style="justify-content:space-between;gap:6px;height:28px;padding:0 4px;min-width:0"><span class="trunc" style="font-size:13px;font-weight:600">${title}</span><span class="pill num" style="height:20px;flex:none">${n}</span></div><div role="list" class="col" style="gap:8px">${cards}${extra}</div></section>`
}

/** board-1440: a drag in progress (source, lifted card, drop target) and a focused card with its «Етап» button. */
export function board1440() {
  const lifted = `<div style="position:absolute;left:398px;top:262px;width:166px;z-index:5">${card(['ОК', 'Олена Коваль', 'Frontend · «Альфа»', '12.11 · 11:00'], { state: 'lifted' })}</div>`
  const cols = STAGES.map((s) => {
    if (s[0] === 'Англійська') return column(s, { states: { 0: 'source' } })
    if (s[0] === 'Технічна')
      return column(s, {
        target: true,
        extra:
          '<div aria-hidden="true" style="height:84px;border-radius:10px;border:1px dashed var(--primary);background:oklch(0 0 0 / 0.2)"></div>',
      })
    if (s[0] === 'HR-скринінг') return column(s, { states: { 1: 'focus' } })
    return column(s)
  }).join('')
  const live = `<div role="status" class="sr">Олена Коваль: над «Технічна». Відпустіть, щоб перемістити, або Esc, щоб скасувати.</div>`
  const content = `<div class="row" style="gap:8px"><span class="row dsearch" style="gap:8px;height:32px;width:300px;padding:0 10px;border-radius:8px;background:var(--surface);border:1px solid var(--input-border);color:var(--muted-fg);font-size:13px">${icon('search', { size: 14 })}<span class="grow">Пошук співбесід</span><span class="kbdkey">/</span></span><span class="grow"></span><span class="t-foot muted num">12 активних</span></div>
  <div style="position:relative;min-height:0;flex:1;overflow:hidden"><div class="row" style="gap:12px;align-items:flex-start">${cols}</div>${lifted}${live}</div>`
  return desktop({
    w: 1440,
    h: 900,
    content,
    active: '/interviews',
    crumb: ['Робота', 'Співбесіди'],
    cta: 'Нова співбесіда',
  })
}

/** board-stage-sheet-375: the phone path (no drag) and the single-pointer path: «Етап» PickerSheet. */
export function boardStageSheet(w, h) {
  const opt = (label, { cur = false, sub = '' } = {}) =>
    `<div class="lrow" role="option" aria-selected="${cur}" style="min-height:52px"><div class="grow col" style="gap:1px;min-width:0"><div class="t-body" style="${cur ? 'font-weight:600' : ''}">${label}</div>${sub ? `<div class="t-foot muted">${sub}</div>` : ''}</div>${cur ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.6 })}</span>` : ''}</div>`
  const body = `<div class="t-foot muted" style="padding:0 16px 10px;text-align:center">Олена Коваль · Frontend · «Альфа»</div><div role="listbox" aria-label="Етап">
  <div class="group">${opt('HR-скринінг')}${opt('Англійська', { cur: true, sub: 'Поточний етап' })}${opt('Технічна')}${opt('Фінальна')}${opt('З клієнтом')}${opt('Офер')}</div>
  <div class="sechead" style="padding-top:14px"><span class="t-over">Завершити</span></div><div class="group">${opt('Найнято')}${opt('Відмова')}</div></div>`
  const overlay = sheet({ w, h, top: Math.round(h * 0.2), title: 'Етап', trail: closeBtn, body })
  return tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body: interviewsBody(),
    overlay,
    showFab: false,
  })
}

/** board-768: touch tablet. «Змінити етап» on every card (44 px); columns are 200 px and scroll sideways with an edge fade. */
export function board768() {
  const cols = STAGES.map((st) => column(st, { touch: true })).join('')
  const fade =
    '<div aria-hidden="true" style="position:absolute;top:0;right:0;bottom:0;width:64px;background:linear-gradient(to right, transparent, var(--bg));pointer-events:none"></div>'
  const pane = `<section aria-label="Співбесіди" class="col" style="flex:1;min-width:0">
  <div class="row" style="height:56px;padding:0 8px 0 16px;flex:none"><div class="grow t-title">Співбесіди</div><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  ${searchField('Пошук співбесід').replace('padding:4px 16px 10px', 'padding:0 16px 10px;max-width:432px;flex:none')}
  <div class="row" style="gap:8px;padding:0 16px 12px;flex:none"><span class="t-foot muted num">12 активних · утримуйте картку, щоб перетягнути</span></div>
  <div style="position:relative;flex:1;min-height:0;overflow:hidden"><div class="row" style="gap:12px;align-items:flex-start;padding:0 16px;width:max-content">${cols}</div>${fade}</div></section>`
  return tablet({ w: 768, h: 1024, list: pane, active: '/interviews' })
}

/** board-undo-375: after a move (here the terminal «Відмова»), the row shows its new stage and the 5 s undo toast. */
export function boardUndo(w, h) {
  const body = interviewsBody()
    .replace('Англійська<span class="nw-only"> · 12.11 · 11:00</span>', 'Відмова')
    .replace(
      '<span class="pill wide-only y">12.11 · 11:00</span>',
      '<span class="pill wide-only ">Відмова</span>',
    )
  return toastUndo(w, h, { text: 'Олена Коваль → Відмова', ic: 'arrow-right-left', body })
}

/** board-hire-confirm-375: «Найнято» creates a project, so it is confirmed first and never undone. */
export function boardHireConfirm(w, h) {
  const overlay = actionConfirm(w, {
    id: 'hc',
    // Case-free (F0-27): the name stands before the colon, so it is never declined.
    title: 'Олена Коваль: перевести в «Найнято»?',
    desc: 'Буде створено проєкт.',
    action: 'Перевести',
    ink: 'var(--primary)',
  })
  return tabScreen({
    w,
    h,
    role: 'HR',
    active: '/interviews',
    title: 'Співбесіди',
    body: interviewsBody(),
    overlay,
    showFab: false,
  })
}
