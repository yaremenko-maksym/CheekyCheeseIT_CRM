// Foundation council r1 (F0-01): measures token contrast from the oklch values in base.mjs instead of by eye.
// Usage: node contrast.mjs   (prints every pair; exits 1 when a pair is under its floor)
// OKLCH -> linear sRGB per CSS Color 4 (Ottosson's OKLab matrices), clipped to sRGB; WCAG 2.x luminance ratio.
// Self-check: it must reproduce foundation §7 (white on --destructive 3.57-3.58, --destructive on card 5.67).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = readFileSync(fileURLToPath(new URL('./base.mjs', import.meta.url)), 'utf8')
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
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)]
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
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

// [what, fg, bg, floor]. Floors: 4.5 text, 3 non-text (SC 1.4.11). `known` rows document a value, not a gate.
const PAIRS = [
  [
    'self-check: white on --destructive (foundation: 3.57-3.58, the F0-01 defect)',
    '#fff',
    'var(--destructive)',
    0,
    'known',
  ],
  [
    'self-check: --destructive text on --card (foundation: 5.67)',
    'var(--destructive)',
    'var(--card)',
    4.5,
  ],
  [
    'white label on --destructive-solid (swipe tile, dialog «Видалити», FAB draft count)',
    '#fff',
    'var(--destructive-solid)',
    4.5,
  ],
  [
    '--destructive-solid fill against --bg (non-text boundary)',
    'var(--destructive-solid)',
    'var(--bg)',
    3,
  ],
  [
    '--destructive-solid fill against --card (non-text boundary)',
    'var(--destructive-solid)',
    'var(--card)',
    3,
  ],
  ['--destructive text on --bg', 'var(--destructive)', 'var(--bg)', 4.5],
  ['--destructive text on --surface', 'var(--destructive)', 'var(--surface)', 4.5],
  ['--destructive text on --raised', 'var(--destructive)', 'var(--raised)', 4.5],
  ['--warning text on --card', 'var(--warning)', 'var(--card)', 4.5],
  ['--info text on --card', 'var(--info)', 'var(--card)', 4.5],
  ['--positive text on --card', 'var(--positive)', 'var(--card)', 4.5],
  ['--muted-fg on --raised', 'var(--muted-fg)', 'var(--raised)', 4.5],
  ['--muted-fg on --popover', 'var(--muted-fg)', 'var(--popover)', 4.5],
  ['--placeholder on --surface', 'var(--placeholder)', 'var(--surface)', 4.5],
  ['--input-border on --card (SC 1.4.11)', 'var(--input-border)', 'var(--card)', 3],
  ['--primary-fg on --primary', 'var(--primary-fg)', 'var(--primary)', 4.5],
  ['--primary focus ring on --raised', 'var(--primary)', 'var(--raised)', 3],
  [
    '--muted-fg on --secondary (unavailable primary, F25)',
    'var(--muted-fg)',
    'var(--secondary)',
    4.5,
  ],
]

const rows = PAIRS.map(([what, fg, bg, floor, known]) => ({
  what,
  ratio: ratio(fg, bg),
  floor,
  known,
}))
let low = 0
for (const r of rows) {
  const bad = !r.known && r.ratio < r.floor
  if (bad) low++
  console.log(
    `${bad ? 'LOW ' : 'ok  '} ${r.ratio.toFixed(2)}:1  ${r.floor ? `(>= ${r.floor})` : '(info)'}  ${r.what}`,
  )
}
console.log(`contrast: ${rows.length} pairs, ${low} under floor`)
process.exitCode = low ? 1 : 0
