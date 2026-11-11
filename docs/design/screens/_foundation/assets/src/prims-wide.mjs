// Primitives v2 at 768 (tablet, touch) and 1440 (desktop, pointer): ListRow, FormField, undo toast,
// upload pill, skeleton. Sample data is invented.
import { icon, phone } from './base.mjs'
import { txnRow, TXNS, PEOPLE, searchField, chips, peopleList, topBar } from './mobile.mjs'
import { skRow } from './mobile-overlays.mjs'
import { field, toggle } from './prims-mobile.mjs'
import { tableRows } from './prims-viz.mjs'
import { tablet } from './tablet.mjs'
import { desktop } from './desktop.mjs'

const board = (w, title, sub, body) =>
  `<div style="width:${w}px;padding:28px 32px 32px;background:var(--bg)"><div class="t-head">${title}</div><div class="t-foot muted" style="margin-top:2px">${sub}</div><div style="margin-top:20px">${body}</div></div>`
const cap = (t) => `<div class="t-over" style="margin:18px 0 8px">${t}</div>`
const navRow = (ic, label, extra = '') =>
  `<div class="lrow" style="--inset:60px"><div class="lead" style="width:32px;height:32px;border-radius:9px">${icon(ic, { size: 18 })}</div><div class="grow t-body trunc">${label}</div>${extra || icon('chevron-right', { size: 18, cls: 'chev' })}</div>`

// ---------- ListRow ----------
export function listrowTablet() {
  // 640–899 is one pane: a row pushes its detail, so there is no selected (aria-current) row here.
  const pressed = txnRow(TXNS[1]).replace(
    'class="lrow two"',
    'class="lrow two" style="--inset:64px;background:var(--accent)"',
  )
  const left = `<div style="width:320px">${cap('Одна панель · 640–899')}<div class="group" style="margin:0">${txnRow(TXNS[0])}${pressed}${txnRow(TXNS[2])}</div>
  <div class="t-cap muted" style="margin-top:8px">натиснутий · очікує; без обраного рядка</div></div>`
  const right = `<div class="grow">${cap('Повна ширина · налаштування')}<div class="group" style="margin:0">${navRow('languages', 'Мова', '<span class="muted t-sub">Українська</span>')}${navRow('bell', 'Сповіщення', toggle(true, 'Сповіщення'))}${navRow('shield', 'Безпека')}</div>
  <div class="t-cap muted" style="margin-top:8px">висоти як на мобільному: 56 / 64, ціль ≥ 44</div></div>`
  return board(
    768,
    'ListRow · 768',
    'Планшет — дотик: метрики мобільного рядка. 640–899: одна панель, рядок відкриває деталь окремим екраном. Обраний рядок — лише від 900 px.',
    `<div class="row" style="gap:24px;align-items:flex-start">${left}${right}</div>`,
  )
}

export function listrowDesktop() {
  const side = (label, ic, st) => {
    const s = {
      default: 'color:var(--muted-fg)',
      hover: 'color:var(--fg);background:oklch(0.15 0.004 85)',
      active:
        'background:var(--raised);color:var(--fg);box-shadow:inset 2px 0 0 var(--primary);font-weight:600',
      focus: 'color:var(--fg);outline:2px solid var(--primary);outline-offset:-2px',
    }[st]
    return `<div class="row" style="gap:10px;height:36px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:500;${s}"><span>${icon(ic, { size: 17 })}</span><span class="grow">${label}</span><span class="t-cap" style="color:oklch(0.64 0 0)">${st}</span></div>`
  }
  const nav = `<div style="width:248px;padding:10px;border:1px solid var(--border);border-radius:14px;background:oklch(0.095 0.002 85)">${side('Дашборд', 'layout-dashboard', 'default')}${side('Фінанси', 'dollar-sign', 'active')}${side('Статистика', 'chart-column', 'hover')}${side('Користувачі', 'users', 'focus')}</div>`
  const table = tableRows().replace('padding:24px;background:var(--bg);width:960px', 'width:1040px')
  return board(
    1440,
    'ListRow · 1440',
    'Десктоп — вказівник: рядок таблиці 40 px, пункт бічної панелі 36 px; є hover; фокус клавіатури — кільце 2 px.',
    `<div class="row" style="gap:32px;align-items:flex-start"><div>${cap('Бічна панель')}${nav}</div><div>${cap('Рядок таблиці')}${table}</div></div>`,
  )
}

// ---------- FormField ----------
const fieldSet = () => [
  field({ id: 'a', label: 'Ім’я та прізвище', ph: 'Наприклад, Ірина Мельник' }),
  field({
    id: 'b',
    label: 'Email',
    value: 'iryna.m',
    state: 'focus',
    hint: 'На цю адресу прийде запрошення',
  }),
  field({ id: 'c', label: 'Телефон', value: '+380 67 000 00 00' }),
  field({
    id: 'd',
    label: 'Робочий email',
    value: 'iryna@',
    state: 'error',
    err: 'Вкажіть email у форматі name@domain.com',
  }),
  field({
    id: 'e',
    label: 'Роль',
    value: 'Junior',
    state: 'disabled',
    hint: 'Роль змінює адміністратор',
  }),
]

