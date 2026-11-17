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
  sk,
  srOnly,
  FIT_END,
  KPIS,
  PARTNER_HINT,
  COMPANY_HINT,
} from './data.mjs'
import { chartLabel, plot, plotCaption, phoneReadout, monthTable, stepBtn } from './chart.mjs'
import {
  partnerCard,
  companyRow,
  kpiList,
  complianceList,
  staleBar,
  STALE_AT,
  srH2,
} from './blocks.mjs'

export const gap = (h = 12) => `<div style="height:${h}px"></div>`

/** Screen-specific offline stamp: directly under the top bar, above the large title (M8). */
export const offlineStrip = () =>
  `<div role="status" class="row" style="gap:8px;margin:0 12px 4px;padding:8px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:18px"><span style="color:var(--warning)">${icon('wifi-off', { size: 16 })}</span><span class="grow">Немає мережі · показано дані станом на ${STALE_AT}</span></div>`

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
  strip = false,
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
    line: len > 6,
    label: chartLabel(series, idx),
  })
  const body = `${phoneReadout({ series, i: idx[s], pos: s, n: len, narrow })}<div style="margin-top:6px">${p.svg}</div>${plotCaption(p)}`
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
  stale = false,
}) {
  const narrow = w < 360
  const m = narrow ? 12 : 16
  const pad = narrow ? 12 : 16
  const staleHtml = stale
    ? `<div style="padding:0 ${m}px 12px">${staleBar({ touch: true })}</div>`
    : ''
  const top =
    summary === 'error'
      ? `<div style="padding:0 ${m}px">${card(stateBlock({ ic: 'cloud-alert', tone: 'var(--destructive)', role: 'alert', title: 'Не вдалося завантажити фінансову статистику', text: 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.', action: `<span class="btn secondary" style="height:44px">${icon('rotate-cw', { size: 18 })}Повторити</span>` }).replace('padding:56px 32px 0', 'padding:24px 16px 20px'))}</div>`
      : `${staleHtml}<div style="padding:0 ${m}px">${partnerCard(partners, { pad, narrow })}${gap()}${chartCard({ W: w - 2 * m, narrow, pad, empty: summary === 'empty', ...chart })}</div>`
  const kpis =
    summary === 'error'
      ? ''
      : `<div class="sechead"><h2 class="t-over" style="margin:0">Показники</h2></div>${kpiList({ count: summary === 'empty' ? 4 : 8 })}`
  const comp = complianceList({
    state: compliance.state ?? 'ok',
    expanded: compliance.expanded ?? -1,
  })
  return `${top}${gap()}<div class="group">${companyRow({ state: company, role })}</div>${kpis}${comp}${FIT_END}`
}

/** Phone frame. overlay = sheet; banner = strip under the top bar. */
export function stats375({
  w = 375,
  h = 812,
  role = 'ADMIN',
  banner = '',
  overlay = '',
  showFab = true,
  ...rest
} = {}) {
  const html = tabScreen({
    w,
    h,
    role,
    active: '/stats',
    title: 'Статистика',
    overlay,
    showFab,
    body: phoneBody({ role, w, ...rest }),
  })
  return banner ? html.replace('<div class="content">', `${banner}<div class="content">`) : html
}

// ---------- Skeleton in final geometry ----------
export function loadingPhone(w, h) {
  const narrow = w < 360
  const m = narrow ? 12 : 16
  const pad = narrow ? 12 : 16
  const partner = card(
    `<div style="padding:${pad}px">${sk('45%', 11)}${sk('30%', 11, 'margin-top:20px')}${sk('60%', 30, 'margin-top:8px')}${sk('70%', 12, 'margin-top:8px')}${[0, 1].map(() => `<div class="row" style="gap:12px;margin-top:16px"><div class="sk" style="width:36px;height:36px;border-radius:18px;flex:none"></div><div class="grow">${sk('70%', 14)}${sk('45%', 11, 'margin-top:6px')}${sk('100%', 4, 'margin-top:8px')}</div></div>`).join('')}</div>`,
  )
  const chart = card(
    `<div style="padding:${pad}px">${sk('100%', 44, 'border-radius:22px')}${sk('45%', 48, 'margin-top:10px')}<div class="row" style="align-items:flex-end;gap:10px;height:140px;margin-top:6px">${[50, 75, 30, 60, 90, 45].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div>${sk('30%', 11, 'margin-top:8px')}</div>`,
  )
  const lrow = `<div class="lrow two" style="gap:8px"><div class="grow">${sk('50%', 14)}${sk('30%', 11, 'margin-top:6px')}</div>${sk('90px', 16)}</div>`
  const body = `<div role="status" aria-label="Завантаження статистики" style="display:contents"><div style="padding:0 ${m}px">${partner}${gap()}${chart}</div>${gap()}<div class="group">${lrow}</div><div class="sechead">${sk('80px', 11)}</div><div class="group">${lrow.repeat(8)}</div>${FIT_END}</div>`
  return tabScreen({ w, h, role: 'ADMIN', active: '/stats', title: 'Статистика', body })
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
      body: `<div class="group" style="margin:4px 16px 0">${rows}<div class="lrow"><div class="grow t-body" style="font-weight:600">Прибуток</div><span class="amount num" style="font-size:18px;${p < 0 ? 'color:var(--destructive)' : ''}">${money(p * 1000, 'USD', { sign: true })}</span></div></div><div class="group" style="margin:12px 16px 0"><div class="lrow" role="link"><div class="lead">${icon('receipt', { size: 18 })}</div><div class="grow t-body">Транзакції за ${MONTHS[i].name}</div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div></div><div style="padding:12px 16px 0"><span class="btn secondary" style="width:100%;height:44px">Закрити</span></div>`,
    }),
  })
}

export function hintSheet(w, h, which = 'kpi') {
  const map = {
    kpi: [KPIS[0].t, KPIS[0].hint, 196],
    partner: ['Баланси партнерів', `${PARTNER_HINT}`, 250],
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
