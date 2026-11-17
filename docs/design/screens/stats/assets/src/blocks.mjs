// Stats screen: partner card, company account, KPIs, income compliance, shared state pieces.
import { icon } from '../../../_foundation/assets/src/base.mjs'
import {
  PARTNERS,
  RECEIVERS,
  ROLE,
  PROJECTS,
  KPIS,
  PARTNER_HINT,
  COMPANY_HINT,
  PCOLOR,
  card,
  avatar,
  infoBtn,
  money,
  partnerShare,
  settle,
  plural,
  srOnly,
} from './data.mjs'

export const SHARE_NOTE = 'Частка — від суми модулів балансів'
export const STALE_AT = '14:32'

// ---------- Partner balance (exactly two rows; one row is a defensive data state) ----------
/** wide = tablet/desktop: answer on the left, rows on the right. narrow = phone < 360. */
export function partnerCard(
  list = PARTNERS,
  { pad = 16, narrow = false, wide = false, fine = false } = {},
) {
  const st = settle(list)
  const total = `<span class="t-foot muted num" style="white-space:nowrap">Разом ${money(st.total)}</span>`
  const info = infoBtn('Баланси партнерів', { fine, mr: fine ? 0 : -10 })
  const totalBelow = narrow || (!wide && !fine)
  const head = `<div class="row" style="gap:8px;min-height:${fine ? 28 : 44}px"><h2 class="t-over" style="margin:0;white-space:nowrap">Баланси партнерів</h2><span class="grow"></span>${totalBelow ? '' : total}${info}</div>`
  let answer = ''
  if (!st.pair)
    answer = `<div class="t-foot muted" style="padding:2px 0 6px">Поки що один партнер — вирівнювати нічого</div>`
  else if (st.balanced)
    answer = `<div class="row" role="status" style="gap:10px;margin-top:4px"><span style="color:var(--positive)">${icon('circle-check', { size: 26, stroke: 2 })}</span><div><div class="t-title">Баланси вирівняно</div><div class="t-foot muted">Ніхто нікому не винен</div></div></div>`
  else
    answer = `<div style="margin-top:2px"><div class="t-foot muted">Для вирівнювання</div><div class="t-large num">${money(st.even, 'USDT')}</div><div class="row t-foot" style="gap:6px;flex-wrap:wrap"><span>${st.rich.n}</span><span class="row" style="gap:6px;white-space:nowrap"><span class="muted" aria-label="надсилає">${icon('arrow-right', { size: 15 })}</span><span>${st.poor.n}</span></span></div></div>`
  const rows = st.sorted
    .map((p, i) => {
      const sh = partnerShare(p.b, st.abs)
      const role = !st.pair || st.balanced ? '' : p === st.rich ? ' · надсилає' : ' · отримує'
      const amt = `<span class="num amount" style="flex:none;${p.b < 0 ? 'color:var(--destructive)' : ''}">${money(p.b)}</span>`
      const bar = `<span class="grow" style="height:4px;border-radius:2px;background:var(--surface);min-width:24px"><i style="display:block;height:4px;border-radius:2px;width:${sh.bar}%;background:${PCOLOR[i] ?? 'var(--chart-3)'}"></i></span>`
      const shareTxt = `<span class="t-foot muted num" style="flex:none">${sh.label}${role}</span>`
      const body = narrow
        ? `<div class="grow col" style="gap:3px;min-width:0"><span class="t-body" style="overflow-wrap:anywhere">${p.n}</span><div class="row" style="gap:8px;justify-content:space-between;flex-wrap:wrap">${shareTxt}${amt}</div>${bar}</div>`
        : `<div class="grow col" style="gap:2px;min-width:0"><div class="row" style="gap:8px"><span class="t-body grow" style="overflow-wrap:anywhere;${fine ? 'font-size:14px' : ''}">${p.n}</span>${amt}</div><div class="row" style="gap:8px">${shareTxt}${bar}</div></div>`
      return `<div class="row" style="gap:12px;padding:8px 0;align-items:flex-start;${i && !wide ? 'border-top:1px solid var(--separator)' : ''}">${avatar(p.i, i)}${body}</div>`
    })
    .join('')
  const totalFoot =
    narrow || (!wide && !fine)
      ? `<div class="row" style="justify-content:flex-end;padding:2px 0 0">${total}</div>`
      : ''
  const note = `<div class="t-cap muted" style="padding:2px 0 8px">${SHARE_NOTE}</div>`
  if (wide)
    return card(
      `<div style="padding:${pad - 2}px ${pad}px 4px">${head}</div><div class="row" style="gap:28px;align-items:flex-start;padding:2px ${pad}px 0"><div style="width:44%;flex:none;padding-top:4px">${answer}</div><div class="grow" style="min-width:0">${rows}</div></div><div style="padding:0 ${pad}px">${note}</div>`,
    )
  return card(
    `<div style="padding:${pad - 2}px ${pad}px 0">${head}${answer}</div><div style="padding:6px ${pad}px 0">${rows}${totalFoot}${note}</div>`,
  )
}

