// Shared tokens, CSS and helpers for the Wave 0 HTML prototypes (design-gate: degraded).
// Mockup-only: the values mirror docs/design/foundation.md v2 §5; product code uses the
// semantic Tailwind tokens from apps/web/app/styles/globals.css, never these literals.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LUCIDE =
  process.env.LUCIDE_ICONS_DIR ??
  '/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/node_modules/.pnpm/lucide-react@1.52.0_ldrqq4ddkzwykih5vpyejmhynu/node_modules/lucide-react/dist/esm/icons'

const iconCache = new Map()
function iconNode(name) {
  if (iconCache.has(name)) return iconCache.get(name)
  const file = join(LUCIDE, `${name}.mjs`)
  if (!existsSync(file)) throw new Error(`lucide icon not found: ${name}`)
  const src = readFileSync(file, 'utf8')
  const alias = src.match(/export \{ default \} from '\.\/(.+)\.mjs'/)
  if (alias) return iconNode(alias[1])
  const start = src.indexOf('node: [')
  if (start < 0) throw new Error(`cannot parse lucide icon: ${name}`)
  let depth = 0
  let end = start + 6
  for (; end < src.length; end++) {
    if (src[end] === '[') depth++
    if (src[end] === ']' && --depth === 0) break
  }
  // JSON.parse, not eval: quote the bare object keys of the lucide literal.
  const literal = src.slice(start + 6, end + 1)
  const node = JSON.parse(literal.replace(/([{,]\s*)([a-zA-Z][\w-]*):/g, '$1"$2":'))
  iconCache.set(name, node)
  return node
}

export function icon(name, { size = 20, stroke = 1.75, cls = '', fill = 'none' } = {}) {
  const inner = iconNode(name)
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
}

export const CSS = `
:root{
  --bg:oklch(0.08 0 0); --card:oklch(0.12 0 0); --popover:oklch(0.13 0 0);
  --surface:oklch(0.16 0.006 85); --raised:oklch(0.19 0.012 85); --secondary:oklch(0.2 0 0);
  --fg:oklch(0.97 0 0); --muted-fg:oklch(0.64 0 0);
  --border:oklch(0.22 0.004 85); --separator:oklch(0.2 0.004 85); --input-border:oklch(0.52 0.006 85);
  --primary:oklch(0.84 0.183 85.3); --primary-fg:oklch(0.08 0 0);
  --yellow-muted:oklch(0.72 0.13 85.3); --yellow-subtle:oklch(0.22 0.04 85.3);
  --destructive:oklch(0.65 0.21 22.2); --positive:oklch(0.76 0.14 160);
  --warning:oklch(0.78 0.15 55); --info:oklch(0.74 0.11 245);
  --chart-1:oklch(0.84 0.183 85.3); --chart-2:oklch(0.7 0.14 250); --chart-3:oklch(0.75 0.12 175);
  --chart-4:oklch(0.68 0.17 40); --chart-5:oklch(0.62 0 0); --chart-grid:oklch(0.22 0 0);
  --scrim:oklch(0 0 0 / 0.6); --placeholder:oklch(0.6 0 0);
  --r-sm:6px; --r-md:8px; --r-lg:10px; --r-xl:14px; --r-sheet:20px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:'cv11'}
.num{font-variant-numeric:tabular-nums}
.ic{flex:none;display:block}
.muted{color:var(--muted-fg)}
.pos{color:var(--positive)} .neg{color:var(--destructive)}
.row{display:flex;align-items:center}
.col{display:flex;flex-direction:column}
.grow{flex:1;min-width:0}
.trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t-large{font-size:28px;line-height:34px;font-weight:700;letter-spacing:-0.02em}
.t-title{font-size:20px;line-height:26px;font-weight:600;letter-spacing:-0.01em}
.t-head{font-size:17px;line-height:22px;font-weight:600}
.t-body{font-size:16px;line-height:22px}
.t-sub{font-size:15px;line-height:20px}
.t-foot{font-size:13px;line-height:18px}
.t-cap{font-size:12px;line-height:16px}
.t-over{font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted-fg)}
/* device chrome */
.device{position:relative;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}
.status{flex:none;display:flex;align-items:flex-end;justify-content:space-between;padding:0 26px 10px 32px;font-size:15px;font-weight:600}
.status.se{height:20px;padding:0 8px;align-items:center;font-size:12px}
.status .glyphs{display:flex;gap:6px;align-items:center}
.island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:120px;height:34px;border-radius:20px;background:#000;z-index:60}
.homebar{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:134px;height:5px;border-radius:3px;background:oklch(0.97 0 0 / 0.85);z-index:80}
/* top bar */
.topbar{flex:none;display:flex;align-items:center;gap:4px;height:44px;padding:0 8px 0 16px}
.topbar .title{flex:1;text-align:center;font-size:17px;font-weight:600}
:where(button,a).btn,:where(button,a).iconbtn{appearance:none;margin:0;border:0;background:none;font:inherit;color:inherit;text-decoration:none;cursor:pointer}
.iconbtn{width:44px;height:44px;display:grid;place-items:center;border-radius:12px;color:var(--fg);position:relative;flex:none}
.iconbtn .dot{position:absolute;top:10px;right:10px;width:8px;height:8px;border-radius:4px;background:var(--primary);box-shadow:0 0 0 2px var(--bg)}
.largetitle{padding:2px 16px 8px}
.content{flex:1;min-height:0;overflow:hidden;position:relative}
/* tab bar */
.tabbar{position:absolute;left:0;right:0;bottom:0;z-index:40;background:oklch(0.1 0.002 85 / 0.94);backdrop-filter:blur(20px) saturate(1.4);border-top:1px solid var(--border)}
.tabbar .tabs{display:grid;grid-template-columns:repeat(5,1fr);height:50px}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--muted-fg);font-size:10.5px;line-height:13px;font-weight:500;letter-spacing:-0.01em;min-width:0;position:relative}
.tab span{max-width:100%;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tab.on{color:var(--fg);font-weight:650} .tab.on .ic{color:var(--primary)}
.tab .badge{position:absolute;top:3px;left:calc(50% + 6px);min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:var(--primary);color:var(--primary-fg);font-size:11px;font-weight:700;line-height:17px;text-align:center;box-shadow:0 0 0 2px oklch(0.1 0 0)}
.fab{position:absolute;right:16px;z-index:45;width:56px;height:56px;border-radius:28px;background:var(--primary);color:var(--primary-fg);display:grid;place-items:center;box-shadow:0 6px 20px oklch(0 0 0 / 0.5),0 0 0 1px oklch(0 0 0 / 0.2)}
/* narrow phones (< 360): full-bleed lists, tighter tab labels */
.narrow .group{margin:0;border-radius:0;border-left:0;border-right:0}
.narrow .tab{font-size:10px;letter-spacing:-0.02em}
.narrow .tab span{padding:0}
.narrow .lrow{padding:8px 12px;gap:10px}
.narrow .lrow .lead{width:32px;height:32px}
.narrow .amount{font-size:15px}
.narrow .sechead{padding:16px 12px 6px}
.nw-only{display:none}.narrow .nw-only{display:inline}.narrow .wide-only{display:none}
/* list */
.group{margin:0 16px;background:var(--card);border:1px solid var(--border);border-radius:var(--r-xl);overflow:hidden}
.sechead{display:flex;align-items:flex-end;justify-content:space-between;padding:20px 20px 8px}
.sechead.sticky{position:sticky;top:0;background:oklch(0.08 0 0 / 0.92);backdrop-filter:blur(12px);padding:8px 20px;z-index:5}
:where(button,a).lrow{appearance:none;margin:0;border:0;background:none;font:inherit;color:inherit;text-decoration:none;width:100%;text-align:inherit;cursor:pointer}
.lrow{display:flex;align-items:center;gap:12px;min-height:56px;padding:8px 16px;position:relative;-webkit-touch-callout:none}
.lrow.two{min-height:64px}
.lrow + .lrow::before{content:'';position:absolute;top:0;left:var(--inset,16px);right:0;height:1px;background:var(--separator)}
.lrow .lead{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--surface);color:var(--fg);flex:none}
.lrow .lead.av{border-radius:18px;background:var(--yellow-subtle);color:var(--primary);font-size:13px;font-weight:600}
.lrow .trail{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none}
.lrow .chev{color:oklch(0.45 0 0);flex:none}
.amount{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:11px;font-size:12px;font-weight:500;background:var(--surface);color:var(--fg);border:1px solid var(--border);white-space:nowrap}
.pill.y{background:var(--yellow-subtle);color:var(--primary);border-color:oklch(0.32 0.06 85)}
.pill.ok{color:var(--positive);border-color:oklch(0.35 0.06 160);background:oklch(0.2 0.03 160)}
.pill.warn{color:var(--warning);border-color:oklch(0.38 0.07 55);background:oklch(0.21 0.035 55)}
.pill.err{color:var(--destructive);border-color:oklch(0.38 0.09 22);background:oklch(0.2 0.04 22)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 18px;border-radius:12px;font-size:16px;font-weight:600;white-space:nowrap}
.btn.primary{background:var(--primary);color:var(--primary-fg)}
.btn.secondary{background:var(--secondary);color:var(--fg);border:1px solid var(--border)}
.btn.ghost{color:var(--fg)}
.btn.sm{height:32px;padding:0 12px;font-size:13px;border-radius:8px}
.btn.dis{opacity:0.45}
/* coarse pointer (phone, tablet, touch laptop): every control is a real 44 px target */
.touch .btn.sm{height:44px}
/* sheet */
.scrim{position:absolute;inset:0;background:var(--scrim);z-index:70}
.sheet{position:absolute;left:0;right:0;bottom:0;z-index:75;background:var(--popover);border-radius:var(--r-sheet) var(--r-sheet) 0 0;border-top:1px solid var(--border);display:flex;flex-direction:column;box-shadow:0 -12px 40px oklch(0 0 0 / 0.5)}
.grabber{width:36px;height:5px;border-radius:3px;background:oklch(0.4 0 0);margin:6px auto 0;flex:none}
.sheethead{display:grid;grid-template-columns:minmax(96px,1fr) minmax(0,max-content) minmax(96px,1fr);align-items:center;height:52px;padding:0 8px;flex:none}
.sheethead .t{text-align:center;font-size:17px;font-weight:600;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sheethead .a{min-width:0;white-space:nowrap;height:44px;display:flex;align-items:center;padding:0 8px;font-size:17px;color:var(--fg)}
.sheethead .a.r{justify-content:flex-end;color:var(--primary);font-weight:600}
/* field */
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:13px;font-weight:500;color:var(--muted-fg)}
.input{height:48px;border-radius:var(--r-lg);background:var(--surface);border:1px solid var(--input-border);padding:0 14px;display:flex;align-items:center;gap:8px;font-size:16px;color:var(--fg)}
.input.focus{border-color:var(--primary);box-shadow:0 0 0 3px oklch(0.84 0.183 85.3 / 0.28)}
.input.error{border-color:var(--destructive);box-shadow:0 0 0 3px oklch(0.65 0.21 22.2 / 0.22)}
.input.error.focus{box-shadow:0 0 0 3px oklch(0.65 0.21 22.2 / 0.45)}
.input.disabled{opacity:0.5;border-style:dashed}
.input .ph{color:var(--placeholder)}
.caret{display:inline-block;width:2px;height:20px;background:var(--primary);margin-left:1px;vertical-align:middle}
.hint{font-size:13px;color:var(--muted-fg);display:flex;gap:6px;align-items:flex-start}
.hint.err{color:var(--destructive)}
/* skeleton */
.sk{background:linear-gradient(90deg,oklch(0.16 0 0) 0%,oklch(0.2 0 0) 50%,oklch(0.16 0 0) 100%);background-size:200% 100%;border-radius:6px}
/* keyboard */
.kbd{position:absolute;left:0;right:0;bottom:0;z-index:90;background:oklch(0.22 0 0);padding:8px 6px 0;display:grid;gap:8px}
.kbd .krow{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.kbd .k{height:46px;border-radius:7px;background:oklch(0.36 0 0);display:grid;place-items:center;font-size:24px;font-weight:400;color:#fff}
.kbd .k.alt{background:oklch(0.28 0 0);font-size:15px}
.kbd .kbar{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;color:var(--fg);font-size:16px;position:relative}
.kbd .kbar .sys{color:oklch(0.72 0.14 250);font-weight:600}
.kbd .kbar .tag{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:600 10px/12px Inter;letter-spacing:0.04em;text-transform:uppercase;color:oklch(0.6 0 0);border:1px dashed oklch(0.45 0 0);border-radius:4px;padding:2px 6px}
/* toast */
.toast{position:absolute;left:12px;right:12px;z-index:50;display:flex;align-items:center;gap:12px;min-height:52px;padding:8px 8px 8px 16px;border-radius:14px;background:oklch(0.2 0.006 85);border:1px solid oklch(0.28 0.006 85);box-shadow:0 10px 30px oklch(0 0 0 / 0.55);font-size:15px}
/* desktop */
.kbdkey{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:5px;border:1px solid var(--border);background:var(--surface);font-size:11px;font-weight:600;color:var(--muted-fg);font-family:Inter,system-ui}
.label-note{position:absolute;z-index:100;font:600 11px/14px Inter;color:var(--primary-fg);background:var(--primary);padding:3px 7px;border-radius:5px}
/* board (annotation canvas around frames) */
.board{padding:32px;background:oklch(0.06 0 0);display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start}
.board h2{width:100%;font-size:20px;font-weight:600;letter-spacing:-0.01em}
.board .cap{font-size:13px;color:var(--muted-fg);margin-top:10px;max-width:375px;line-height:18px}
.frame{border-radius:28px;overflow:hidden;border:1px solid oklch(0.25 0 0);box-shadow:0 20px 60px oklch(0 0 0 / 0.6)}
`

export function page(body, { width, extraCss = '' } = {}) {
  return `<!doctype html><html lang="uk" class="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=${width}, initial-scale=1, viewport-fit=cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet">
<style>${CSS}${extraCss}</style></head><body>${body}</body></html>`
}

/** iPhone chrome: notch phone (375+) or iPhone SE 1st gen (320, no notch, no home indicator). */
export function phone({ w = 375, h = 812, inner, overlay = '' }) {
  const se = w <= 320
  const status = se
    ? `<div class="status se"><span>9:41</span><span class="glyphs">${icon('wifi', { size: 13 })}<span class="t-cap">100%</span></span></div>`
    : `<div class="island"></div><div class="status" style="height:54px"><span>9:41</span><span class="glyphs">${icon('signal', { size: 16, stroke: 2.2 })}${icon('wifi', { size: 16, stroke: 2.2 })}${icon('battery-full', { size: 22, stroke: 1.6 })}</span></div>`
  return `<div class="device touch${w < 360 ? ' narrow' : ''}" style="width:${w}px;height:${h}px" data-safe-top="${se ? 20 : 54}" data-safe-bottom="${se ? 0 : 34}">${status}${inner}${overlay}${se ? '' : '<div class="homebar"></div>'}</div>`
}

/** FormField: label above, 48 px input, hint or inline error below (aria-describedby in product code). */
export function field({
  label,
  value = '',
  ph = '',
  state = '',
  hint = '',
  err = '',
  lead = '',
  suffix = '',
  id = 'f',
  attrs = '',
}) {
  const shown = value || ph
  const caret = state === 'focus' ? '<span class="caret"></span>' : ''
  const msg = err
    ? `<div class="hint err" id="${id}-e">${icon('circle-alert', { size: 15 })}<span>${err}</span></div>`
    : hint
      ? `<div class="hint" id="${id}-h">${hint}</div>`
      : ''
  return `<div class="field"><label for="${id}">${label}</label>
  <div class="input ${state}" id="${id}" ${attrs} ${state.includes('error') ? 'aria-invalid="true"' : ''} ${state === 'disabled' ? 'aria-disabled="true"' : ''}>${lead}<span class="grow trunc ${value ? '' : 'ph'}">${state === 'focus' && !value ? caret + shown : shown + caret}</span>${suffix}</div>${msg}</div>`
}

export const safeBottom = (w) => (w <= 320 ? 0 : 34)

/** iOS Safari's own form-assistant bar (˄ ˅ Готово). Drawn only so the layout height is honest: the app never builds it. */
export const systemBar = (style = '') =>
  `<div class="kbar" style="background:oklch(0.24 0 0);${style}"><span class="row" style="gap:18px;color:oklch(0.72 0.14 250)">${icon('chevron-up', { size: 22 })}${icon('chevron-down', { size: 22 })}</span><span class="tag">system · iOS Safari</span><span class="sys">Готово</span></div>`

/** Segmented control: each option is a real 44 px target; the selected fill is drawn inside it. */
export const segmented = (opts, on = 0, { fit = false, size = 14 } = {}) =>
  `<div role="radiogroup" class="row" style="min-height:44px;box-sizing:border-box;border-radius:22px;background:var(--surface);border:1px solid var(--border);${fit ? 'width:fit-content' : ''}">${opts
    .map(
      (o, i) =>
        `<span role="radio" aria-checked="${i === on}" class="${fit ? '' : 'grow'}" style="height:44px;display:grid;place-items:center;padding:0 3px"><span style="height:36px;padding:0 12px;border-radius:18px;display:grid;place-items:center;font-size:${size}px;font-weight:600;white-space:nowrap;${i === on ? 'background:var(--fg);color:var(--bg)' : 'color:var(--fg)'}">${o}</span></span>`,
    )
    .join('')}</div>`

export const currencyPill = (c = 'USD') =>
  `<span class="pill" role="button" aria-label="Валюта: ${c}" style="height:44px;padding:0 14px;border-radius:22px;font-size:15px;font-weight:600">${c} ${icon('chevron-down', { size: 15 })}</span>`
