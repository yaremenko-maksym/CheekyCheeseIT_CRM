// Stats screen: tablet (640–1023) and desktop (≥ 1024) layouts, chart card, skeletons.
import { icon, segmented } from '../../../_foundation/assets/src/base.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { allowed, TABS } from '../../../_foundation/assets/src/nav.mjs'
import { stateBlock } from '../../../_foundation/assets/src/mobile-overlays.mjs'
import {
  PARTNERS,
  PERIODS,
  PERIOD_N,
  SERIES,
  FIT_END,
  card,
  periodIdx,
  sk,
  KPIS,
  MONTHS,
  seriesMoney,
  S,
} from './data.mjs'
import { chartLabel, plot, plotCaption, dockedReadout, monthTable } from './chart.mjs'
import {
  partnerCard,
  companyRow,
  kpiTiles,
  complianceList,
  complianceDesk,
  staleBar,
  srH2,
} from './blocks.mjs'
import { offlineStrip } from './phone.mjs'

/** Run `fn` while ADMIN's nav model is temporarily another role's (in memory only; foundation files are untouched). */
export function withRole(role, fn) {
  if (role === 'ADMIN') return fn()
  const a = allowed('ADMIN')
  const t = TABS.ADMIN
  const sa = [...a]
  const st = [...t]
  a.splice(0, a.length, ...allowed(role))
  t.splice(0, t.length, ...TABS[role])
  try {
    return fn()
  } finally {
    a.splice(0, a.length, ...sa)
    t.splice(0, t.length, ...st)
  }
}

const segDesk = (opts, on) =>
  `<div role="radiogroup" class="row" style="height:32px;border-radius:8px;background:var(--surface);border:1px solid var(--border);padding:2px;flex:none">${opts.map((o, i) => `<span role="radio" aria-checked="${i === on}" style="height:26px;padding:0 10px;border-radius:6px;display:grid;place-items:center;font-size:13px;font-weight:600;white-space:nowrap;${i === on ? 'background:var(--raised);color:var(--fg)' : 'color:var(--muted-fg)'}">${o}</span>`).join('')}</div>`
const segCtl = (opts, on, touch) =>
  touch ? segmented(opts, on, { fit: true, size: 14 }) : segDesk(opts, on)

const EMPTY = (touch) =>
  `<div class="col" style="align-items:center;gap:4px;padding:44px 0 32px;text-align:center"><span class="muted">${icon('chart-column', { size: 28 })}</span><div class="t-head" style="margin-top:6px">Ще немає даних за місяцями</div><div class="t-foot muted">Графік з’явиться після першої оплаченої транзакції.</div><span class="btn secondary ${touch ? '' : 'sm'}" style="margin-top:12px;${touch ? 'height:44px' : ''}">${icon('plus', { size: 16 })}Нова транзакція</span></div>`

/** Chart card for tablet and desktop. `sel` is a position inside the period; `hover` draws the scrub line. */
export function chartWide({
  W,
  series = 'profit',
  period = 0,
  sel = null,
  touch = false,
  hover = false,
  empty = false,
  H = 220,
  cap = 12,
}) {
  const idx = periodIdx(PERIOD_N[period])
  const len = idx.length
  const s = sel ?? len - 1
  const inner = W - 40
  const head = `<div class="row" style="gap:12px;align-items:center"><h2 class="t-head grow" style="margin:0;white-space:nowrap">Динаміка за місяцями</h2>${segCtl(PERIODS, period, touch)}</div><div style="margin-top:10px">${segCtl(
    SERIES.map((x) => x[1]),
    SERIES.findIndex((x) => x[0] === series),
    touch,
  )}</div>`
  if (empty) return card(`<div style="padding:16px 20px 20px">${head}${EMPTY(touch)}</div>`)
  const p = plot({
    W: inner,
    H,
    series,
    idx,
    sel: s,
    axisW: 34,
    line: hover,
    label: chartLabel(series, idx),
    dim: hover,
  })
  const ro = dockedReadout({ series, i: idx[s], pos: s, n: len, touch, W: inner })
  return card(
    `<div style="padding:16px 20px 16px">${head}<div style="margin-top:12px">${ro}</div><div style="margin-top:12px">${p.svg}</div>${plotCaption(p)}${monthTable({ idx, sel: s, series, touch, cap })}</div>`,
  )
}

