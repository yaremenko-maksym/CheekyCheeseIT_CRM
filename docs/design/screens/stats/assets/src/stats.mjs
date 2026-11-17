// Stats screen (Task 4.1) mockups. Built only from the foundation helpers and tokens; sample data is
// invented (no real names or amounts). Rendered by `node render.mjs [filter]` into ../stats/.
import { icon, page, segmented, safeBottom } from '../../../_foundation/assets/src/base.mjs'
import { tabScreen, TABBAR_H } from '../../../_foundation/assets/src/mobile.mjs'
import {
  sheet,
  closeBtn,
  offlineBanner,
  stateBlock,
} from '../../../_foundation/assets/src/mobile-overlays.mjs'
import { desktop } from '../../../_foundation/assets/src/desktop.mjs'
import { tablet } from '../../../_foundation/assets/src/tablet.mjs'

// ---------- Invented sample data (USD base; USDT pegged 1:1 server-side) ----------
const MONTHS = [
  ['груд', 'Грудень 2025'],
  ['січ', 'Січень 2026'],
  ['лют', 'Лютий 2026'],
  ['бер', 'Березень 2026'],
  ['квіт', 'Квітень 2026'],
  ['трав', 'Травень 2026'],
  ['черв', 'Червень 2026'],
  ['лип', 'Липень 2026'],
  ['серп', 'Серпень 2026'],
  ['вер', 'Вересень 2026'],
  ['жовт', 'Жовтень 2026'],
  ['лист', 'Листопад 2026'],
]
// thousands of USD
const S = {
  income: [21.4, 19.8, 23.6, 24.1, 22.9, 26.3, 25.0, 27.8, 21.2, 26.9, 29.4, 24.6],
  expenses: [4.1, 3.6, 5.2, 4.4, 4.0, 4.8, 5.6, 4.9, 6.3, 5.1, 5.0, 4.7],
  salaries: [15.2, 15.2, 15.6, 15.6, 16.0, 16.4, 15.2, 16.1, 16.3, 16.7, 16.5, 16.6],
}
S.profit = S.income.map((v, i) => Math.round((v - S.expenses[i] - S.salaries[i]) * 10) / 10)
const SERIES = [
  ['profit', 'Прибуток'],
  ['income', 'Дохід'],
  ['expenses', 'Витрати'],
  ['salaries', 'Зарплати'],
]
const PARTNERS = [
  { n: 'Віктор Кравець', i: 'ВК', b: 18420.5 },
  { n: 'Олена Шевчук', i: 'ОШ', b: 12960.0 },
]
const BALANCED = [
  { n: 'Віктор Кравець', i: 'ВК', b: 15240.0 },
  { n: 'Олена Шевчук', i: 'ОШ', b: 15240.0 },
]
const LONG = [
  { n: 'Олександра Вишневецька-Коваленко', i: 'ОВ', b: 9812.4 },
  { n: 'Віктор Кравець', i: 'ВК', b: -1204.6 },
]
const RECEIVERS = [
  { n: 'Ірина Мельник', i: 'ІМ', role: 'SENIOR', p: 4, s: 3, st: 'lag', pill: '1 без доходу' },
  { n: 'Дмитро Бондар', i: 'ДБ', role: 'SENIOR', p: 3, s: 2, st: 'pend', pill: '1 у процесі' },
  { n: 'Софія Лисенко', i: 'СЛ', role: 'SENIOR', p: 3, s: 2, st: 'lag', pill: '1 без доходу' },
  { n: 'Андрій Ткачук', i: 'АТ', role: 'ADMIN', p: 2, s: 2, st: 'ok', pill: 'Усі отримано' },
]

// ---------- Formatting (mirrors formatMoney: uk grouping, decimal comma, U+2212, CODE suffix) ----------
const nf = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (v, code = 'USD', { sign = false } = {}) =>
  `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${nf.format(Math.abs(v))} ${code}`
const kfmt = (v, sign = true) =>
  `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}`
const pct = (v) => `${v.toFixed(1).replace('.', ',')} %`

function settle(list) {
  const sorted = [...list].sort((a, b) => b.b - a.b)
  const total = sorted.reduce((s, p) => s + p.b, 0)
  const abs = sorted.reduce((s, p) => s + Math.abs(p.b), 0)
  const rich = sorted[0],
    poor = sorted[sorted.length - 1]
  const debt = sorted.length >= 2 ? Math.abs(rich.b - poor.b) / 2 : 0
  return { sorted, total, abs, rich, poor, debt, settled: debt <= 0.01 }
}

const card = (inner, style = '') =>
  `<section style="background:var(--card);border:1px solid var(--border);border-radius:var(--r-xl);${style}">${inner}</section>`
const PCOLOR = ['var(--chart-1)', 'var(--chart-2)']
const avatar = (ini, i, s = 36) =>
  `<span aria-hidden="true" style="width:${s}px;height:${s}px;border-radius:${s / 2}px;flex:none;display:grid;place-items:center;font-size:13px;font-weight:650;background:${i === 0 ? 'var(--yellow-subtle)' : 'oklch(0.24 0.05 250)'};color:${PCOLOR[i] ?? 'var(--fg)'}">${ini}</span>`
const infoBtn = (label, size = 44) =>
  `<span class="iconbtn muted" role="button" aria-label="Пояснення: ${label}" style="width:${size}px;height:${size}px;margin-right:-10px">${icon('info', { size: 18 })}</span>`

