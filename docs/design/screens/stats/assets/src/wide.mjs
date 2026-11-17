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
  CHIP,
  card,
  periodIdx,
  retry,
  srOnly,
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
  statusStrip,
  srH2,
} from './blocks.mjs'

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

/**
 * Chart card for tablet and desktop. `sel` = selected position inside the period; `hover` = hovered
 * position (fine pointer): it changes the readout and lightly highlights that bar, nothing else (M9).
 */
export function chartWide({
  W,
  series = 'profit',
  period = 0,
  sel = null,
  touch = false,
  hover = null,
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
    hover,
    label: chartLabel(series, idx),
  })
  const shown = hover ?? s
  const ro = dockedReadout({ series, i: idx[shown], pos: shown, n: len, touch, W: inner })
  return card(
    `<div style="padding:16px 20px 16px">${head}<div style="margin-top:12px">${ro}</div><div style="margin-top:12px">${p.svg}</div>${plotCaption(p)}${monthTable({ idx, sel: s, series, touch, cap })}</div>`,
  )
}

// ---------- Skeletons: the real block DOM with the ink swapped for placeholders (M5) ----------
// Same markup as the default frame, so every block keeps its exact bounds; text and icons become
// placeholder bars. The wrapper is aria-hidden; the page announces «Завантаження статистики» once.
const SKEL_CSS =
  '<style>.skel :is(span,div,h1,h2,td,th,p):not(:has(*)):not(:empty){color:transparent!important;background:linear-gradient(90deg,oklch(0.16 0 0) 0%,oklch(0.2 0 0) 50%,oklch(0.16 0 0) 100%)!important;border-radius:4px}.skel i{background:oklch(0.2 0 0)!important}.skel svg{opacity:0}.skel svg[role=group]{opacity:1}.skel svg[role=group] text{visibility:hidden}.skel svg[role=group] rect{fill:oklch(0.18 0 0)!important;stroke:none!important}.skel svg[role=group] circle,.skel svg[role=group] line[stroke-dasharray="3 3"]{display:none}</style>'
export const skel = (inner) =>
  `${SKEL_CSS}<div role="status" aria-label="Завантаження статистики" style="${srOnly}"></div><div class="skel" aria-hidden="true" style="display:contents">${inner}</div>`

// ---------- Body assembly ----------
const sectionLabel = (t, mt = 8) => `<h2 class="t-over" style="margin:${mt}px 0 8px">${t}</h2>`
const errBlock = (touch, offline = false) =>
  card(
    stateBlock({
      ic: 'cloud-alert',
      tone: 'var(--destructive)',
      role: 'alert',
      title: 'Не вдалося завантажити фінансову статистику',
      text: 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.',
      action: retry({ h: touch ? 44 : 0, sm: !touch, size: touch ? 18 : 15, disabled: offline }),
    }).replace('padding:56px 32px 0', 'padding:28px 24px 24px'),
  )

/** Progress bar in a compliance row from a 860 px content width (R2-01: drawn at the 900–1023 tablet pane). */
const BAR_FROM = 860

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
  kpiCols,
  offline,
}) {
  const fine = !touch
  const bar = contentW >= BAR_FROM
  const compl = touch
    ? `<div style="margin:0 -16px">${complianceList({ state: compliance.state ?? 'ok', expanded: compliance.expanded ?? -1, cols: 4, bar, offline })}</div>`
    : complianceDesk({
        state: compliance.state ?? 'ok',
        expanded: compliance.expanded ?? -1,
        bar,
        offline,
      })
  const companyCard = card(
    companyRow({ state: company, variant: 'row', fine, role, offline }),
    'overflow:hidden',
  )
  if (summary === 'error' || summary === 'cold')
    return `${errBlock(touch, offline)}${companyCard}${compl}`
  const tiles = `<div>${sectionLabel('Показники')}${kpiTiles(kpiCols, { fine, count: summary === 'empty' ? 4 : 8, vs: kpiCols === 4 ? 17 : 20 })}</div>`
  return `${partnerCard(partners, { pad: 20, wide: true, fine })}${chartWide({ W: contentW, touch, empty: summary === 'empty', ...chart })}${companyCard}${tiles}${compl}`
}

