// Measures the users-screen frames in a real browser instead of by eye (council R2: measured claims come from a script).
// Usage: HTML_OUT=<dir with the rendered .html files> node measure.mjs [frame-name-filter]
// (render.mjs writes the .html files into HTML_OUT). Prints one block per frame, then a summary line per check.
//
// Checks (each prints only the offenders):
//   title   — a sheet / panel title that is cut with an ellipsis or overflows its box (N10)
//   lead    — the title text comes within 8 px of the lead or trail control of its head (P1)
//   clip    — a scroll container whose content is taller than its box: in a full-height frame this is a defect (the frame
//             is meant to show the whole form); in a fixed-height frame it is the normal "this scrolls" case and is only listed
//   target  — an interactive element smaller than 44 px on a touch class (phone, tablet, desktop `touch-*`)
//   cell    — a table cell whose text is cut (column too narrow)
//   under   — an interactive or text element whose box overlaps the bottom action bar / keyboard
//   slack   — empty space above the bar in a full-height frame
//   contrast — visible text below 4.5:1 (3:1 for large text); disabled controls are exempt (R4-23)
//   nontext — a control boundary or an icon-only control below 3:1 (R4-23)
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '../../../../../..')
const PW =
  process.env.PLAYWRIGHT_MODULE ??
  join(
    dirname(
      createRequire(
        createRequire(join(REPO, 'apps/e2e/package.json')).resolve('@playwright/test/package.json'),
      ).resolve('playwright/package.json'),
    ),
    'index.mjs',
  )
const { chromium } = await import(pathToFileURL(PW).href)
const mod = await import(pathToFileURL(join(here, 'users.mjs')).href)
const htmlDir = process.env.HTML_OUT
if (!htmlDir)
  throw new Error('HTML_OUT is required: the directory render.mjs wrote the .html files to')
const [filter] = process.argv.slice(2)

const frames = mod.frames().filter((f) => !filter || f.name.includes(filter))
const isTouch = (n) => /-(320|375|768|960)$|touch/.test(n) || /-(320|375|768|960)-/.test(n)