// ---------- Partner balance (the first thing on every layout) ----------
function partnerBlock(list = PARTNERS, { pad = 16, desk = false, narrow = false } = {}) {
  const st = settle(list)
  const total = `<span class="t-foot muted num">Разом ${money(st.total)}</span>`
  // < 360: «Разом» moves under the rows so the heading never wraps.
  const head = `<div class="row" style="gap:8px"><h2 class="t-over" style="margin:0">Баланс партнерів</h2><span class="grow"></span>${narrow ? '' : total}</div>`
  const answer = st.settled
    ? `<div class="row" role="status" style="gap:10px;margin-top:12px"><span style="color:var(--positive)">${icon('circle-check', { size: 26, stroke: 2 })}</span><div><div class="t-title">Баланси вирівняно</div><div class="t-foot muted">Ніхто нікому не винен</div></div></div>`
    : `<div style="margin-top:8px"><div class="t-foot muted">Для вирівнювання</div>
    <div class="t-large num">${money(st.debt, 'USDT')}</div>
    <div class="row t-foot" style="gap:6px;flex-wrap:wrap"><span>${st.rich.n}</span><span class="muted" aria-label="надсилає">${icon('arrow-right', { size: 15 })}</span><span>${st.poor.n}</span></div></div>`
  const rows = st.sorted
    .map((p, i) => {
      const share = p.b < 0 ? '—' : pct((p.b / st.abs) * 100)
      const role = st.settled
        ? ''
        : p === st.rich
          ? ' · надсилає'
          : p === st.poor
            ? ' · отримує'
            : ''
      const w = p.b < 0 ? 0 : (p.b / st.abs) * 100
      return `<div class="row" style="gap:12px;padding:8px 0;${i ? 'border-top:1px solid var(--separator)' : ''}">${avatar(p.i, i)}
      <div class="grow col" style="gap:2px"><div class="row" style="gap:8px"><span class="${desk ? '' : 't-body'} grow" style="overflow-wrap:anywhere;${desk ? 'font-size:14px' : ''}">${p.n}</span><span class="amount num ${p.b < 0 ? 'neg' : ''}" style="${p.b < 0 ? 'color:var(--destructive)' : ''}">${money(p.b)}</span></div>
      <div class="row" style="gap:8px"><span class="t-foot muted num" style="flex:none">${share}${role}</span><span class="grow" style="height:4px;border-radius:2px;background:var(--surface)"><i style="display:block;height:4px;border-radius:2px;width:${w}%;background:${PCOLOR[i] ?? 'var(--chart-3)'}"></i></span></div></div></div>`
    })
    .join('')
  return card(
    `<div style="padding:${pad - 2}px ${pad}px 4px">${head}${answer}</div><div style="padding:6px ${pad}px 6px">${rows}${narrow ? `<div class="row" style="justify-content:flex-end;padding:2px 0 6px">${total}</div>` : ''}</div>`,
    '',
  )
}

// ---------- Monthly chart ----------
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)
}
function bars({ W, H, vals, idx, sel, ls = 11, pad = 26, values = true, scrub = false, label }) {
  const hiV = Math.max(...vals, 0),
    loV = Math.min(...vals, 0)
  const step = niceStep((hiV - loV) / 3 || 1)
  const hi = Math.ceil(hiV / step) * step,
    lo = Math.floor(loV / step) * step
  const top = values ? 18 : 10,
    bottom = H - 20
  const y = (v) => top + ((hi - v) / (hi - lo || 1)) * (bottom - top)
  const ticks = []
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 10) / 10)
  const bw = (W - pad) / vals.length
  const grid = ticks
    .map(
      (g) =>
        `<line x1="${pad}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--chart-grid)" ${g ? 'stroke-dasharray="2 4"' : ''}/>${pad < 10 ? '' : `<text x="${pad - 6}" y="${y(g) + 4}" text-anchor="end" font-size="${ls}" fill="var(--muted-fg)">${kfmt(g, false).replace(',0', '')}</text>`}`,
    )
    .join('')
  const thin = vals.length > 8
  const out = vals
    .map((v, i) => {
      const x = pad + i * bw + bw * (thin ? 0.2 : 0.18),
        w = bw * (thin ? 0.6 : 0.64),
        y0 = y(0),
        y1 = y(v)
      const neg = v < 0,
        on = i === sel
      const lbl =
        values || on
          ? `<text x="${x + w / 2}" y="${neg ? y1 + 13 : y1 - 5}" text-anchor="middle" font-size="${ls}" font-weight="600" fill="var(--fg)" style="font-variant-numeric:tabular-nums">${kfmt(v)}</text>`
          : ''
      const showM = !thin || on || i % 3 === (vals.length - 1) % 3
      return `<g opacity="${on || sel == null ? 1 : 0.5}"><rect x="${x}" y="${Math.min(y0, y1)}" width="${w}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="3" fill="${neg ? 'url(#hatch)' : 'var(--chart-1)'}" ${neg ? 'stroke="var(--chart-1)" stroke-width="1.2"' : ''}/></g>${lbl}
      ${showM ? `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle" font-size="${ls}" font-weight="${on ? 650 : 400}" fill="${on ? 'var(--fg)' : 'var(--muted-fg)'}">${MONTHS[idx[i]][0]}</text>` : ''}`
    })
    .join('')
  const cx = pad + sel * bw + bw / 2
  const line = scrub
    ? `<line x1="${cx}" x2="${cx}" y1="2" y2="${bottom}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="3 3"/><circle cx="${cx}" cy="${y(vals[sel])}" r="4" fill="var(--fg)"/>`
    : ''
  return `<svg width="${W}" height="${H}" role="img" aria-label="${label}" style="display:block;overflow:visible"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="oklch(0.84 0.183 85.3 / 0.12)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-1)" stroke-width="1.4"/></pattern></defs>${grid}${out}${line}</svg>`
}

