// Stats screen: phone layout (< 640) and its sheets, skeleton and shell states.
import { icon, segmented, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { tabScreen } from '../../../_foundation/assets/src/mobile.mjs'
import { sheet, closeBtn, stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import {
  MONTHS,
  PARTNERS,
  PERIODS,
  PERIOD_N,
  S,
  SERIES,
  card,
  money,
  periodIdx,
  srOnly,
  retry,
  FIT_END,
  KPIS,
  PARTNER_HINT,
  COMPANY_HINT,
} from './data.mjs'
import {
  chartLabel,
  plot,
  plotCaption,
  phoneReadout,
  monthTable,
  stepBtn,
  yearOf,
} from './chart.mjs'
import { skel } from './wide.mjs'
import { partnerCard, companyRow, kpiList, complianceList, statusStrip, srH2 } from './blocks.mjs'

export const gap = (h = 12) => `<div style="height:${h}px"></div>`

const EMPTY_CHART = (pad) =>
  `<div class="col" style="align-items:center;text-align:center;gap:4px;padding:24px 8px 8px"><span class="muted">${icon('chart-column', { size: 28 })}</span><div class="t-head" style="margin-top:6px">Ще немає даних за місяцями</div><div class="t-foot muted" style="max-width:260px">Графік з’явиться після першої оплаченої транзакції.</div><span class="btn secondary" style="margin-top:12px;height:44px">${icon('plus', { size: 16 })}Нова транзакція</span></div>`

export function chartCard({
  W,
  series = 'profit',
  period = 0,
  sel = null,
  narrow = false,
  pad = 16,
  empty = false,
  scrub = false,
}) {
  const n = PERIOD_N[period]
  const idx = periodIdx(n)
  const len = idx.length
  const s = sel ?? len - 1
  const name = SERIES.find((x) => x[0] === series)[1]
  const inner = W - pad * 2
  const seriesBtn = `<span class="pill" role="button" aria-haspopup="listbox" aria-label="Показник графіка: ${name}" style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font-weight:600;flex:none">${name} ${icon('chevron-down', { size: 15 })}</span>`
  const seg = segmented(PERIODS, period, { fit: true, size: 13 })
  const controls = narrow
    ? `<div class="row">${seg}</div><div class="row" style="margin-top:8px">${seriesBtn}</div>`
    : `<div class="row" style="gap:8px;justify-content:space-between">${seg}${seriesBtn}</div>`
  const head = `${srH2('Динаміка за місяцями')}${controls}`
  if (empty)
    return card(
      `<div style="padding:${pad - 2}px ${pad}px ${pad}px">${head}${EMPTY_CHART(pad)}</div>`,
    )
  const axisW = len > 6 ? 22 : 0
  const p = plot({
    W: inner,
    H: narrow ? 132 : 120,
    series,
    idx,
    sel: s,
    axisW,
    scrub,
    unit: 'тис. USD',
    label: chartLabel(series, idx),
  })
  // The unit is drawn in the plot's top-left corner; the legend and the scroll hint sit on one line above the plot, so the first viewport keeps them (R2-19).
  const body = `${phoneReadout({ series, i: idx[s], pos: s, n: len, narrow })}${plotCaption(p, { unit: false })}<div style="margin-top:10px">${p.svg}</div>`
  return card(
    `<div style="padding:${pad - 2}px ${pad}px 12px">${head}${body}${monthTable({ idx, sel: s, series, touch: true, sr: true })}</div>`,
  )
}

export function phoneBody({
  role = 'ADMIN',
  w = 375,
  partners = PARTNERS,
  chart = {},
  company = 'ok',
  compliance = {},
  summary = 'ok',
  offline = false,
}) {
  const narrow = w < 360
  const m = narrow ? 12 : 16
  const pad = narrow ? 12 : 16
  const cold = summary === 'cold'
  const top =
    summary === 'error' || cold
      ? `<div style="padding:0 ${m}px">${card(stateBlock({ ic: cold ? 'wifi-off' : 'cloud-alert', tone: 'var(--destructive)', role: 'alert', title: cold ? 'Немає з’єднання' : 'Не вдалося завантажити фінансову статистику', text: cold ? 'Збережених даних ще немає. Підключіться до інтернету й повторіть.' : 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.', action: retry({ h: 44, size: 18, disabled: offline }) }).replace('padding:56px 32px 0', 'padding:24px 16px 20px'))}</div>`
      : `<div style="padding:0 ${m}px">${partnerCard(partners, { pad, narrow })}${gap()}${chartCard({ W: w - 2 * m, narrow, pad, empty: summary === 'empty', ...chart })}</div>`
  const kpis =
    summary === 'error' || cold
      ? ''
      : `<div class="sechead"><h2 class="t-over" style="margin:0">Показники</h2></div>${kpiList({ count: summary === 'empty' ? 4 : 8 })}`
  const comp = complianceList({
    state: compliance.state ?? 'ok',
    expanded: compliance.expanded ?? -1,
    offline,
  })
  return `${top}${gap()}<div class="group">${companyRow({ state: company, role, offline })}</div>${kpis}${comp}${FIT_END}`
}

/**
 * Phone frame. overlay = sheet. strip = {kind, when, busy}: the one status strip (M3), sticky at the top of
 * the scroll area so it stays visible under the top bar. scroll = px the page is scrolled (R2-06 frame).
 */
export function stats375({
  w = 375,
  h = 812,
  role = 'ADMIN',
  strip = null,
  scroll = 0,
  overlay = '',
  showFab = true,
  ...rest
} = {}) {
  const m = w < 360 ? 12 : 16
  let html = tabScreen({
    w,
    h,
    role,
    active: '/stats',
    title: 'Статистика',
    overlay,
    showFab,
    scrolled: scroll > 0,
    body: phoneBody({ role, w, offline: strip?.kind === 'cold', ...rest }),
  })
  if (strip) {
    const sticky = `<div style="position:sticky;top:0;z-index:5;background:var(--bg);padding-top:4px">${statusStrip({ ...strip, touch: true, mx: m, compact: w < 360 })}</div>`
    html = html.replace('<div class="content">', `<div class="content">${sticky}`)
  }
  if (scroll > 0) html += `<script>document.querySelector('.content').scrollTop=${scroll}</script>`
  return html
}

// ---------- Skeleton in final geometry (M5, M6) ----------
// The default frame's own DOM with placeholders for the ink; the FAB is hidden while loading.
export function loadingPhone(w, h) {
  return tabScreen({
    w,
    h,
    role: 'ADMIN',
    active: '/stats',
    title: 'Статистика',
    showFab: false,
    body: skel(phoneBody({ w })),
  })
}

// ---------- Sheets ----------
const nav = (dir) => stepBtn(dir, false, 44)

export function seriesSheet(w, h, current = 0) {
  const rows = SERIES.map(
    ([k, t], i) =>
      `<div class="lrow" role="option" aria-selected="${i === current}" style="min-height:48px"><div class="grow t-body">${t}</div>${i === current ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.4 })}</span>` : ''}</div>`,
  ).join('')
  return stats375({
    w,
    h,
    showFab: false,
    overlay: sheet({
      w,
      h,
      top: h - 330 - safeBottom(w),
      title: 'Показник графіка',
      trail: closeBtn,
      body: `<div role="listbox" aria-label="Показник графіка" class="group" style="margin:4px 16px 0">${rows}</div>`,
    }),
  })
}

export function monthSheet(w, h, i = 19) {
  const rows = [
    ['Дохід', S.income[i], false],
    ['Витрати', S.expenses[i], false],
    ['Зарплати', S.salaries[i], false],
  ]
    .map(
      ([t, v]) =>
        `<div class="lrow"><div class="grow t-body">${t}</div><span class="amount num">${money(v * 1000)}</span></div>`,
    )
    .join('')
  const p = S.profit[i]
  return stats375({
    w,
    h,
    showFab: false,
    chart: { period: 0 },
    overlay: sheet({
      w,
      h,
      top: h - 470 - safeBottom(w),
      title: MONTHS[i].full,
      lead: nav(-1),
      // The newest month has no next month: the › button is disabled (aria-disabled, 40 % opacity).
      trail: stepBtn(1, i >= S.profit.length - 1, 44),
      body: `<div class="group" style="margin:4px 16px 0">${rows}<div class="lrow"><div class="grow t-body" style="font-weight:600">Прибуток</div><span class="amount num" style="font-size:18px;${p < 0 ? 'color:var(--destructive)' : ''}">${money(p * 1000, 'USD', { sign: true })}</span></div></div><div class="group" style="margin:12px 16px 0"><div class="lrow" role="link"><div class="lead">${icon('receipt', { size: 18 })}</div><div class="grow t-body">Транзакції за ${yearOf(i)}</div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div></div><div style="padding:12px 16px 0"><span class="btn secondary" style="width:100%;height:44px">Закрити</span></div>`,
    }),
  })
}

export function hintSheet(w, h, which = 'kpi') {
  const map = {
    kpi: [KPIS[0].t, KPIS[0].hint, 196],
    partner: ['Баланси партнерів', PARTNER_HINT, 266],
    company: ['Рахунок компанії', COMPANY_HINT, 232],
  }
  const [title, text, height] = map[which]
  return stats375({
    w,
    h,
    showFab: false,
    overlay: sheet({
      w,
      h,
      top: h - height - safeBottom(w),
      title,
      trail: closeBtn,
      body: `<div class="t-body" style="padding:4px 20px 0">${text}</div>`,
    }),
  })
}

export const hiddenTable = srOnly
