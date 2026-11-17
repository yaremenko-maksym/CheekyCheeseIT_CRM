// Stats screen: the monthly plot, readouts, stepper and month table (all classes).
import { icon } from '../../../_foundation/assets/src/base.mjs'
import { MONTHS, S, SERIES, kfmt, money, seriesMoney, srOnly, lossSwatch } from './data.mjs'

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)
}
const fmtTick = (g) => kfmt(g, false).replace(',0', '')

/** Accessible name of the plot: series, period, unit with currency, extremes; the table follows the plot. */
export function chartLabel(series, idx) {
  const name = SERIES.find((s) => s[0] === series)[1]
  const v = idx.map((i) => S[series][i])
  const mi = v.indexOf(Math.max(...v))
  const neg = v.map((x, i) => [x, i]).filter(([x]) => x < 0)
  return `${name} за ${idx.length} міс., тис. USD: найбільше — ${MONTHS[idx[mi]].full.toLowerCase()}, ${kfmt(v[mi], series === 'profit')}${neg.length ? `; збиток — ${neg.map(([x, i]) => `${MONTHS[idx[i]].full.toLowerCase()}, ${kfmt(x)}`).join('; ')}` : ''}. Ті самі місяці є в таблиці нижче.`
}

/**
 * Bars on a band grid. Fit mode when every band is ≥ 24 px; otherwise strip mode (28 px bands, the
 * plot scrolls, newest month at the right edge). Value labels only when a band is ≥ 34 px.
 */
export function plot({
  W,
  H,
  series,
  idx,
  sel,
  axisW = 0,
  ls = 12,
  dim = false,
  line = false,
  forceVals = null,
  label,
}) {
  const vals = idx.map((i) => S[series][i])
  const n = vals.length
  const avail = W - axisW
  const fitBand = avail / n
  const strip = fitBand < 24
  const band = strip ? 28 : fitBand
  const total = band * n
  const off = strip ? total - avail : 0
  const showVals = forceVals ?? (!strip && band >= 34)
  const hiV = Math.max(...vals, 0)
  const loV = Math.min(...vals, 0)
  const step = niceStep((hiV - loV) / 3 || 1)
  const hi = Math.ceil(hiV / step - 1e-9) * step
  const lo = Math.floor(loV / step + 1e-9) * step
  const top = showVals ? 22 : 14
  const bottom = H - 22
  const y = (v) => top + ((hi - v) / (hi - lo || 1)) * (bottom - top)
  const ticks = []
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100)
  const grid = ticks
    .map(
      (g) =>
        `<line x1="${axisW}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--chart-grid)" ${g ? 'stroke-dasharray="2 4"' : ''}/>${axisW ? `<text x="${axisW - 6}" y="${y(g) + 4}" text-anchor="end" font-size="${ls}" fill="var(--muted-fg)" style="font-variant-numeric:tabular-nums">${fmtTick(g)}</text>` : ''}`,
    )
    .join('')
  const k = Math.max(1, Math.ceil(40 / band))
  const bars = vals
    .map((v, i) => {
      const x = i * band + band * 0.2
      const w = band * 0.6
      const y0 = y(0)
      const y1 = y(v)
      const neg = v < 0
      const on = i === sel
      const lbl = showVals
        ? `<text x="${x + w / 2}" y="${neg ? y1 + 14 : y1 - 5}" text-anchor="middle" font-size="${ls}" font-weight="600" fill="var(--fg)" style="font-variant-numeric:tabular-nums">${kfmt(v, series === 'profit')}</text>`
        : ''
      const m = MONTHS[idx[i]]
      const selOff = sel != null && k > 1 && sel % k !== (n - 1) % k
      const tick = (i % k === (n - 1) % k && !(selOff && Math.abs(i - sel) === 1)) || i === sel
      const xl = tick
        ? `<text x="${i * band + band / 2}" y="${H - 6}" text-anchor="middle" font-size="${ls}" font-weight="${on ? 650 : 400}" fill="${on ? 'var(--fg)' : 'var(--muted-fg)'}">${m.short}${m.short === 'січ' && n > 6 ? ` ’${m.yy}` : ''}</text>`
        : ''
      const aria = `${m.full}: ${kfmt(v, series === 'profit')} тис. USD`
      return `<g role="button" tabindex="${on ? 0 : -1}" aria-label="${aria}" aria-pressed="${on}"><rect x="${i * band}" y="0" width="${band}" height="${H}" fill="transparent"/><g opacity="${dim && !on ? 0.5 : 1}"><rect x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="3" fill="${neg ? 'url(#hatch)' : 'var(--chart-1)'}" ${on && !line ? 'stroke="var(--fg)" stroke-width="2"' : neg ? 'stroke="var(--chart-1)" stroke-width="1.2"' : ''}/></g>${lbl}</g>${xl}`
    })
    .join('')
  const cx = sel * band + band / 2
  const mark =
    sel == null
      ? ''
      : line
        ? `<line x1="${cx}" x2="${cx}" y1="6" y2="${bottom}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="3 3"/><circle cx="${cx}" cy="5" r="4" fill="var(--fg)"/>`
        : ''
  const inner = strip
    ? `<svg x="${axisW}" y="0" width="${avail}" height="${H}" viewBox="${off} 0 ${avail} ${H}" overflow="hidden">${bars}${mark}</svg><rect x="${axisW}" y="0" width="18" height="${H - 22}" fill="url(#fade)"/>`
    : `<g transform="translate(${axisW},0)">${bars}${mark}</g>`
  const svg = `<svg width="${W}" height="${H}" role="group" aria-label="${label}" style="display:block;overflow:visible;touch-action:pan-y"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="oklch(0.84 0.183 85.3 / 0.12)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-1)" stroke-width="1.4"/></pattern><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="oklch(0.12 0 0)"/><stop offset="1" stop-color="oklch(0.12 0 0 / 0)"/></linearGradient></defs>${grid}${inner}</svg>`
  return { svg, band, strip, showVals, hasLoss: vals.some((v) => v < 0) }
}

