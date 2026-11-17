// Finance list (Task 1.2), council round 1: the frames the round added (month filter, row writes,
// cached refetch failure, tablet two panes and side panels, coarse pointer, list footer, desktop
// detail) and `assertFixtures()`, which fails the render when a fixture stops adding up (M17).
import { icon, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { sheet, closeBtn, stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { detailActions } from '../../../_foundation/assets/src/prims-mobile.mjs'
import {
  ROWS,
  M,
  D,
  row,
  dayList,
  searchAndFilters,
  tabletFrame,
  desktopFrame,
  toolbar,
  table,
  pager,
  COMPANY,
} from './finance-list.mjs'
import {
  phoneTab,
  notice,
  ERROR,
  retry,
  filterBody,
  SHOW_N,
  LONG,
  WITH_DELETED,
} from './states.mjs'
import { detailBody, PEND, SEN, SEN_SHARE, DINC, DROP_BALANCE, DPAY } from './roles.mjs'

// ---------- Fixture self-check (M17): run before every render ----------
const RATE = 41.25 // UAH per USD, the fixture rate
const usdOf = (a) => Number(a.replace(/[^\d,]/g, '').replace(',', '.'))
const fmt = (n) =>
  `$${Math.floor(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${Math.round((n % 1) * 100)
    .toString()
    .padStart(2, '0')}`
const NAME_OK = [
  (s) => s === COMPANY,
  (s) => /^[А-ЯІЇЄҐ][а-яіїєґ’]+ Демо$/.test(s),
  (s) => /^Розробник \d+$/.test(s),
  (s) => /^Клієнт «[^»]+»$/.test(s),
  (s) => s === 'Розробник з дуже довгим ім’ям і прізвищем для перевірки переносу',
  (s) => ['Оренда офісу', 'Хмарний хостинг', 'Дизайн-інструмент', 'Обладнання', 'Банк'].includes(s),
]
export function assertFixtures() {
  const fail = []
  const check = (ok, msg) => ok || fail.push(msg)
  const rows = [...ROWS, ...LONG, ...WITH_DELETED, ...PEND, ...SEN]
  for (const r of rows) {
    check(/^(≈ )?\$\d{1,3}( \d{3})*,\d{2}$/.test(r.a), `amount format: ${r.a}`)
    for (const k of ['from', 'to', 't', 'sub'])
      if (r[k])
        check(
          NAME_OK.some((f) => f(r[k])),
          `invented name only: ${r[k]}`,
        )
    if (r.usd) check(usdOf(r.a) === r.usd, `usd ${r.usd} != ${r.a}`)
    if (r.uah) {
      check(Math.abs(r.usd * RATE - r.uah) < 0.01, `uah ${r.uah} != ${r.usd} × ${RATE}`)
      check(usdOf(r.orig.replace(' UAH', '')) === r.uah, `orig ${r.orig} != ${r.uah}`)
    }
  }
  // SENIOR strip: 20 % of the VALIDATED incomes not yet in a payout request; «Виплатити (N)».
  const validated = SEN.filter((r) => r.st === 'VALIDATED' && r.type === 'SENIOR_INCOME')
  const base = validated.reduce((s, r) => s + usdOf(r.a), 0)
  check(Math.abs(base * SEN_SHARE.pct - SEN_SHARE.value) < 0.01, `senior share ${base}`)
  check(fmt(SEN_SHARE.value) === SEN_SHARE.label, `senior label ${SEN_SHARE.label}`)
  check(validated.length === 2, `«Виплатити (2)» counts ${validated.length}`)
  // DROP balance: each figure is the sum of the rows it names (R1-11).
  const sum = (f) => DINC.filter(f).reduce((s, r) => s + r.usd, 0)
  const b = DROP_BALANCE
  const paid = (r) => r.model === 'obligation' && r.st === 'paid'
  const open = (r) => r.model === 'obligation' && r.st === 'validated'
  const work = (r) => r.model === 'declared' && r.st === 'pending'
  check(sum(paid) === b.received.usd && fmt(b.received.usd) === b.received.label, 'drop received')
  check(sum(open) === b.awaiting.usd && fmt(b.awaiting.usd) === b.awaiting.label, 'drop awaiting')
  check(DINC.filter(open).length === b.awaiting.count, 'drop awaiting count')
  check(DINC.filter(work).length === b.inWork.count, 'drop in-work count')
  for (const r of DINC) check(fmt(r.usd) === r.a, `drop row ${r.a}`)
  for (const p of DPAY) check(/^\$\d{1,3}( \d{3})*,\d{2}$/.test(p.a), `drop transfer ${p.a}`)
  if (fail.length) throw new Error(`fixtures do not add up:\n- ${fail.join('\n- ')}`)
  return rows.length + DINC.length + DPAY.length
}

// ---------- Shared pieces ----------
const sel = (html, x) => html.replace(row(x), row(x, { sel: true }))
const withMark = (i, mark) => ROWS.map((r, k) => (k === i ? { ...r, mark } : r))

// Banner of an unknown write, in the detail / pane / side panel (§9.2).
const unknownBanner = `<div role="status" class="col" style="gap:8px;margin:0 0 16px;padding:12px 14px;border-radius:12px;background:var(--yellow-subtle);border:1px solid oklch(0.34 0.07 85)"><div class="row" style="gap:8px;align-items:flex-start"><span style="color:var(--warning);display:grid;flex:none;margin-top:1px">${icon('circle-alert', { size: 17 })}</span><div class="col" style="gap:3px"><span style="font-size:15px;font-weight:600">Невідомо, чи зміну збережено</span><span class="t-foot" style="color:var(--fg)">Відповідь не надійшла. Оновіть список: статус покаже, чи зміну збережено. Не повторюйте дію, доки статус не оновиться.</span></div></div><div class="row" style="gap:8px;padding-left:25px"><span class="btn secondary sm" style="height:36px">${icon('rotate-cw', { size: 15 })}Оновити</span><span class="btn ghost sm" style="height:36px">Зрозуміло</span></div></div>`

// Desktop row detail: the foundation side panel shell, non-modal. The panel docks: the list column
// narrows by the panel width and the table switches to its compact (< 1280) columns, so every
// column, the selected row and its row-write marker stay visible (§3.5). 420 at 1024–1439, 480 at ≥ 1440.
const panelW = (w) => (w >= 1440 ? 480 : 420)
const detailPanel = (w, { banner = '' } = {}) =>
  `<style>main{margin-right:${panelW(w)}px}</style><aside aria-labelledby="dp-t" style="position:absolute;top:0;right:0;bottom:0;width:${panelW(w)}px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 12px 0 24px;gap:4px;border-bottom:1px solid var(--border)"><h2 id="dp-t" class="grow t-head" style="margin:0">Транзакція</h2><span class="btn ghost sm" style="height:32px;font-size:14px">Редагувати<span class="kbdkey">E</span></span><span class="iconbtn" aria-label="Інші дії" aria-haspopup="menu" style="width:32px;height:32px">${icon('ellipsis', { size: 16 })}</span><span class="kbdkey" style="margin:0 4px 0 6px">Esc</span><span class="iconbtn" aria-label="Закрити" style="width:32px;height:32px">${icon('x', { size: 18 })}</span></div>
  <div class="col grow" style="min-height:0;overflow:hidden;padding:16px 24px">${detailBody(undefined, { banner }).replace('<h1 ', '<p ').replace('</h1>', '</p>')}</div></aside>`
// Docked: the compact table without «Тип · проєкт» (the panel shows both), so the party keeps room.
const docked = (html) =>
  html
    .replace('<col style="width:150px">', '')
    .replace('<th>Тип · проєкт</th>', '')
    .replace(/<td class="muted">[^<]*<\/td>/g, '')
const detailD = (w, h, { banner = '', mark } = {}) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w: 1024, deleted: false })}${docked(table(mark ? withMark(3, mark) : ROWS, { w: 1024, sel: 3 }))}${pager()}`,
    overlay: detailPanel(w, { banner }),
  })

// ---------- Month filter (M1, A-1): a chip on phone, a whole-button chip on desktop ----------
const monthM = (w, h) =>
  phoneTab(w, h, { body: `${searchAndFilters({ active: ['Листопад 2026'] })}${dayList(ROWS)}` })
const monthD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${toolbar({ w, deleted: false, month: 'Листопад 2026', count: '41 з 132' })}${table(ROWS, { w, sel: -1 })}`,
  })