// ---------- Company account ----------
/** variant: 'stack' (phone) | 'row' (tablet/desktop). state: ok | error | nowallet | stale. */
export function companyRow({ state = 'ok', variant = 'stack', fine = false, role = 'ADMIN' } = {}) {
  const retryBtn = (h = 44) =>
    `<span class="btn secondary" style="height:${h}px">${icon('rotate-cw', { size: 16 })}Повторити</span>`
  const setup =
    role === 'ADMIN'
      ? `<span class="btn secondary" style="height:${fine ? 32 : 44}px;margin-top:8px">${icon('settings', { size: 16 })}Налаштувати гаманець</span>`
      : ''
  const sub = state === 'nowallet' ? 'Гаманець не налаштовано' : 'USDT · TQx7…9fK2'
  if (state === 'error')
    return variant === 'stack'
      ? `<div class="lrow" role="alert" style="gap:12px;padding-top:12px;padding-bottom:12px;align-items:flex-start"><div class="lead" style="color:var(--destructive)">${icon('wallet', { size: 18 })}</div><div class="grow col" style="min-width:0;gap:2px"><div class="t-foot muted">Рахунок компанії</div><div class="t-body">Не вдалося завантажити баланс</div><div style="margin-top:8px">${retryBtn()}</div></div></div>`
      : `<div class="lrow two" role="alert"><div class="lead" style="color:var(--destructive)">${icon('wallet', { size: 18 })}</div><div class="grow col"><div class="t-body">Рахунок компанії</div><div class="t-foot muted">Не вдалося завантажити баланс</div></div><span class="btn secondary ${fine ? 'sm' : ''}" style="${fine ? '' : 'height:44px'}">${icon('rotate-cw', { size: 16 })}Повторити</span></div>`
  if (variant === 'stack')
    return `<div class="lrow" style="gap:12px;padding-top:12px;padding-bottom:12px;align-items:flex-start"><div class="lead">${icon('wallet', { size: 18 })}</div><div class="grow col" style="min-width:0;gap:2px"><div class="t-foot muted">Рахунок компанії</div>${state === 'nowallet' ? '' : `<div class="t-title num">${money(6215.4, 'USDT')}</div>`}<div class="t-foot muted num">${sub}</div>${state === 'nowallet' ? setup : ''}</div>${infoBtn('Рахунок компанії')}</div>`
  return `<div class="lrow two" style="align-items:center"><div class="lead">${icon('wallet', { size: 18 })}</div><div class="grow col" style="min-width:0"><div class="t-body trunc" style="${fine ? 'font-size:14px' : ''}">Рахунок компанії</div><div class="t-foot muted trunc num">${sub}</div>${state === 'nowallet' ? setup : ''}</div>${state === 'nowallet' ? '' : `<span class="amount num">${money(6215.4, 'USDT')}</span>`}${infoBtn('Рахунок компанії', { fine, mr: fine ? 0 : -10 })}</div>`
}

// ---------- KPIs ----------
export const kpiRows = (count = 8) => KPIS.slice(0, count)
const zeroKpi = (k) => ({ t: k.t, v: money(0), hint: k.hint })
export const kpiData = (count) => (count === 4 ? KPIS.slice(0, 4).map(zeroKpi) : KPIS)

export function kpiList({ count = 8 } = {}) {
  return `<div class="group">${kpiData(count)
    .map(
      (k) =>
        `<div class="lrow two" style="gap:8px"><div class="grow col" style="gap:2px"><div class="t-sub">${k.t}</div>${kpiSub(k, true)}</div><span class="amount num">${k.v}</span>${infoBtn(k.t)}</div>`,
    )
    .join('')}</div>`
}
const kpiSub = (k, list = false) => {
  const trend =
    k.trend != null
      ? `<span class="row" style="gap:4px">${icon(k.trend < 0 ? 'arrow-down-right' : 'arrow-up-right', { size: 13 })}<span>${k.trend < 0 ? '−' : '+'}${Math.abs(k.trend).toFixed(1).replace('.', ',')} % за місяць</span></span>`
      : ''
  const sub = k.sub ? `<span>${k.sub}</span>` : ''
  const inner = trend || sub
  return inner
    ? `<div class="row t-foot muted" style="gap:4px;${list ? '' : 'margin-top:2px'}">${inner}</div>`
    : list
      ? ''
      : '<div class="t-foot" style="margin-top:2px">&nbsp;</div>'
}
export function kpiTiles(cols, { fine = true, count = 8, vs = 20 } = {}) {
  const sz = fine ? 28 : 44
  return `<div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px">${kpiData(
    count,
  )
    .map((k) =>
      card(
        `<div style="padding:12px 14px 14px"><div class="row" style="gap:4px;align-items:flex-start"><span class="t-foot muted grow" style="padding-top:${fine ? 0 : 10}px">${k.t}</span><span class="iconbtn muted" role="button" aria-label="Пояснення: ${k.t}" style="width:${sz + (fine ? 16 : 0)}px;height:${sz + (fine ? 16 : 0)}px;margin:${fine ? '-10px -10px -10px 0' : '-12px -12px -12px 0'};flex:none">${icon('info', { size: 15 })}</span></div><div class="num" style="font-size:${vs}px;line-height:26px;font-weight:650;margin-top:4px;white-space:nowrap">${k.v}</div>${kpiSub(k)}</div>`,
      ),
    )
    .join('')}</div>`
}