/** Two columns (desktop ≥ 1280): partner + company + KPIs on the left, chart on the right. */
function splitBody({ contentW, role, partners, summary, company, compliance, chart, offline }) {
  const leftW = 380
  const compl = complianceDesk({
    state: compliance.state ?? 'ok',
    expanded: compliance.expanded ?? -1,
    offline,
  })
  const companyCard = card(
    companyRow({ state: company, variant: 'row', fine: true, role, offline }),
    'overflow:hidden',
  )
  if (summary === 'error' || summary === 'cold')
    return `<div class="row" style="gap:16px;align-items:stretch"><div class="grow">${errBlock(false, offline)}</div><div style="width:${leftW}px;flex:none">${companyCard}</div></div>${compl}`
  const left = `<div class="col" style="width:${leftW}px;flex:none;gap:16px">${partnerCard(partners, { pad: 16, fine: true })}${companyCard}<div>${sectionLabel('Показники', 4)}${kpiTiles(2, { fine: true, count: summary === 'empty' ? 4 : 8, vs: 17 })}</div></div>`
  const right = `<div class="grow" style="min-width:0">${chartWide({ W: contentW - leftW - 16, empty: summary === 'empty', H: 330, cap: 8, ...chart })}</div>`
  return `<div class="row" style="gap:16px;align-items:flex-start">${left}${right}</div>${compl}`
}

// ---------- Frames ----------
const contentWidth = (w) => Math.min(w - 248 - 48, 1280 - 48)
const cold = (strip) => strip?.kind === 'cold'

/** Desktop frame (≥ 1024). touch = coarse pointer on a desktop-width screen (M12). */
export function deskFrame(w, h, opts = {}) {
  const { role = 'ADMIN', touch = false, loading = false, strip = null, overlay = '' } = opts
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
    kpiCols: 4,
    offline: cold(strip),
  }
  const inner = split ? splitBody(args) : columnBody(args)
  const stripHtml = strip ? statusStrip({ ...strip, touch, mx: 0 }) : ''
  const body = loading ? skel(inner) : `${stripHtml}${inner}`
  const content = `<div class="col" style="gap:16px;overflow:hidden">${body}${FIT_END}</div>`
  let html = withRole(role, () =>
    desktop({ w, h, touch, active: '/stats', crumb: ['Гроші', 'Статистика'], content, overlay }),
  )
  // Content cap: beyond 1440 the 1280 px column is centred, not left-pinned (R1-20).
  html = html.replace('max-width:1280px', 'max-width:1280px;width:100%;margin:0 auto')
  // The signed-in person in the sidebar chip follows the drawn role (M11); the foundation hard-codes ADMIN.
  const who = CHIP[role]
  html = html.replace(
    />ВК<\/div><div class="grow"><div style="font-size:13px;font-weight:600">Віктор Кравець<\/div><div class="t-cap muted">Адміністратор<\/div>/,
    `>${who.i}</div><div class="grow"><div style="font-size:13px;font-weight:600">${who.n}</div><div class="t-cap muted">${who.role}</div>`,
  )
  // Coarse pointer: the foundation rule «.touch .srow» is dead because the nav rows carry two class
  // attributes (the second is ignored). Merging them applies the shell's own 44 px density (M12).
  if (touch) html = html.replace(/class="row" (aria-current="page" )?class="srow"/g, 'class="row srow" $1')
  return html
}

/**
 * Tablet frame: rail + one scrolling pane. 640–899 is the foundation's single pane. 900–1023 is the same
 * pane at a wider width (the foundation would draw list + detail; this screen has no detail, M2): built
 * from the 899 px shell with the width rewritten, foundation files untouched.
 */
export function tabletFrame(w, h, opts = {}) {
  const { role = 'ADMIN', loading = false, strip = null, overlay = '' } = opts
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
    kpiCols: w >= 900 ? 4 : 2,
    offline: cold(strip),
  }
  const inner = columnBody(args)
  const body = loading ? skel(inner) : inner
  // The strip is sticky under the title row (M3): it sits outside the scrolling body.
  const stripHtml = strip ? statusStrip({ ...strip, touch: true, mx: 20 }) : ''
  const pane = `<section aria-label="Статистика" class="col" style="flex:1;min-width:0;overflow:hidden"><div class="row" style="height:56px;padding:0 8px 0 20px;flex:none"><h1 class="grow t-title" style="margin:0">Статистика</h1><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>${stripHtml}<div class="col" style="padding:4px 20px 24px;gap:16px">${body}${FIT_END}</div></section>`
  const sw = Math.min(w, 899)
  const html = withRole(role, () => tablet({ w: sw, h, active: '/stats', list: pane, overlay }))
  return sw === w ? html : html.replaceAll(`${sw}px`, `${w}px`)
}

export { srH2, MONTHS, seriesMoney, S, KPIS }