/** Runs inside the page. Returns plain offenders; no DOM nodes leave the page. */
function probe({ touch, full }) {
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40)
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${t}"`
  }
  const out = {
    title: [],
    lead: [],
    clip: [],
    target: [],
    cell: [],
    under: [],
    slack: [],
    contrast: [],
    nontext: [],
  }
  for (const el of document.querySelectorAll('.sheethead .t, #pn-t')) {
    // lead / title overlap (P1): the text of the title never gets nearer than 8 px to the lead or the trail control
    const rg = document.createRange()
    rg.selectNodeContents(el)
    const tr = rg.getBoundingClientRect()
    const row = el.parentElement
    for (const sib of [...row.children].filter((c) => c !== el)) {
      const sr = sib.getBoundingClientRect()
      if (sr.width < 2 || sr.height < 2) continue
      const vOverlap = sr.top < tr.bottom && sr.bottom > tr.top
      const gap = sr.left < tr.left ? tr.left - sr.right : sr.left - tr.right
      if (vOverlap && gap < 8)
        out.lead.push(`${label(el)} vs ${label(sib)} gap ${Math.round(gap)}px`)
    }
    const cs = getComputedStyle(el)
    if (
      el.scrollWidth > el.clientWidth + 1 ||
      (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth)
    )
      out.title.push(`${label(el)} ${el.scrollWidth}>${el.clientWidth}`)
  }
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (
      /(hidden|auto|scroll)/.test(cs.overflowY) &&
      el.scrollHeight > el.clientHeight + 2 &&
      el.clientHeight > 80
    )
      out.clip.push(
        `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} +${el.scrollHeight - el.clientHeight}px (box ${el.clientHeight})`,
      )
  }
  if (touch) {
    for (const el of document.querySelectorAll(
      'button,a,[role=button],[role=radio],[role=slider],[role=option],.btn,.iconbtn,input',
    )) {
      if (el.closest('[aria-hidden=true]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue // sr-only
      if (r.width < 43.5 || r.height < 43.5) {
        // an inline link inside text, or a control that sits inside a larger 44 px parent target, is not a target of its own
        const p = el.parentElement?.closest('button,a,[role=button],[role=radio],.btn,.iconbtn')
        if (p) {
          const pr = p.getBoundingClientRect()
          if (pr.width >= 43.5 && pr.height >= 43.5) continue
        }
        out.target.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`)
      }
    }
  }
  for (const td of document.querySelectorAll('td')) {
    for (const el of [td, ...td.querySelectorAll('.trunc,a')]) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const idx = [...td.parentElement.children].indexOf(td)
        const head = document.querySelectorAll('thead th')[idx]?.textContent?.trim()
        out.cell.push(
          `${head || `#${idx}`}: "${(el.textContent || '').trim().slice(0, 36)}" ${el.scrollWidth}>${el.clientWidth}`,
        )
        break
      }
    }
  }
  // submitBar() has no class: it is the absolutely positioned z-index:80 strip with a top border
  const bar = [...document.querySelectorAll('div')].find((d) =>
    /position:absolute;left:0;right:0;bottom:\d+px;z-index:80/.test(d.getAttribute('style') || ''),
  )
  if (bar) {
    const top = bar.getBoundingClientRect().top
    for (const el of document.querySelectorAll(
      '.field label, .input, .t-body, .hint, [role=alert]',
    )) {
      if (bar.contains(el)) continue
      // only the sheet's own content: the list behind the scrim also runs under the bar but is not part of the form
      if (!bar.parentElement.contains(el) || bar.parentElement === document.body) continue
      const r = el.getBoundingClientRect()
      if (r.height > 0 && r.top < top && r.bottom > top + 1 && !full)
        out.under.push(`${label(el)} bottom ${Math.round(r.bottom)} > bar ${Math.round(top)}`)
    }
  }
  // slack: empty space between the last content and the bar in a full-height frame (a frame taller than its content).
  // A frame that fits exactly still shows ~105 px (sheet body bottom padding = bar + safe area + 24), so the limit is 110.
  if (full && bar) {
    const top = bar.getBoundingClientRect().top
    let max = 0
    for (const el of bar.parentElement.querySelectorAll('*')) {
      // a control box (an empty input shows its placeholder as a child span; a slider is built of <i>) counts as content
      const box = el.matches('.input, [role=slider]')
      if (bar.contains(el) || (el.children.length && !box)) continue
      const r = el.getBoundingClientRect()
      if (
        r.height > 0 &&
        r.width > 0 &&
        r.bottom <= top + 1 &&
        (box || el.textContent.trim() || el.tagName === 'svg')
      )
        max = Math.max(max, r.bottom)
    }
    if (top - max > 110)
      out.slack.push(
        `${Math.round(top - max)}px empty above the bar (content ends ${Math.round(max)}, bar ${Math.round(top)})`,
      )
  }
  // ---- contrast (R4-23): text 4.5:1 (large text 3:1); non-text 3:1 for control borders and icon-only controls ----
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const cx = cv.getContext('2d', { willReadFrequently: true })
  // canvas resolves any CSS colour (oklch, color-mix, var) to sRGB; an unparsable value stays transparent black
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = 'rgba(0,0,0,0)'
    cx.fillStyle = c
    cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]))
  const lum = (c) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => {
    const x = lum(a)
    const y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  /** Opaque colour behind `el`: ancestors' background-colors composited bottom-up (gradients / images are ignored). */
  const backdrop = (el) => {
    const chain = []
    for (let e = el; e; e = e.parentElement) chain.unshift(e)
    let bg = [0, 0, 0]
    for (const e of chain) {
      const c = rgba(getComputedStyle(e).backgroundColor)
      if (c[3] > 0) bg = over(c, bg)
    }
    return bg
  }
  const opacityOf = (el) => {
    let o = 1
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity)
    return o
  }
  const seen = new Set()
  const push = (k, s) => {
    if (!seen.has(`${k}${s}`)) {
      seen.add(`${k}${s}`)
      out[k].push(s)
    }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width >= 2 && r.height >= 2 && getComputedStyle(el).visibility !== 'hidden'
  }
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg,style,script') || el.closest('[aria-disabled=true]')) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const fg = rgba(cs.color)
    fg[3] *= opacityOf(el)
    const bg = backdrop(el)
    const r = ratio(over(fg, bg), bg)
    const fs = parseFloat(cs.fontSize)
    const large = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 700)
    const need = large ? 3 : 4.5
    if (r < need) push('contrast', `${label(el)} ${r.toFixed(2)}:1 < ${need}:1`)
  }
  for (const el of document.querySelectorAll('.input,[role=textbox]')) {
    if (el.closest('[aria-disabled=true],.rodim') || el.hasAttribute('readonly') || !visible(el))
      continue
    const cs = getComputedStyle(el)
    const parent = backdrop(el.parentElement)
    const edge =
      parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
        ? over(rgba(cs.borderTopColor), parent)
        : over(rgba(cs.backgroundColor), parent)
    const r = ratio(edge, parent)
    if (r < 3) push('nontext', `${label(el)} boundary ${r.toFixed(2)}:1 < 3:1`)
  }
  for (const el of document.querySelectorAll('button,[role=button],.iconbtn')) {
    if (el.closest('[aria-disabled=true]') || el.textContent.trim() || !visible(el)) continue
    const svg = el.querySelector('svg')
    if (!svg) continue
    const fg = rgba(getComputedStyle(svg).color)
    fg[3] *= opacityOf(svg)
    const bg = backdrop(el)
    const r = ratio(over(fg, bg), bg)
    if (r < 3) push('nontext', `${label(el)} icon ${r.toFixed(2)}:1 < 3:1`)
  }
  return out
}

const browser = await chromium.launch()
const totals = {
  title: 0,
  lead: 0,
  clip: 0,
  target: 0,
  cell: 0,
  under: 0,
  slack: 0,
  contrast: 0,
  nontext: 0,
}
let n = 0
for (const f of frames) {
  const file = join(htmlDir, `${f.name}.html`)
  if (!existsSync(file)) {
    console.log(`${f.name}: no html (render it first)`)
    continue
  }
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: 1,
  })
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const r = await page.evaluate(probe, { touch: isTouch(f.name), full: Boolean(f.full) })
  await page.close()
  n++
  const lines = []
  for (const k of Object.keys(totals)) {
    if (k === 'clip' && !f.full) continue // fixed-height frames scroll by design; only full-height frames must not clip
    for (const v of r[k]) lines.push(`  ${k}: ${v}`)
    totals[k] += k === 'clip' && !f.full ? 0 : r[k].length
  }
  console.log(`${f.name} (${f.w}×${f.h}${f.full ? ' full' : ''}): ${lines.length ? '' : 'ok'}`)
  for (const l of lines) console.log(l)
}
await browser.close()
console.log(
  `measured ${n} of ${frames.length} frames; offenders: ${Object.entries(totals)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
)