// ---------- Income compliance ----------
const PILL = { ok: 'ok', pend: '', lag: 'warn' }
const PILL_IC = { ok: 'circle-check', pend: 'clock', lag: 'circle-alert' }
export const statusPill = (r) =>
  `<span class="pill ${PILL[r.st]}" style="flex:none">${icon(PILL_IC[r.st], { size: 12 })}${r.pill}</span>`
const sumS = RECEIVERS.reduce((a, r) => a + r.s, 0)
const sumP = RECEIVERS.reduce((a, r) => a + r.p, 0)
const nOk = RECEIVERS.filter((r) => r.st === 'ok').length
const nLag = RECEIVERS.filter((r) => r.st === 'lag').length
const nPend = RECEIVERS.filter((r) => r.st === 'pend').length
const recv = (n) =>
  plural(n, { one: 'отримувач', few: 'отримувачі', many: 'отримувачів', other: 'отримувача' })
const inc = (n) => plural(n, { one: 'дохід', few: 'доходи', many: 'доходів', other: 'доходу' })
export const CK = [
  [
    'Усього доходів',
    `${sumS} / ${sumP}`,
    `покриття ${Math.round((sumS / sumP) * 100)} % · листопад`,
  ],
  ['Закриті повністю', String(nOk), recv(nOk)],
  ['Відстають', String(nLag), recv(nLag)],
  ['На валідації у бухгалтера', String(nPend), inc(nPend)],
]
export const COMPLIANCE_FOOT =
  'Зараховується дохід у статусі «валідовано» або «виплачено» за поточний місяць.'
export const COMPLIANCE_EMPTY = 'Немає активних проєктів-отримувачів доходу за листопад 2026.'
export const COMPLIANCE_ERR = 'Не вдалося завантажити дані контролю доходів.'
const complianceHead = (card_ = false) =>
  card_
    ? `<div class="row" style="gap:10px"><h2 class="t-head grow" style="margin:0">Контроль доходів</h2><span class="t-foot muted">листопад 2026</span></div>`
    : `<div class="sechead"><h2 class="t-over" style="margin:0">Контроль доходів</h2><span class="t-foot muted">листопад 2026</span></div>`
const projectsOpen = `<div style="padding:4px 16px 12px 64px;background:var(--surface)"><div class="t-over" style="padding:8px 0 4px">Проєкти без зарахованого доходу</div><div class="row" style="gap:8px;padding:6px 0;min-height:44px"><div class="grow col"><span class="t-sub">Orbita CRM</span><span class="t-foot muted">Lumen Retail</span></div><span class="pill warn">Немає доходу</span></div></div>`

/** Phone + tablet layout: tiles then grouped receiver rows. cols = 2 (phone) | 4 (tablet). */
export function complianceList({ expanded = -1, state = 'ok', cols = 2 } = {}) {
  const head = complianceHead()
  if (state === 'error')
    return `${head}<div class="group" role="alert" style="padding:16px"><div class="t-sub">${COMPLIANCE_ERR}</div><span class="btn secondary" style="margin-top:12px;height:44px">${icon('rotate-cw', { size: 18 })}Повторити</span></div>`
  if (state === 'empty')
    return `${head}<div class="group" style="padding:16px"><div class="t-sub muted">${COMPLIANCE_EMPTY}</div></div>`
  const tiles = `<div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:10px;margin:0 16px 12px">${CK.map(
    ([l, v, s]) =>
      card(
        `<div style="padding:10px 12px"><div class="t-foot muted" style="min-height:${cols === 2 ? 36 : 18}px">${l}</div><div class="num" style="font-size:20px;line-height:26px;font-weight:650">${v}</div><div class="t-cap muted">${s}</div></div>`,
      ),
  ).join('')}</div>`
  const rows = RECEIVERS.map((r, i) => {
    const open = i === expanded
    return `<div class="lrow two" role="button" aria-expanded="${open}" style="--inset:64px">${avatar(r.i, 9)}<div class="grow col" style="gap:3px;min-width:0"><div class="row" style="gap:8px"><span class="t-body trunc grow">${r.n}</span><span class="t-foot num" style="flex:none">${r.s} / ${r.p}</span></div><div class="row" style="gap:6px;flex-wrap:wrap"><span class="t-foot muted">${ROLE[r.role]} · ${PROJECTS(r.p)}</span>${statusPill(r)}</div></div><span class="chev">${icon(open ? 'chevron-up' : 'chevron-down', { size: 18 })}</span></div>${open ? projectsOpen : ''}`
  }).join('')
  return `${head}${tiles}<div class="group">${rows}</div><div class="t-foot muted" style="padding:10px 20px 0">${COMPLIANCE_FOOT}</div>`
}