const monthEmptyM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters({ active: ['Березень 2026'] })}${stateBlock({
      ic: 'calendar',
      title: 'За березень 2026 транзакцій немає',
      action: '<span class="btn secondary" style="height:44px">Показати всі місяці</span>',
    })}`,
  })

// ---------- Row writes (§9.2): pending, unknown, definite failure ----------
const pendingM = (w, h) =>
  phoneTab(w, h, { body: `${searchAndFilters()}${dayList(withMark(1, 'pending').slice(0, 7))}` })
const unknownM = (w, h) =>
  phoneTab(w, h, { body: `${searchAndFilters()}${dayList(withMark(3, 'unknown').slice(0, 7))}` })
const kv = (k, v) =>
  `<div class="lrow" style="min-height:48px"><div class="t-body muted" style="flex:none">${k}</div><div class="grow t-body" style="text-align:right">${v}</div></div>`
const failedAlert = `<div role="alert" class="row" style="gap:10px;align-items:flex-start;margin:14px 16px 0;padding:12px 14px;border-radius:12px;background:oklch(0.22 0.05 25);border:1px solid oklch(0.42 0.12 25)"><span style="color:var(--destructive);display:grid;flex:none;margin-top:1px">${icon('circle-alert', { size: 17 })}</span><div class="col" style="gap:3px"><span style="font-size:15px;font-weight:600">Не вдалося валідувати дохід</span><span class="t-foot" style="color:var(--fg)">Нічого не змінено. Дані у формі залишились — спробуйте ще раз.</span></div></div>`
const failedM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${dayList(ROWS.slice(0, 6))}`,
    showFab: false,
    overlay: sheet({
      w,
      h,
      top: Math.round(h * 0.4),
      title: 'Валідувати дохід',
      lead: '<span style="font-size:17px">Скасувати</span>',
      trail: '',
      body: `<div class="group">${kv('Сума', `<span class="num">${ROWS[1].a}</span>`)}${kv('Від', ROWS[1].from)}${kv('Кому', ROWS[1].to)}${kv('Проєкт', `Проєкт «${ROWS[1].project}»`)}</div>${failedAlert}`,
      footer: `<div style="padding:12px 16px ${safeBottom(w) + 8}px"><span class="btn primary" style="width:100%">Валідувати</span></div>`,
    }),
  })