const PERIODS = ['6 міс', '12 міс', 'Усе']
function chartLabel(key, idx) {
  const name = SERIES.find((s) => s[0] === key)[1]
  const v = idx.map((i) => S[key][i])
  const max = Math.max(...v),
    mi = v.indexOf(max)
  const neg = v.map((x, i) => [x, i]).filter(([x]) => x < 0)
  return `${name} за ${idx.length} місяців, тис. USD: найбільше — ${MONTHS[idx[mi]][1].toLowerCase()}, ${kfmt(max)}${neg.length ? `; збиток — ${neg.map(([x, i]) => `${MONTHS[idx[i]][1].toLowerCase()}, ${kfmt(x)}`).join('; ')}` : ''}. Повна таблиця нижче.`
}

/** Mobile / tablet chart card: series menu + period segmented, a persistent value line, the bars. */
function chartCard({
  W,
  series = 'profit',
  period = 0,
  sel = null,
  narrow = false,
  pad = 16,
  empty = false,
}) {
  const n = period === 0 ? 6 : 12
  const idx = Array.from({ length: n }, (_, i) => 12 - n + i)
  const s = sel ?? n - 1
  const name = SERIES.find((x) => x[0] === series)[1]
  const v = S[series][idx[s]]
  const inner = W - pad * 2
  const seriesBtn = `<span class="pill" role="button" aria-haspopup="dialog" aria-label="Показник: ${name}" style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font-weight:600;flex:none">${name} ${icon('chevron-down', { size: 15 })}</span>`
  const seg = segmented(PERIODS, period, { fit: !narrow, size: 13 })
  const controls = narrow
    ? `<div class="row" style="gap:8px;margin-top:10px"><span class="grow">${seg}</span></div><div class="row" style="margin-top:8px">${seriesBtn}</div>`
    : `<div class="row" style="gap:8px;margin-top:10px;justify-content:space-between">${seg}${seriesBtn}</div>`
  // The series menu names the chart; the section heading stays for screen readers only (saves a row above the fold).
  const head = `<h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Динаміка за місяцями</h2>${controls.replace('margin-top:10px', 'margin-top:0')}`
  if (empty)
    return card(
      `<div style="padding:${pad - 2}px ${pad}px ${pad}px">${head}<div class="col" style="align-items:center;text-align:center;gap:4px;padding:28px 8px 12px"><span class="muted">${icon('chart-column', { size: 28 })}</span><div class="t-head" style="margin-top:6px">Ще немає даних за місяцями</div><div class="t-foot muted" style="max-width:260px">Графік з’явиться після першої оплаченої транзакції.</div></div></div>`,
    )
  const valueLine = `<div class="row" style="gap:4px;margin-top:10px"><span role="button" aria-haspopup="dialog" class="grow col" style="min-height:48px;justify-content:center"><span class="t-foot muted">${MONTHS[idx[s]][1]}</span><span class="row" style="gap:4px"><span class="num" style="font-size:22px;line-height:28px;font-weight:650;${v < 0 ? 'color:var(--destructive)' : ''}">${money(v * 1000, 'USD', { sign: series === 'profit' })}</span><span class="muted">${icon('chevron-right', { size: 18 })}</span></span></span>
    <span class="iconbtn" role="button" aria-label="Попередній місяць" style="background:var(--surface);border-radius:22px">${icon('chevron-left', { size: 20 })}</span><span class="iconbtn" role="button" aria-label="Наступний місяць" aria-disabled="${s === n - 1}" style="background:var(--surface);border-radius:22px;${s === n - 1 ? 'opacity:0.4' : ''}">${icon('chevron-right', { size: 20 })}</span></div>`
  const plot = bars({
    W: inner,
    H: 128,
    vals: idx.map((i) => S[series][i]),
    idx,
    sel: s,
    values: n <= 6,
    scrub: n > 6,
    // 6 months carry value labels on the bars, so the y-axis labels are dropped: every band stays >= 44 px at 320.
    pad: n > 6 ? 24 : 0,
    label: chartLabel(series, idx),
  })
  const caption = `<div class="row t-cap muted" style="gap:10px;margin-top:6px"><span>тис. USD</span>${idx.some((i) => S[series][i] < 0) ? `<span class="row" style="gap:5px"><i style="width:10px;height:10px;border-radius:2px;background:repeating-linear-gradient(45deg,var(--chart-1) 0 1.5px,transparent 1.5px 4px);outline:1px solid var(--chart-1)"></i>збиток</span>` : ''}</div>`
  return card(
    `<div style="padding:${pad - 2}px ${pad}px 12px">${head}${valueLine}<div style="margin-top:6px">${plot}</div>${caption}</div>`,
  )
}

// ---------- Company account ----------
function companyRow({ state = 'ok', desk = false } = {}) {
  if (state === 'error')
    return `<div class="lrow two" role="alert"><div class="lead" style="color:var(--destructive)">${icon('wallet', { size: 18 })}</div><div class="grow col"><div class="t-body">Рахунок компанії</div><div class="t-foot muted">Не вдалося завантажити баланс</div></div><span class="btn secondary sm">${icon('rotate-cw', { size: 16 })}Повторити</span></div>`
  const sub = state === 'nowallet' ? 'USDT · Гаманець не налаштовано' : 'USDT · TQx7…9fK2'
  return `<div class="lrow two"><div class="lead">${icon('wallet', { size: 18 })}</div><div class="grow col" style="min-width:0"><div class="t-body trunc" style="${desk ? 'font-size:14px' : ''}">Рахунок компанії</div><div class="t-foot muted trunc num">${sub}</div></div><span class="amount num">${money(6215.4, 'USDT')}</span>${infoBtn('Рахунок компанії', desk ? 28 : 44)}</div>`
}