/** Caption row under the plot: unit, loss legend, scroll hint. */
export const plotCaption = ({ strip, hasLoss }) =>
  `<div class="row t-cap muted" style="gap:12px;margin-top:6px;flex-wrap:wrap"><span>тис. USD</span>${hasLoss ? `<span class="row" style="gap:5px">${lossSwatch}збиток</span>` : ''}${strip ? `<span class="row" style="gap:4px">${icon('chevrons-left', { size: 13 })}Гортайте, щоб побачити раніші місяці</span>` : ''}</div>`

export const stepBtn = (dir, disabled, size = 44) =>
  `<span class="iconbtn" role="button" aria-label="${dir < 0 ? 'Попередній місяць' : 'Наступний місяць'}" aria-disabled="${disabled}" style="width:${size}px;height:${size}px;background:var(--surface);border-radius:${size / 2}px;${disabled ? 'opacity:0.4' : ''}">${icon(dir < 0 ? 'chevron-left' : 'chevron-right', { size: 20 })}</span>`

/** Phone readout: month, value, «›» (opens the month sheet) and the ‹ › stepper. */
export function phoneReadout({ series, i, pos, n, narrow = false }) {
  const v = S[series][i]
  return `<div class="row" style="gap:4px;margin-top:10px"><span role="button" aria-haspopup="dialog" aria-live="polite" class="grow col" style="min-height:48px;justify-content:center"><span class="t-foot muted">${MONTHS[i].full}</span><span class="row" style="gap:4px"><span class="num" style="font-size:${narrow ? 20 : 22}px;line-height:28px;font-weight:650;white-space:nowrap;${v < 0 ? 'color:var(--destructive)' : ''}">${seriesMoney(series, v)}</span><span class="muted">${icon('chevron-right', { size: 18 })}</span></span></span>${stepBtn(-1, pos === 0)}${stepBtn(1, pos === n - 1)}</div>`
}