// ---------- Cached refetch failed (M3): rows stay, one alert notice ----------
const refetchM = (w, h) =>
  phoneTab(w, h, {
    body: `${searchAndFilters()}${notice('Не вдалося оновити. Показано дані станом на 14:32.', { ic: 'cloud-alert', tone: 'var(--destructive)', role: 'alert', action: retry })}${dayList(ROWS.slice(0, 7))}`,
  })

// ---------- List footer: «Не вдалося завантажити ще» + «Повторити» (the loading footer is by rule) ----------
const footerM = (w, h) =>
  phoneTab(w, h, {
    body: `${dayList(ROWS.slice(5))}<div role="alert" class="row" style="gap:10px;justify-content:center;padding:14px 16px"><span class="t-foot muted">Не вдалося завантажити ще</span><span class="btn ghost sm" style="height:44px;color:var(--primary)">${icon('rotate-cw', { size: 16 })}Повторити</span></div>`,
  })

// ---------- Tablet: two panes at ≥ 900, filter side panel, error ----------
const pane = `<section aria-labelledby="pn-t" class="grow col" style="min-width:0"><div class="row" style="height:56px;padding:0 8px 0 24px;flex:none"><h2 id="pn-t" class="grow t-head" style="margin:0">Транзакція</h2>${detailActions}</div><div style="flex:1;min-height:0;overflow:hidden;padding:0 24px">${detailBody().replace('<h1 ', '<p ').replace('</h1>', '</p>')}</div></section>`
const main1000 = (w, h) =>
  tabletFrame({
    w,
    h,
    pane,
    body: `${searchAndFilters()}${sel(dayList(ROWS.slice(0, 8)), ROWS[3])}`,
  })
