// Finance list (Task 1.2), council round 2 (P5): measures the swipe tile label contrast (WCAG 2.2
// SC 1.4.3, 4.5:1 for 12 px text) from the colours the frames actually use.
// Usage: node contrast.mjs   (render.mjs runs swipeContrast() before every render and stops below 4.5)
// OKLCH -> linear sRGB per CSS Color 4 (Björn Ottosson's OKLab matrices), clipped to the sRGB gamut;
// relative luminance and the ratio per WCAG 2.x. Reproduces the foundation's 3.58:1 for
// `--destructive` on #fff, which is the check that the conversion is right.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TILE, TILE_BASE } from './roles.mjs'

const BASE = readFileSync(
  fileURLToPath(new URL('../../../_foundation/assets/src/base.mjs', import.meta.url)),
  'utf8',
)
const token = (name) => {
  const m = BASE.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!m) throw new Error(`token not found in base.mjs: ${name}`)
  return m[1].trim()
}
const resolve = (v) => {
  const t = v.trim().match(/^var\((--[\w-]+)\)$/)
  return t ? resolve(token(t[1])) : v.trim()
}

function linear(color) {
  const c = resolve(color)
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join('') : c.slice(1)
    return [0, 2, 4].map((i) => {
      const s = parseInt(hex.slice(i, i + 2), 16) / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
  }
  const m = c.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/)
  if (!m) throw new Error(`unsupported colour: ${color} -> ${c}`)
  const [L, C, H] = m.slice(1).map(Number)
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)))
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
export const ratio = (fg, bg) => {
  const [hi, lo] = [lum(linear(fg)), lum(linear(bg))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const pair = (style) => ({
  bg: style.match(/background:([^;]+)/)[1],
  fg: style.match(/(?:^|;)color:([^;]+)/)[1],
})

/** Every swipe tile of this screen: before (foundation `--destructive`) and after (this screen's override). */
export function swipeContrast() {
  const rows = Object.entries(TILE).map(([tone, style]) => {
    const { fg, bg } = pair(style)
    return { tone, fg, bg, ratio: Math.round(ratio(fg, bg) * 100) / 100 }
  })
  const base = pair(TILE_BASE.del)
  const before = Math.round(ratio(base.fg, base.bg) * 100) / 100
  const low = rows.filter((r) => r.ratio < 4.5)
  if (low.length) throw new Error(`swipe label below 4.5:1: ${JSON.stringify(low)}`)
  return { before, rows }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { before, rows } = swipeContrast()
  console.log(`«Видалити» tile, foundation --destructive on #fff: ${before}:1 (before)`)
  for (const r of rows) console.log(`${r.tone.padEnd(8)} ${r.fg} on ${r.bg}: ${r.ratio}:1`)
}