export function formfieldTablet() {
  return board(
    768,
    'FormField · 768',
    'Планшет — дотик: поле 48 px, текст 16 px (iOS не масштабує сторінку), дві колонки від 640.',
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px 20px">${fieldSet().join('')}</div>`,
  )
}

export function formfieldDesktop() {
  const css = `<style>.dsk .input{height:36px;font-size:14px;border-radius:8px;padding:0 10px}.dsk label{font-size:13px;line-height:18px}.dsk .hint{font-size:12px;line-height:16px}.dsk .field{gap:6px}</style>`
  return board(
    1440,
    'FormField · 1440',
    'Десктоп — вказівник: поле 36 px, текст 14 px, підпис 13 px; ціль ≥ 24 px (SC 2.5.8); стани ті самі, що на мобільному.',
    `${css}<div class="dsk" style="display:grid;grid-template-columns:repeat(3,360px);gap:18px 24px">${fieldSet().join('')}</div>`,
  )
}

// ---------- Undo toast ----------
const undoToast = (extra = '', btnH = 40) =>
  `<div role="status" class="row" style="position:absolute;z-index:80;gap:12px;height:52px;padding:0 6px 0 16px;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.28 0.006 85);box-shadow:0 14px 40px oklch(0 0 0 / 0.55);font-size:15px;overflow:hidden;${extra}"><span style="color:var(--positive)">${icon('archive', { size: 18 })}</span><span class="grow">Співбесіду архівовано</span><span class="btn sm ghost" style="color:var(--primary);height:${btnH}px;font-size:15px">Скасувати</span><i style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--primary);opacity:0.7"></i></div>`

const interviewList = `<section aria-label="Співбесіди" class="col" style="width:320px;flex:none;border-right:1px solid var(--border)">
  <div class="row" style="height:56px;padding:0 8px 0 16px"><div class="grow t-title">Співбесіди</div></div>
  ${searchField('Пошук кандидатів')}${chips(['Усі', 'Скринінг', 'Технічна'])}${peopleList().replace('class="group"', 'class="group" style="margin:0 12px"')}</section>`
const pickOne = `<section class="grow" style="display:grid;place-items:center;color:var(--muted-fg);font-size:15px">Оберіть кандидата</section>`

export const toastUndoTablet = (w, h) =>
  tablet({
    w,
    h,
    active: 'more',
    list: interviewList,
    detail: pickOne,
    overlay: undoToast('left:50%;bottom:24px;width:420px;transform:translateX(-50%)', 44),
  })

const interviewTable = () => {
  const tr = PEOPLE.map(
    ([i, n, s, p]) =>
      `<tr><td><span class="row" style="gap:10px"><span style="width:28px;height:28px;border-radius:14px;background:var(--surface);display:grid;place-items:center;font-size:11px;font-weight:600">${i}</span>${n}</span></td><td class="muted">${s}</td><td class="muted">${p}</td><td class="num muted">12.11 · 10:00</td></tr>`,
  ).join('')
  return `<div class="grow" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"><table style="width:100%;border-collapse:separate;border-spacing:0;font-size:14px"><thead><tr><th style="text-align:left">Кандидат</th><th style="text-align:left">Етап</th><th style="text-align:left">Крок</th><th style="text-align:left">Наступна</th></tr></thead><tbody>${tr}</tbody></table></div>`
}

export const toastUndoDesktop = (w, h) =>
  desktop({
    w,
    h,
    active: '/interviews',
    crumb: ['Робота', 'Співбесіди'],
    cta: 'Нова співбесіда',
    content: interviewTable(),
    overlay: undoToast('left:272px;bottom:24px;width:420px'),
  })

// ---------- Upload pill ----------
const ring = (pct, size) => {
  const c = 2 * Math.PI * 15
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="oklch(1 0 0 / 0.14)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`
}
const pill = (pos, h = 44) =>
  `<div class="row" style="position:absolute;z-index:80;gap:10px;height:${h}px;padding:0 6px 0 10px;border-radius:${h / 2}px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.5);font-size:14px;${pos}"><span role="progressbar" aria-label="Завантаження 2 чеків" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40" style="display:grid">${ring(40, 26)}</span><span class="grow num" aria-hidden="true">Завантаження 2 чеків · 40%</span><span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Почалося завантаження 2 чеків</span><span class="iconbtn" style="width:${h - 8}px;height:${h - 8}px" aria-label="Показати завантаження">${icon('chevron-up', { size: 18 })}</span></div>`

export const uploadPillTablet = (w, h) =>
  tablet({ w, h, overlay: pill('left:50%;bottom:24px;width:320px;transform:translateX(-50%)', 52) })

export const uploadPillDesktop = (w, h) =>
  desktop({ w, h, overlay: pill('right:24px;bottom:24px;width:300px', 40) })