// ---------- KPIs (all 8 of today, in today's order) ----------
const KPIS = [
  {
    t: 'Загальний дохід',
    v: money(293040),
    sub: `${icon('arrow-down-right', { size: 13 })}<span>−16,3 % vs попер. місяць</span>`,
  },
  { t: 'Витрати', v: money(57712.4) },
  { t: 'Зарплати', v: money(191380) },
  { t: 'Чистий баланс', v: money(43947.6) },
  { t: 'Дохід за останній місяць', v: money(24600), sub: 'листопад 2026' },
  { t: 'Прибуток за останній місяць', v: money(3300), sub: 'Маржа: 13,4 %' },
  { t: 'Середній дохід / міс.', v: money(24420), sub: 'за 12 місяців' },
  { t: 'Найкращий місяць', v: money(29400), sub: 'жовтень 2026' },
]
function kpiList({ count = 8 } = {}) {
  return `<div class="group">${KPIS.slice(0, count)
    .map(
      (k) =>
        `<div class="lrow two" style="gap:8px"><div class="grow col" style="gap:2px"><div class="t-sub">${k.t}</div>${k.sub ? `<div class="row t-foot muted" style="gap:4px">${k.sub}</div>` : ''}</div><span class="amount num">${k.v}</span>${infoBtn(k.t)}</div>`,
    )
    .join('')}</div>`
}
function kpiTiles(cols, { desk = true, count = 8 } = {}) {
  return `<div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px">${KPIS.slice(
    0,
    count,
  )
    .map((k) =>
      card(
        `<div style="padding:12px 14px 14px"><div class="row" style="gap:4px"><span class="t-foot muted grow">${k.t}</span><span class="iconbtn muted" role="button" aria-label="Пояснення: ${k.t}" style="width:${desk ? 28 : 44}px;height:${desk ? 28 : 44}px;margin:${desk ? '-4px -6px -4px 0' : '-12px -12px -12px 0'}">${icon('info', { size: 15 })}</span></div><div class="num" style="font-size:${desk ? 20 : 18}px;line-height:26px;font-weight:650;margin-top:4px;white-space:nowrap">${k.v}</div>${k.sub ? `<div class="row t-foot muted" style="gap:4px;margin-top:2px">${k.sub}</div>` : '<div class="t-foot" style="margin-top:2px">&nbsp;</div>'}</div>`,
      ),
    )
    .join('')}</div>`
}

// ---------- Income compliance ----------
const PILL = { ok: 'ok', pend: '', lag: 'warn' }
const PILL_IC = { ok: 'circle-check', pend: 'clock', lag: 'circle-alert' }
const statusPill = (r) =>
  `<span class="pill ${PILL[r.st]}" style="flex:none">${icon(PILL_IC[r.st], { size: 12 })}${r.pill}</span>`