/** Docked readout (tablet, desktop): stepper + month on the left, the four values on the right; the plotted series is bold. */
export function dockedReadout({ series, i, pos, n, touch, W }) {
  const sz = touch ? 44 : 36
  const cols = W - (touch ? 250 : 210) >= 4 * 112 ? 4 : 2
  const cells = SERIES.slice(1)
    .concat([SERIES[0]])
    .map(([k, t]) => {
      const v = S[k][i]
      return `<div class="col" style="gap:1px;min-width:0"><span class="t-cap ${k === series ? '' : 'muted'}" style="${k === series ? 'font-weight:650' : ''}">${t}</span><span class="num trunc" style="font-size:14px;line-height:20px;font-weight:${k === series ? 650 : 500};${v < 0 ? 'color:var(--destructive)' : ''}">${seriesMoney(k, v)}</span></div>`
    })
    .join('')
  const raised = (h) => h.replace('background:var(--surface)', 'background:var(--raised)')
  return `<div class="row" aria-live="polite" style="gap:12px;padding:8px 12px;border-radius:var(--r-lg);background:var(--surface);border:1px solid var(--border)"><div class="row" style="gap:4px;flex:none">${raised(stepBtn(-1, pos === 0, sz))}<span class="t-foot" style="font-weight:650;min-width:104px;text-align:center">${MONTHS[i].full}</span>${raised(stepBtn(1, pos === n - 1, sz))}</div><div class="grow" style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:4px 12px">${cells}</div></div>`
}

/** The real <table> equivalent of the plot. `sr` hides it visually (phone); rows link to the finance list (M1). */
export function monthTable({ idx, sel, series, touch, cap = 12, sr = false }) {
  const rowH = touch ? 52 : 40
  const order = [...idx].reverse()
  const cols = SERIES.slice(1).concat([SERIES[0]])
  const rows = order
    .map((i) => {
      const on = i === idx[sel]
      return `<tr role="link" aria-label="Транзакції за ${MONTHS[i].name}" style="height:${rowH}px;border-top:1px solid var(--separator);${on ? 'background:var(--raised)' : ''}"><th scope="row" style="text-align:left;font-weight:${on ? 650 : 400};padding:0 12px 0 ${on ? 10 : 12}px;${on ? 'box-shadow:inset 2px 0 0 var(--primary)' : ''};white-space:nowrap">${MONTHS[i].full}</th>${cols
        .map(
          ([k]) =>
            `<td class="num" style="text-align:right;padding:0 0 0 12px;white-space:nowrap;${k === series ? 'font-weight:650;color:var(--fg)' : 'color:var(--muted-fg)'};${S[k][i] < 0 ? 'color:var(--destructive)' : ''}">${seriesMoney(k, S[k][i])}</td>`,
        )
        .join(
          '',
        )}<td style="width:${touch ? 44 : 28}px;text-align:center;color:oklch(0.5 0 0)">${icon('chevron-right', { size: 15 })}</td></tr>`
    })
    .join('')
  const shown = Math.min(order.length, cap)
  const more = order.length > cap
  const head = `<thead><tr style="height:${touch ? 44 : 36}px;color:var(--muted-fg);font-size:12px;font-weight:600"><th scope="col" style="text-align:left;padding-left:12px">Місяць</th>${cols.map(([k, t]) => `<th scope="col" style="text-align:right;padding-left:12px;${k === series ? 'color:var(--fg)' : ''}">${t}</th>`).join('')}<th scope="col" style="width:${touch ? 44 : 28}px"><span style="${srOnly}">Транзакції</span></th></tr></thead>`
  const table = `<table style="width:100%;border-collapse:collapse;font-size:13px"><caption style="${srOnly}">Ті самі місяці, що й на графіку</caption>${head}<tbody>${rows}</tbody></table>`
  if (sr) return `<div style="${srOnly}">${table}</div>`
  return `<div style="margin-top:14px"><div class="row t-foot muted" style="justify-content:space-between;padding:0 12px 6px"><span>Ті самі місяці, що й на графіку</span>${more ? `<span class="num">Показано ${shown} з ${order.length}</span>` : ''}</div><div style="position:relative;max-height:${shown * rowH + (touch ? 44 : 36)}px;overflow:hidden">${table}${more ? '<div style="position:absolute;left:0;right:0;bottom:0;height:28px;background:linear-gradient(to top,var(--card),transparent)"></div>' : ''}</div></div>`
}

export const noMoney = money // re-export keeps lint quiet about the shared import