// ---------- Skeletons in final geometry ----------
const skPartner = (wide) =>
  card(
    `<div style="padding:16px">${sk('35%', 11)}${wide ? `<div class="row" style="gap:28px;margin-top:16px"><div style="width:44%">${sk('40%', 11)}${sk('60%', 30, 'margin-top:8px')}${sk('70%', 12, 'margin-top:8px')}</div><div class="grow">${[0, 1].map(() => `<div class="row" style="gap:12px;margin-bottom:12px"><div class="sk" style="width:36px;height:36px;border-radius:18px;flex:none"></div><div class="grow">${sk('70%', 14)}${sk('45%', 11, 'margin-top:6px')}${sk('100%', 4, 'margin-top:8px')}</div></div>`).join('')}</div></div>` : `${sk('30%', 11, 'margin-top:18px')}${sk('60%', 30, 'margin-top:8px')}${[0, 1].map(() => `<div class="row" style="gap:12px;margin-top:16px"><div class="sk" style="width:36px;height:36px;border-radius:18px;flex:none"></div><div class="grow">${sk('70%', 14)}${sk('45%', 11, 'margin-top:6px')}${sk('100%', 4, 'margin-top:8px')}</div></div>`).join('')}`}</div>`,
  )
const skChart = (H, rows) =>
  card(
    `<div style="padding:16px 20px"><div class="row" style="justify-content:space-between">${sk('30%', 16)}${sk('180px', 32, 'border-radius:8px')}</div>${sk('300px', 32, 'margin-top:10px;border-radius:8px')}${sk('100%', 60, 'margin-top:12px;border-radius:12px')}<div class="row" style="align-items:flex-end;gap:24px;height:${H}px;margin-top:12px">${[50, 75, 30, 60, 90, 45].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div>${Array.from({ length: rows }, () => sk('100%', 14, 'margin-top:22px')).join('')}</div>`,
  )
const skTiles = (cols) =>
  `<div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px">${Array.from({ length: 8 }, () => card(`<div style="padding:14px">${sk('60%', 11)}${sk('80%', 22, 'margin-top:10px')}${sk('40%', 11, 'margin-top:8px')}</div>`)).join('')}</div>`
const skCompany = card(
  `<div class="lrow two">${sk('36px', 36, 'border-radius:10px')}<div class="grow">${sk('40%', 14)}${sk('25%', 11, 'margin-top:6px')}</div>${sk('110px', 16)}</div>`,
  'overflow:hidden',
)

// ---------- Body assembly ----------
const sectionLabel = (t, mt = 8) => `<h2 class="t-over" style="margin:${mt}px 0 8px">${t}</h2>`
const errBlock = (touch) =>
  card(
    stateBlock({
      ic: 'cloud-alert',
      tone: 'var(--destructive)',
      role: 'alert',
      title: 'Не вдалося завантажити фінансову статистику',
      text: 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.',
      action: `<span class="btn secondary ${touch ? '' : 'sm'}" style="${touch ? 'height:44px' : ''}">${icon('rotate-cw', { size: touch ? 18 : 15 })}Повторити</span>`,
    }).replace('padding:56px 32px 0', 'padding:28px 24px 24px'),
  )

/** One column (tablet and desktop 1024–1279). contentW = width available to cards. */
function columnBody({
  contentW,
  touch,
  role,
  partners,
  summary,
  company,
  compliance,
  chart,
  stale,
  kpiCols,
}) {
  const fine = !touch
  const compl = touch
    ? `<div style="margin:0 -16px">${complianceList({ state: compliance.state ?? 'ok', expanded: compliance.expanded ?? -1, cols: 4 })}</div>`
    : complianceDesk({
        state: compliance.state ?? 'ok',
        expanded: compliance.expanded ?? -1,
        bar: contentW >= 900,
      })
  const staleHtml = stale ? staleBar({ touch }) : ''
  if (summary === 'error')
    return `${errBlock(touch)}${card(companyRow({ state: company, variant: 'row', fine, role }), 'overflow:hidden')}${compl}`
  const tiles = `<div>${sectionLabel('Показники')}${kpiTiles(kpiCols, { fine, count: summary === 'empty' ? 4 : 8, vs: kpiCols === 4 ? 17 : 20 })}</div>`
  return `${staleHtml}${partnerCard(partners, { pad: 20, wide: true, fine })}${chartWide({ W: contentW, touch, empty: summary === 'empty', ...chart })}${card(companyRow({ state: company, variant: 'row', fine, role }), 'overflow:hidden')}${tiles}${compl}`
}