const KPI4 = [
  ['Усього доходів', '9 / 12', 'покриття 75 % · листопад'],
  ['Закриті повністю', '1', 'отримувач'],
  ['Відстають', '2', 'отримувачі'],
  ['На валідації у бухгалтера', '1', 'дохід'],
]
function complianceMobile({ expanded = -1, error = false } = {}) {
  const head = `<div class="sechead"><h2 class="t-over" style="margin:0">Контроль доходів</h2><span class="t-foot muted">листопад 2026</span></div>`
  if (error)
    return `${head}<div class="group" role="alert" style="padding:16px"><div class="t-sub">Не вдалося завантажити дані контролю доходів.</div><span class="btn secondary" style="margin-top:12px">${icon('rotate-cw', { size: 18 })}Повторити</span></div>`
  const tiles = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 16px 12px">${KPI4.map(
    ([l, v, s]) =>
      card(
        `<div style="padding:10px 12px"><div class="t-foot muted" style="min-height:36px">${l}</div><div class="num" style="font-size:20px;line-height:26px;font-weight:650">${v}</div><div class="t-cap muted">${s}</div></div>`,
      ),
  ).join('')}</div>`
  const rows = RECEIVERS.map((r, i) => {
    const open = i === expanded
    return `<div class="lrow two" role="button" aria-expanded="${open}" style="--inset:64px">${avatar(r.i, 9)}<div class="grow col" style="gap:3px;min-width:0"><div class="row" style="gap:8px"><span class="t-body trunc grow">${r.n}</span><span class="t-foot num" style="flex:none">${r.s} / ${r.p}</span></div><div class="row" style="gap:6px;flex-wrap:wrap"><span class="t-foot muted">${r.role} · ${r.p} активних проєкти</span>${statusPill(r)}</div></div><span class="chev">${icon(open ? 'chevron-up' : 'chevron-down', { size: 18 })}</span></div>${
      open
        ? `<div style="padding:4px 16px 12px 64px;background:var(--surface)"><div class="t-over" style="padding:8px 0 4px">Проєкти без зарахованого доходу</div><div class="row" style="gap:8px;padding:6px 0"><div class="grow col"><span class="t-sub">Orbita CRM</span><span class="t-foot muted">Lumen Retail</span></div><span class="pill warn">Немає доходу</span></div></div>`
        : ''
    }`
  }).join('')
  const foot = `<div class="t-foot muted" style="padding:10px 20px 0">Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць.</div>`
  return `${head}${tiles}<div class="group">${rows}</div>${foot}`
}

function placeholdersMobile() {
  return `<div class="sechead"><h2 class="t-over" style="margin:0">Інші розділи</h2></div><div class="group">${[
    ['filter', 'HR — воронка співбесід'],
    ['users', 'Команда — активність'],
    ['folder-kanban', 'Проєкти — завантаженість'],
  ]
    .map(
      ([ic, t]) =>
        `<div class="lrow" aria-disabled="true"><div class="lead muted" style="border:1px dashed var(--input-border);background:transparent">${icon(ic, { size: 18 })}</div><div class="grow t-sub muted">${t}</div><span class="pill">Скоро</span></div>`,
    )
    .join('')}</div>`
}

// ---------- Phone layout (< 640) ----------
const gap = (h = 12) => `<div style="height:${h}px"></div>`
function mobileBody({
  role = 'ADMIN',
  w,
  partners = PARTNERS,
  chart = {},
  company = 'ok',
  compliance = {},
  summary = 'ok',
}) {
  const narrow = w < 360
  const m = narrow ? 12 : 16
  const pad = narrow ? 12 : 16
  const top =
    summary === 'error'
      ? `<div style="padding:0 ${m}px">${card(stateBlock({ ic: 'cloud-alert', tone: 'var(--destructive)', role: 'alert', title: 'Не вдалося завантажити фінансову статистику', text: 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів нижче — окремі дані.', action: `<span class="btn secondary">${icon('rotate-cw', { size: 18 })}Повторити</span>` }).replace('padding:56px 32px 0', 'padding:24px 16px 20px'))}</div>`
      : `<div style="padding:0 ${m}px">${partners.length ? partnerBlock(partners, { pad, narrow }) + gap() : ''}${chartCard({ W: w - 2 * m, narrow, pad, empty: summary === 'empty', ...chart })}</div>`
  const kpis =
    summary === 'error'
      ? ''
      : `<div class="sechead"><h2 class="t-over" style="margin:0">Показники</h2></div>${kpiList({ count: summary === 'empty' ? 4 : 8 })}`
  return `${top}${gap()}<div class="group">${companyRow({ state: company })}</div>${kpis}${
    compliance.empty
      ? `<div class="sechead"><h2 class="t-over" style="margin:0">Контроль доходів</h2><span class="t-foot muted">листопад 2026</span></div><div class="group" style="padding:16px"><div class="t-sub muted">Немає активних проєктів-отримувачів доходу за листопад 2026.</div></div>`
      : complianceMobile(compliance)
  }${role === 'ADMIN' ? placeholdersMobile() : ''}`
}
function stats375({ w = 375, h = 812, role = 'ADMIN', banner = '', overlay = '', ...rest } = {}) {
  return tabScreen({
    w,
    h,
    role,
    active: '/stats',
    title: 'Статистика',
    banner,
    overlay,
    body: mobileBody({ role, w, ...rest }),
  })
}

function loadingMobile(w, h) {
  const m = w < 360 ? 12 : 16
  const sk = (wd, ht, st = '') => `<div class="sk" style="height:${ht}px;width:${wd};${st}"></div>`
  const partner = card(
    `<div style="padding:14px 16px">${sk('45%', 11)}${sk('30%', 11, 'margin-top:16px')}${sk('60%', 30, 'margin-top:8px')}${[0, 1].map(() => `<div class="row" style="gap:12px;margin-top:16px"><div class="sk" style="width:36px;height:36px;border-radius:18px;flex:none"></div><div class="grow">${sk('70%', 12)}${sk('40%', 10, 'margin-top:8px')}</div></div>`).join('')}</div>`,
  )
  const chart = card(
    `<div style="padding:14px 16px">${sk('50%', 11)}${sk('100%', 44, 'margin-top:12px;border-radius:22px')}${sk('40%', 24, 'margin-top:14px')}<div class="row" style="align-items:flex-end;gap:10px;height:140px;margin-top:12px">${[50, 75, 30, 60, 90, 45].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div></div>`,
  )
  const body = `<div role="status" aria-label="Завантаження статистики" style="display:contents"><div style="padding:0 ${m}px">${partner}${gap()}${chart}</div></div>`
  return tabScreen({ w, h, role: 'ADMIN', active: '/stats', title: 'Статистика', body })
}

// Sheets (phone): series menu, month detail, KPI hint.
function seriesSheet(w, h) {
  const rows = SERIES.map(
    ([k, t], i) =>
      `<div class="lrow" role="radio" aria-checked="${i === 0}"><div class="grow t-body">${t}</div>${i === 0 ? `<span style="color:var(--primary)">${icon('check', { size: 20, stroke: 2.4 })}</span>` : ''}</div>`,
  ).join('')
  return stats375({
    w,
    h,
    overlay: sheet({
      w,
      h,
      top: h - 330 - safeBottom(w),
      title: 'Показник',
      trail: closeBtn,
      body: `<div role="radiogroup" aria-label="Показник графіка" class="group" style="margin:4px 16px 0">${rows}</div>`,
    }),
  })
}
function monthSheet(w, h, i = 11) {
  const r = [
    ['Дохід', S.income[i]],
    ['Витрати', S.expenses[i]],
    ['Зарплати', S.salaries[i]],
  ]
  const rows = r
    .map(
      ([t, v]) =>
        `<div class="lrow"><div class="grow t-body">${t}</div><span class="amount num">${money(v * 1000)}</span></div>`,
    )
    .join('')
  const p = S.profit[i]
  return stats375({
    w,
    h,
    overlay: sheet({
      w,
      h,
      top: h - 420 - safeBottom(w),
      title: MONTHS[i][1],
      trail: closeBtn,
      body: `<div class="group" style="margin:4px 16px 0">${rows}<div class="lrow"><div class="grow t-body" style="font-weight:600">Прибуток</div><span class="amount num" style="font-size:18px">${money(p * 1000, 'USD', { sign: true })}</span></div></div>
      <div class="group" style="margin:12px 16px 0"><div class="lrow" role="link"><div class="lead">${icon('receipt', { size: 18 })}</div><div class="grow t-body">Транзакції за ${MONTHS[i][1].split(' ')[0].toLowerCase()}</div>${icon('chevron-right', { size: 18, cls: 'chev' })}</div></div>`,
    }),
  })
}
function hintSheet(w, h) {
  return stats375({
    w,
    h,
    overlay: sheet({
      w,
      h,
      top: h - 250 - safeBottom(w),
      title: 'Загальний дохід',
      trail: closeBtn,
      body: `<div class="t-body" style="padding:4px 20px 0">Сума всіх оплачених надходжень та доходу сеньйорів і адмінів за весь час.</div>`,
    }),
  })
}

// ---------- Tablet (640–1023): rail + one scrolling pane, two-column grid ----------
function tabletPane({ w, role = 'ADMIN' }) {
  const colW = Math.floor((w - 80 - 40 - 16) / 2)
  return `<section aria-label="Статистика" class="col" style="flex:1;min-width:0;overflow:hidden">
  <div class="row" style="height:56px;padding:0 8px 0 20px;flex:none"><h1 class="grow t-title" style="margin:0">Статистика</h1><span class="iconbtn" aria-label="Сповіщення, 2 нові">${icon('bell', { size: 22 })}<i class="dot"></i></span></div>
  <div style="padding:4px 20px 24px">
  ${
    w < 900
      ? `<div class="col" style="gap:16px">${partnerBlock(PARTNERS)}${chartCard({ W: w - 80 - 40 })}${card(companyRow(), 'overflow:hidden')}</div>`
      : `<div class="row" style="gap:16px;align-items:flex-start"><div class="col" style="width:${colW}px;gap:16px;flex:none">${partnerBlock(PARTNERS)}${card(companyRow(), 'overflow:hidden')}</div><div class="grow">${chartCard({ W: colW, narrow: true })}</div></div>`
  }
  <div class="sechead" style="padding:24px 4px 8px"><h2 class="t-over" style="margin:0">Показники</h2></div>${kpiTiles(2, { desk: false })}
  <div style="margin:0 -16px">${complianceMobile()}${role === 'ADMIN' ? placeholdersMobile() : ''}</div></div></section>`
}

// ---------- Desktop (≥ 1024) ----------
const segDesk = (opts, on) =>
  `<div role="radiogroup" class="row" style="height:32px;border-radius:8px;background:var(--surface);border:1px solid var(--border);padding:2px">${opts.map((o, i) => `<span role="radio" aria-checked="${i === on}" style="height:26px;padding:0 10px;border-radius:6px;display:grid;place-items:center;font-size:13px;font-weight:600;${i === on ? 'background:var(--raised);color:var(--fg)' : 'color:var(--muted-fg)'}">${o}</span>`).join('')}</div>`

function chartDesk({ W, series = 'profit', period = 0, hover = null, empty = false }) {
  const n = period === 0 ? 6 : 12
  const idx = Array.from({ length: n }, (_, i) => 12 - n + i)
  const head = `<div class="row" style="gap:10px;flex-wrap:wrap"><h2 class="t-head grow" style="margin:0">Динаміка за місяцями</h2>${segDesk(
    SERIES.map((s) => s[1]),
    SERIES.findIndex((s) => s[0] === series),
  )}${segDesk(PERIODS, period)}</div>`
  if (empty)
    return card(
      `<div style="padding:16px 20px 20px">${head}<div class="col" style="align-items:center;gap:4px;padding:48px 0 36px;text-align:center"><span class="muted">${icon('chart-column', { size: 28 })}</span><div class="t-head" style="margin-top:6px">Ще немає даних за місяцями</div><div class="t-foot muted">Графік з’явиться після першої оплаченої транзакції.</div></div></div>`,
    )
  const inner = W - 40
  const H = 220
  const plot = bars({
    W: inner,
    H,
    vals: idx.map((i) => S[series][i]),
    idx,
    sel: hover,
    values: true,
    ls: 12,
    pad: 30,
    label: chartLabel(series, idx),
  })
  let tip = ''
  if (hover != null) {
    const bw = (inner - 30) / n
    const x = 20 + 30 + hover * bw + bw * 0.82 + 8
    const i = idx[hover]
    tip = `<div role="tooltip" style="position:absolute;left:${x}px;top:70px;width:196px;z-index:5;background:var(--popover);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:0 12px 32px oklch(0 0 0 / 0.5);padding:10px 12px"><div class="t-foot" style="font-weight:650">${MONTHS[i][1]}</div>${SERIES.map(([k, t]) => `<div class="row t-foot" style="gap:8px;margin-top:4px;${k === series ? 'font-weight:650' : ''}"><span class="grow ${k === series ? '' : 'muted'}">${t}</span><span class="num">${money(S[k][i] * 1000, 'USD', { sign: k === 'profit' })}</span></div>`).join('')}</div>`
  }
  const rows = [...idx]
    .reverse()
    .map(
      (i) =>
        `<tr style="height:36px;border-top:1px solid var(--separator);${hover != null && i === idx[hover] ? 'background:var(--raised)' : ''}"><td style="padding:0 12px 0 0">${MONTHS[i][1]}</td>${SERIES.slice(
          1,
        )
          .concat([SERIES[0]])
          .map(
            ([k]) =>
              `<td class="num" style="text-align:right;padding:0 0 0 16px;${k === series ? 'font-weight:650;color:var(--fg)' : 'color:var(--muted-fg)'};${k === 'profit' && S[k][i] < 0 ? 'color:var(--destructive)' : ''}">${money(S[k][i] * 1000, 'USD', { sign: k === 'profit' })}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')
  const table = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px"><caption class="t-foot muted" style="text-align:left;caption-side:top;padding-bottom:6px">Ті самі місяці, що й на графіку</caption><thead><tr style="height:32px;color:var(--muted-fg);font-size:12px;font-weight:600"><th scope="col" style="text-align:left">Місяць</th>${SERIES.slice(
    1,
  )
    .concat([SERIES[0]])
    .map(
      ([k, t]) =>
        `<th scope="col" style="text-align:right;padding-left:16px;${k === series ? 'color:var(--fg)' : ''}">${t}</th>`,
    )
    .join('')}</tr></thead><tbody>${rows}</tbody></table>`
  const caption = `<div class="row t-cap muted" style="gap:12px;margin-top:4px"><span>тис. USD</span>${idx.some((i) => S[series][i] < 0) ? `<span class="row" style="gap:5px"><i style="width:10px;height:10px;border-radius:2px;background:repeating-linear-gradient(45deg,var(--chart-1) 0 1.5px,transparent 1.5px 4px);outline:1px solid var(--chart-1)"></i>збиток</span>` : ''}</div>`
  return card(
    `<div style="padding:16px 20px 16px;position:relative">${head}<div style="margin-top:14px">${plot}</div>${caption}${tip}${table}</div>`,
  )
}

function complianceDesk({ error = false, empty = false } = {}) {
  const head = `<div class="row" style="gap:10px"><h2 class="t-head grow" style="margin:0">Контроль доходів</h2><span class="t-foot muted">листопад 2026</span></div>`
  if (error)
    return card(
      `<div style="padding:16px 20px" role="alert">${head}<div class="row" style="gap:12px;margin-top:12px"><span class="t-sub grow">Не вдалося завантажити дані контролю доходів.</span><span class="btn secondary sm">${icon('rotate-cw', { size: 15 })}Повторити</span></div></div>`,
    )
  if (empty)
    return card(
      `<div style="padding:16px 20px">${head}<div class="t-sub muted" style="margin-top:12px">Немає активних проєктів-отримувачів доходу за листопад 2026.</div></div>`,
    )
  const tiles = `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:14px">${KPI4.map(([l, v, s]) => `<div style="padding:10px 12px;border-radius:var(--r-lg);background:var(--surface)"><div class="t-foot muted">${l}</div><div class="num" style="font-size:20px;line-height:26px;font-weight:650">${v}</div><div class="t-cap muted">${s}</div></div>`).join('')}</div>`
  const rows = RECEIVERS.map(
    (r) =>
      `<div class="row" role="button" aria-expanded="false" style="gap:12px;height:52px;border-top:1px solid var(--separator)">${avatar(r.i, 9, 32)}<span class="trunc" style="width:200px;font-size:14px">${r.n}</span><span class="t-foot muted" style="width:150px">${r.role} · ${r.p} проєкти</span><span class="grow" style="height:6px;border-radius:3px;background:var(--surface)"><i style="display:block;height:6px;border-radius:3px;width:${(r.s / r.p) * 100}%;background:${r.st === 'ok' ? 'var(--positive)' : 'var(--muted-fg)'}"></i></span><span style="width:130px;display:flex;justify-content:flex-end">${statusPill(r)}</span><span class="num t-foot" style="width:44px;text-align:right">${r.s} / ${r.p}</span><span class="chev">${icon('chevron-down', { size: 16 })}</span></div>`,
  ).join('')
  return card(
    `<div style="padding:16px 20px 14px">${head}${tiles}<div style="margin-top:12px">${rows}</div><div class="t-foot muted" style="margin-top:8px">Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць.</div></div>`,
  )
}
const placeholdersDesk = () =>
  `<div><h2 class="t-over" style="margin:4px 0 8px">Інші розділи</h2><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${[
    ['filter', 'HR — воронка співбесід'],
    ['users', 'Команда — активність'],
    ['folder-kanban', 'Проєкти — завантаженість'],
  ]
    .map(
      ([ic, t]) =>
        `<div class="row muted" aria-disabled="true" style="gap:10px;height:56px;padding:0 16px;border:1px dashed var(--input-border);border-radius:var(--r-xl)">${icon(ic, { size: 18 })}<span class="grow" style="font-size:14px">${t}</span><span class="pill">Скоро</span></div>`,
    )
    .join('')}</div></div>`

function deskContent({
  w,
  role = 'ADMIN',
  partners = PARTNERS,
  hover = null,
  summary = 'ok',
  company = 'ok',
  compliance = {},
}) {
  const content = Math.min(w - 248 - 48, 1280 - 48)
  const side = w >= 1280
  const leftW = side ? 380 : Math.floor((content - 16) / 2)
  const companyCard = card(companyRow({ state: company, desk: true }), 'overflow:hidden')
  const chartW = side ? content - leftW - 16 : content
  if (summary === 'error')
    return `<div class="row" style="gap:16px;align-items:stretch">${card(stateBlock({ ic: 'cloud-alert', tone: 'var(--destructive)', role: 'alert', title: 'Не вдалося завантажити фінансову статистику', text: 'Баланс партнерів, графік і показники зараз недоступні. Рахунок компанії та контроль доходів — окремі дані.', action: `<span class="btn secondary sm">${icon('rotate-cw', { size: 15 })}Повторити</span>` }).replace('padding:56px 32px 0', 'padding:28px 24px'), 'flex:1')}<div style="width:${leftW}px;flex:none">${companyCard}</div></div>${complianceDesk(compliance)}${role === 'ADMIN' ? placeholdersDesk() : ''}`
  const partner = partners.length ? partnerBlock(partners, { desk: true }) : ''
  const top = side
    ? `<div class="row" style="gap:16px;align-items:flex-start"><div class="col" style="width:${leftW}px;flex:none;gap:16px">${partner}${companyCard}</div><div class="grow" style="min-width:0">${chartDesk({ W: chartW, hover, empty: summary === 'empty' })}</div></div>`
    : `<div class="row" style="gap:16px;align-items:flex-start"><div style="width:${leftW}px;flex:none">${partner}</div><div class="grow">${companyCard}</div></div>${chartDesk({ W: chartW, hover, empty: summary === 'empty' })}`
  return `${top}<div><h2 class="t-over" style="margin:4px 0 8px">Показники</h2>${kpiTiles(4, { count: summary === 'empty' ? 4 : 8 })}</div>${complianceDesk(compliance)}${role === 'ADMIN' ? placeholdersDesk() : ''}`
}
const deskFrame = (w, h, opts = {}) =>
  desktop({
    w,
    h,
    active: '/stats',
    crumb: ['Гроші', 'Статистика'],
    content: `<div class="col" style="gap:16px;overflow:hidden">${opts.loading ? deskLoading(w) : deskContent({ w, ...opts })}</div>`,
  })
function deskLoading(w) {
  const sk = (wd, ht, st = '') => `<div class="sk" style="height:${ht}px;width:${wd};${st}"></div>`
  return `<div role="status" aria-label="Завантаження статистики" class="col" style="gap:16px"><div class="row" style="gap:16px;align-items:flex-start"><div style="width:380px;flex:none">${card(`<div style="padding:16px">${sk('40%', 11)}${sk('55%', 30, 'margin-top:14px')}${sk('100%', 44, 'margin-top:18px')}${sk('100%', 44, 'margin-top:10px')}</div>`)}</div><div class="grow">${card(`<div style="padding:16px 20px">${sk('30%', 14)}<div class="row" style="align-items:flex-end;gap:24px;height:220px;margin-top:18px">${[50, 75, 30, 60, 90, 45].map((p) => `<div class="sk grow" style="height:${p}%;border-radius:4px"></div>`).join('')}</div></div>`)}</div></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">${card(`<div style="padding:14px">${sk('60%', 11)}${sk('80%', 22, 'margin-top:10px')}</div>`).repeat(4)}</div></div>`
}

// ---------- Frames ----------
const M = (name, w, h, body, full = false) => ({
  name,
  w,
  h,
  dpr: 2,
  full,
  html: page(body, { width: w }),
})
const D = (name, w, h, body) => ({ name, w, h, dpr: 1, full: true, html: page(body, { width: w }) })
const TALL = { 320: 2760, 375: 2480 }

export function frames() {
  return [
    // Main state: first viewport (what the owner sees on opening) and the full scroll.
    M('default-320', 320, 568, stats375({ w: 320, h: 568 })),
    M('default-375', 375, 812, stats375()),
    M('full-320', 320, TALL[320], stats375({ w: 320, h: TALL[320] })),
    M('full-375', 375, TALL[375], stats375({ h: TALL[375] })),
    M(
      'default-768',
      768,
      2180,
      tablet({ w: 768, h: 2180, active: '/stats', list: tabletPane({ w: 768 }) }),
    ),
    D('default-1024', 1024, 1640, deskFrame(1024, 1640)),
    D('default-1440', 1440, 1240, deskFrame(1440, 1240)),
    // States, 375 and 1440.
    M('loading-375', 375, 812, loadingMobile(375, 812)),
    D('loading-1440', 1440, 900, deskFrame(1440, 900, { loading: true })),
    M(
      'empty-375',
      375,
      1500,
      stats375({
        h: 1500,
        partners: BALANCED.map((p) => ({ ...p, b: 0 })),
        summary: 'empty',
        compliance: { empty: true },
      }),
    ),
    D(
      'empty-1440',
      1440,
      900,
      deskFrame(1440, 900, {
        partners: BALANCED.map((p) => ({ ...p, b: 0 })),
        summary: 'empty',
        compliance: { empty: true },
      }),
    ),
    M('error-375', 375, 1500, stats375({ h: 1500, summary: 'error' })),
    D('error-1440', 1440, 900, deskFrame(1440, 900, { summary: 'error' })),
    M(
      'partial-375',
      375,
      2000,
      stats375({ h: 2000, company: 'error', compliance: { error: true } }),
    ),
    D(
      'partial-1440',
      1440,
      1000,
      deskFrame(1440, 1000, { company: 'error', compliance: { error: true } }),
    ),
    M('offline-375', 375, 812, stats375({ banner: offlineBanner() })),
    M('balanced-375', 375, 812, stats375({ partners: BALANCED })),
    D('balanced-1440', 1440, 1240, deskFrame(1440, 1240, { partners: BALANCED })),
    M('long-375', 375, 812, stats375({ partners: LONG })),
    M('long-320', 320, 568, stats375({ w: 320, h: 568, partners: LONG })),
    // Role variant: ACCOUNTANT (same data, no «Інші розділи», ACCOUNTANT tab bar).
    M('accountant-375', 375, TALL[375] - 220, stats375({ h: TALL[375] - 220, role: 'ACCOUNTANT' })),
    D('accountant-1440', 1440, 1160, deskFrame(1440, 1160, { role: 'ACCOUNTANT' })),
    // Interaction states.
    M('scrub-12m-375', 375, 812, stats375({ chart: { period: 1, sel: 8 } })),
    M('series-sheet-375', 375, 812, seriesSheet(375, 812)),
    M('month-sheet-375', 375, 812, monthSheet(375, 812)),
    M('hint-sheet-375', 375, 812, hintSheet(375, 812)),
    M(
      'compliance-expanded-375',
      375,
      TALL[375] + 120,
      stats375({ h: TALL[375] + 120, compliance: { expanded: 0 } }),
    ),
    D('hover-1440', 1440, 900, deskFrame(1440, 900, { hover: 2 })),
  ]
}