// ---------- Skeleton ----------
export function skeletonTablet(w, h) {
  const list = `<section role="status" aria-label="Завантаження транзакцій" class="col" style="width:320px;flex:none;border-right:1px solid var(--border)">
  <div class="row" style="height:56px;padding:0 16px"><div class="t-title">Фінанси</div></div>
  <div style="padding:4px 16px 10px"><div class="sk" style="height:44px;border-radius:12px"></div></div>
  <div class="sechead"><div class="sk" style="height:11px;width:70px"></div></div><div class="group" style="margin:0 12px" aria-hidden="true">${skRow().repeat(4)}</div>
  <div class="sechead"><div class="sk" style="height:11px;width:70px"></div></div><div class="group" style="margin:0 12px" aria-hidden="true">${skRow().repeat(3)}</div></section>`
  const detail = `<section class="grow col" aria-hidden="true" style="padding:24px;gap:12px"><div class="sk" style="height:22px;width:46%"></div><div class="sk" style="height:12px;width:30%"></div><div class="sk" style="height:40px;width:52%;margin-top:6px"></div>
  <div class="row" style="gap:8px"><div class="sk" style="height:24px;width:90px;border-radius:12px"></div><div class="sk" style="height:24px;width:120px;border-radius:12px"></div></div>
  <div class="sk" style="height:220px;border-radius:14px;margin-top:12px"></div></section>`
  return tablet({ w, h, list, detail })
}

export function skeletonDesktop(w, h) {
  const row = (i) =>
    `<div class="row" style="height:40px;padding:0 12px;gap:24px;border-bottom:1px solid var(--separator)"><div class="sk" style="width:40px;height:11px"></div><div class="sk" style="width:${[30, 22, 36, 26, 28, 18, 34, 24][i % 8]}%;height:12px"></div><div class="grow"></div><div class="sk" style="width:64px;height:11px"></div><div class="sk" style="width:84px;height:11px"></div><div class="sk" style="width:16px;height:11px"></div><div class="sk" style="width:96px;height:12px"></div></div>`
  const content = `<div role="status" aria-label="Завантаження транзакцій" class="col grow" style="gap:14px;min-height:0"><div class="row" style="gap:8px"><div class="sk" style="width:300px;height:32px;border-radius:8px"></div><div class="sk" style="width:70px;height:32px;border-radius:8px"></div><div class="sk" style="width:84px;height:32px;border-radius:8px"></div><div class="sk" style="width:84px;height:32px;border-radius:8px"></div></div>
  <div class="grow" aria-hidden="true" style="min-height:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--r-xl);background:var(--card)"><div class="row" style="height:36px;padding:0 12px;gap:24px;font-size:12px;font-weight:600;color:var(--muted-fg);border-bottom:1px solid var(--border)"><span style="width:40px">Дата</span><span class="grow">Опис</span><span style="width:64px">Тип</span><span style="width:84px">Проєкт</span><span style="width:16px"></span><span style="width:96px;text-align:right">Сума</span></div>${Array.from({ length: 16 }, (_, i) => row(i)).join('')}</div></div>`
  return desktop({ w, h, content })
}

// ---------- ListRow empty / error (mobile) ----------
/** Empty and error inside a list: a filtered-empty block, an empty group, a failed group with a safe re-fetch. */
export function listrowEmptyError(w, h) {
  const sec = (t) => `<div class="sechead"><span class="t-over">${t}</span></div>`
  const inner = `${topBar({ title: 'ListRow · порожньо і помилка', bell: false, search: false })}<div class="content">
  ${chips(['Витрати', 'Проєкт «Дельта» ✕', 'Період ▾'])}
  ${sec('Порожньо після фільтра')}<div class="group"><div class="col" style="align-items:center;text-align:center;gap:4px;padding:22px 20px 14px"><span class="muted">${icon('search-x', { size: 22 })}</span><div class="t-body" style="font-weight:600;margin-top:4px">Немає транзакцій за цим фільтром</div><div class="t-foot muted">Змініть період або проєкт.</div><span class="btn sm ghost" style="color:var(--primary);height:44px;font-size:15px;margin-top:4px">Скинути фільтри</span></div></div>
  ${sec('Порожній розділ')}<div class="group"><div class="lrow" style="--inset:16px"><div class="grow t-body muted">Чеків ще немає</div></div></div>
  ${sec('Розділ не завантажився')}<div class="group"><div role="alert" class="lrow two" style="--inset:64px"><div class="lead" style="color:var(--destructive)">${icon('circle-alert', { size: 18 })}</div><div class="grow col" style="gap:2px"><div class="t-body" style="font-weight:500">Не вдалося завантажити документи</div><div class="t-foot muted">Решта сторінки працює.</div></div><span class="btn sm secondary" style="height:44px">${icon('rotate-cw', { size: 14 })}Повторити</span></div></div>
  <div style="padding:14px 16px 0" class="t-foot muted">«Повторити» тут лише перечитує дані (GET) — безпечно. Збереження грошей так не повторюється.</div></div>`
  return phone({ w, h, inner })
}