const filterPanel = (w) =>
  `<div style="position:absolute;inset:0;background:oklch(0 0 0 / 0.5);z-index:60"></div>
  <aside role="dialog" aria-modal="true" aria-labelledby="fp-t" style="position:absolute;top:0;right:0;bottom:0;width:400px;z-index:70;background:var(--popover);border-left:1px solid oklch(0.28 0.006 85);box-shadow:-24px 0 60px oklch(0 0 0 / 0.5);display:flex;flex-direction:column">
  <div class="row" style="height:60px;flex:none;padding:0 8px 0 16px;gap:8px;border-bottom:1px solid var(--border)"><span class="btn ghost" style="height:44px;font-size:17px;padding:0 8px;color:var(--primary)">Скинути</span><h2 id="fp-t" class="grow t-head" style="margin:0;text-align:center">Фільтри</h2>${closeBtn}</div>
  <div class="grow" style="min-height:0;padding:16px 0">${filterBody()}</div>
  <div style="padding:14px 16px ${safeBottom(w) + 8}px;border-top:1px solid var(--border)"><span class="btn primary" style="width:100%">${SHOW_N}</span></div></aside>`
const filters768 = (w, h) =>
  tabletFrame({
    w,
    h,
    body: `${searchAndFilters({ active: ['Статус: Очікує валідації'] })}${dayList(ROWS.filter((r) => r.st === 'PENDING'))}`,
    overlay: filterPanel(w),
  })
const error768 = (w, h) => tabletFrame({ w, h, body: `${searchAndFilters()}${stateBlock(ERROR)}` })

// ---------- Coarse pointer at desktop width (M9): 44 px controls, 52 px rows, «…» always visible ----------
const touch = (html) =>
  html.replaceAll('height:32px', 'height:44px').replaceAll('width:32px', 'width:44px')
const touchD = (w, h) =>
  desktopFrame({
    w,
    h,
    body: `${touch(toolbar({ w, deleted: false }))}${table(ROWS, { w, sel: 1, coarse: true })}${touch(pager())}`,
  })

export function round1Frames() {
  return [
    M('main-1000', 1000, 760, main1000(1000, 760)),
    D('main-touch-1180', 1180, 820, touchD(1180, 820)),
    M('month-375', 375, 812, monthM(375, 812)),
    D('month-1440', 1440, 900, monthD(1440, 900)),
    M('month-empty-375', 375, 812, monthEmptyM(375, 812)),
    M('error-768', 768, 1024, error768(768, 1024)),
    M('refetch-failed-375', 375, 812, refetchM(375, 812)),
    M('filters-768', 768, 1024, filters768(768, 1024)),
    M('footer-375', 375, 812, footerM(375, 812)),
    M('row-write-pending-375', 375, 812, pendingM(375, 812)),
    M('row-write-failed-375', 375, 812, failedM(375, 812)),
    M('row-write-unknown-375', 375, 812, unknownM(375, 812)),
    D(
      'row-write-unknown-1440',
      1440,
      900,
      detailD(1440, 900, { banner: unknownBanner, mark: 'unknown' }),
    ),
    D('detail-1440', 1440, 900, detailD(1440, 900)),
  ]
}