/** Two columns (desktop ≥ 1280): partner + company + KPIs on the left, chart on the right. */
function splitBody({ contentW, role, partners, summary, company, compliance, chart, stale }) {
  const leftW = 380
  const compl = complianceDesk({
    state: compliance.state ?? 'ok',
    expanded: compliance.expanded ?? -1,
  })
  const staleHtml = stale ? staleBar({ touch: false }) : ''
  const companyCard = card(
    companyRow({ state: company, variant: 'row', fine: true, role }),
    'overflow:hidden',
  )
  if (summary === 'error')
    return `<div class="row" style="gap:16px;align-items:stretch"><div class="grow">${errBlock(false)}</div><div style="width:${leftW}px;flex:none">${companyCard}</div></div>${compl}`
  const left = `<div class="col" style="width:${leftW}px;flex:none;gap:16px">${partnerCard(partners, { pad: 16, fine: true })}${companyCard}<div>${sectionLabel('Показники', 4)}${kpiTiles(2, { fine: true, count: summary === 'empty' ? 4 : 8, vs: 17 })}</div></div>`
  const right = `<div class="grow" style="min-width:0">${chartWide({ W: contentW - leftW - 16, empty: summary === 'empty', H: 330, cap: 8, ...chart })}</div>`
  return `${staleHtml}<div class="row" style="gap:16px;align-items:flex-start">${left}${right}</div>${compl}`
}

function loadingBody({ split, contentW, touch }) {
  const status = (inner) =>
    `<div role="status" aria-label="Завантаження статистики" class="col" style="gap:16px">${inner}${FIT_END}</div>`
  if (split)
    return status(
      `<div class="row" style="gap:16px;align-items:flex-start"><div class="col" style="width:380px;flex:none;gap:16px">${skPartner(false)}${skCompany}${skTiles(2)}</div><div class="grow">${skChart(280, 6)}</div></div>`,
    )
  return status(`${skPartner(true)}${skChart(220, 6)}${skCompany}${skTiles(touch ? 2 : 4)}`)
}

// ---------- Frames ----------
const contentWidth = (w) => Math.min(w - 248 - 48, 1280 - 48)

/** Desktop frame (≥ 1024). touch = coarse pointer on a desktop-width screen (M7). */
export function deskFrame(w, h, opts = {}) {
  const { role = 'ADMIN', touch = false, loading = false, banner = '', overlay = '' } = opts
  const contentW = contentWidth(w)
  const split = w >= 1280 && !touch
  const args = {
    contentW,
    touch,
    role,
    partners: opts.partners ?? PARTNERS,
    summary: opts.summary ?? 'ok',
    company: opts.company ?? 'ok',
    compliance: opts.compliance ?? {},
    chart: opts.chart ?? {},
    stale: opts.stale,
    kpiCols: 4,
  }
  const body = loading
    ? loadingBody({ split, contentW, touch })
    : split
      ? splitBody(args)
      : columnBody(args)
  const content = `<div class="col" style="gap:16px;overflow:hidden">${banner}${body}${FIT_END}</div>`
  let html = withRole(role, () =>
    desktop({ w, h, touch, active: '/stats', crumb: ['Гроші', 'Статистика'], content, overlay }),
  )
  // Content cap: beyond 1440 the 1280 px column is centred, not left-pinned (R1-20).
  html = html.replace('max-width:1280px', 'max-width:1280px;width:100%;margin:0 auto')
  return html
}

/** Tablet frame (640–1023): rail + one scrolling pane. */
export function tabletFrame(w, h, opts = {}) {
  const { role = 'ADMIN', loading = false, banner = '', overlay = '' } = opts
  const contentW = w - 80 - 40
  const args = {
    contentW,
    touch: true,
    role,
    partners: opts.partners ?? PARTNERS,
    summary: opts.summary ?? 'ok',
    company: opts.company ?? 'ok',
    compliance: opts.compliance ?? {},
    chart: opts.chart ?? {},
    stale: opts.stale,
    kpiCols: 2,
  }
  const body = loading ? loadingBody({ split: false, contentW, touch: true }) : columnBody(args)
  const pane = `<section aria-label="Статистика" class="col" style="flex:1;min-width:0;overflow:hidden"><div class="row" style="height:56px;padding:0 8px 0 20px;flex:none"><h1 class="grow t-title" style="margin:0">Статистика</h1><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>${banner}<div class="col" style="padding:4px 20px 24px;gap:16px">${body}${FIT_END}</div></section>`
  return withRole(role, () => tablet({ w, h, active: '/stats', list: pane, overlay }))
}

export const offline = offlineStrip
export { srH2, MONTHS, seriesMoney, S, KPIS }