/** Desktop layout: one card, 4 tiles, receiver rows with the decorative progress bar. */
export function complianceDesk({ state = 'ok', expanded = -1 } = {}) {
  const head = complianceHead(true)
  if (state === 'error')
    return card(
      `<div style="padding:16px 20px" role="alert">${head}<div class="row" style="gap:12px;margin-top:12px"><span class="t-sub grow">${COMPLIANCE_ERR}</span><span class="btn secondary sm">${icon('rotate-cw', { size: 15 })}Повторити</span></div></div>`,
    )
  if (state === 'empty')
    return card(
      `<div style="padding:16px 20px">${head}<div class="t-sub muted" style="margin-top:12px">${COMPLIANCE_EMPTY}</div></div>`,
    )
  const tiles = `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:14px">${CK.map(([l, v, s]) => `<div style="padding:10px 12px;border-radius:var(--r-lg);background:var(--surface)"><div class="t-foot muted">${l}</div><div class="num" style="font-size:20px;line-height:26px;font-weight:650">${v}</div><div class="t-cap muted">${s}</div></div>`).join('')}</div>`
  const rows = RECEIVERS.map((r, i) => {
    const open = i === expanded
    return `<div class="row" role="button" aria-expanded="${open}" style="gap:12px;height:52px;border-top:1px solid var(--separator)">${avatar(r.i, 9, 32)}<span class="trunc" style="width:200px;font-size:14px">${r.n}</span><span class="t-foot muted trunc" style="width:230px">${ROLE[r.role]} · ${PROJECTS(r.p)}</span><span class="grow" aria-hidden="true" style="height:6px;border-radius:3px;background:var(--surface)"><i style="display:block;height:6px;border-radius:3px;width:${(r.s / r.p) * 100}%;background:${r.st === 'ok' ? 'var(--positive)' : 'var(--muted-fg)'}"></i></span><span style="width:140px;display:flex;justify-content:flex-end">${statusPill(r)}</span><span class="num t-foot" style="width:44px;text-align:right">${r.s} / ${r.p}</span><span class="chev">${icon(open ? 'chevron-up' : 'chevron-down', { size: 16 })}</span></div>${open ? `<div style="padding:4px 0 12px 56px;background:var(--surface);border-radius:var(--r-lg)"><div class="t-over" style="padding:8px 0 4px">Проєкти без зарахованого доходу</div><div class="row" style="gap:8px;padding:4px 0"><span class="t-sub">Orbita CRM</span><span class="t-foot muted">Lumen Retail</span><span class="pill warn">Немає доходу</span></div></div>` : ''}`
  }).join('')
  return card(
    `<div style="padding:16px 20px 14px">${head}${tiles}<div style="margin-top:12px">${rows}</div><div class="t-foot muted" style="margin-top:8px">${COMPLIANCE_FOOT}</div></div>`,
  )
}

// ---------- Shared state pieces ----------
/** Cached data stays on screen; the failure is one inline line (M6). */
export const staleBar = ({ touch = true, offline = false } = {}) =>
  `<div class="row" role="status" style="gap:8px;padding:${touch ? '4px 4px 4px 12px' : '4px 6px 4px 12px'};border-radius:var(--r-lg);background:var(--surface);border:1px solid var(--border);min-height:${touch ? 52 : 40}px"><span class="muted">${icon(offline ? 'wifi-off' : 'cloud-alert', { size: 16 })}</span><span class="t-foot grow">${offline ? 'Немає мережі' : 'Не вдалося оновити'} · станом на ${STALE_AT}</span><span class="btn secondary ${touch ? '' : 'sm'}" style="${touch ? 'height:44px' : ''}">${icon('rotate-cw', { size: 15 })}Повторити</span></div>`

export const hintText = { PARTNER_HINT, COMPANY_HINT }
export const srH2 = (t) => `<h2 style="${srOnly}">${t}</h2>`
