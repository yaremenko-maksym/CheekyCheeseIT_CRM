// Foundation council r1: measures the frames in a real browser instead of by eye.
// Usage: node measure.mjs <shell|primitives> [frame-name-filter]   (same env as render.mjs: PLAYWRIGHT_MODULE, CHROMIUM_PATH)
// Prints the offenders per frame, then one count line per check. Exit 1 when any check has an offender.
//
// Checks:
//   overflow — the page is wider than the viewport (nothing may scroll sideways; 320 is the hard case)
//   clip     — text cut by overflow:hidden WITHOUT an ellipsis (an ellipsis is a drawn, specified truncation)
//   pct      — a percentage («62%») cut by an ellipsis (F0-32: a percentage never truncates)
//   target   — under a coarse pointer, an interactive element whose box is under 44 × 44
//   input    — under a coarse pointer, an input / textarea / input-looking control with text under 16 px
// Coarse = the frame draws a touch device (`.touch`, every phone and tablet frame) or its name is in COARSE.
// Exempt: drawn OS chrome (`.status`, `.kbd`, `.kbar`, `.homebar`: iOS's own, not ours), `[aria-hidden="true"]`
// subtrees, annotation captions (`[data-note]`), and elements that declare an extended hit area
// (`data-hit="44"`: the visual is smaller, the hit box is 44, as the spec says for text buttons in a header).
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const PW =
  process.env.PLAYWRIGHT_MODULE ??
  join(
    dirname(
      createRequire(
        createRequire(join(here, '../../../../../../apps/e2e/package.json')).resolve(
          '@playwright/test/package.json',
        ),
      ).resolve('playwright/package.json'),
    ),
    'index.mjs',
  )
const { chromium } = await import(pathToFileURL(PW).href)
const [set, filter] = process.argv.slice(2)
const mod = await import(pathToFileURL(join(here, `${set}.mjs`)).href)
// Desktop-width frames drawn under a coarse pointer (iPad landscape). Everything else at ≥ 1024 is fine.
const COARSE = new Set(['shell-touch-1180'])
// Diagrams of scaled-down screens, not UI at 1:1: the target and input checks do not apply.
const DIAGRAM = new Set(['transition-storyboard'])

function probe(coarse) {
  const OS = '.status,.kbd,.kbar,.homebar,[aria-hidden="true"],[data-note]'
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0
    )
  }
  const name = (el) =>
    `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36)}"`
  const out = { overflow: [], clip: [], pct: [], target: [], input: [] }
  const se = document.scrollingElement
  if (se.scrollWidth > innerWidth + 1) out.overflow.push(`page ${se.scrollWidth} > ${innerWidth}`)
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(OS) || !vis(el)) continue
    const cs = getComputedStyle(el)
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    // clientWidth ≤ 1 = a visually hidden (sr-only) node: not drawn, not clipped.
    if (
      own &&
      el.clientWidth > 1 &&
      el.scrollWidth > el.clientWidth + 1 &&
      /hidden|clip/.test(cs.overflowX)
    ) {
      if (cs.textOverflow === 'ellipsis') {
        if (/\d+\s?%/.test(el.textContent)) out.pct.push(name(el))
      } else out.clip.push(`${name(el)} ${el.scrollWidth}>${el.clientWidth}`)
    }
  }
  if (coarse) {
    const I =
      'button,a[href],input,select,textarea,summary,[role=button],[role=option],[role=tab],[role=menuitem],[role=switch],[role=radio],[role=checkbox],[role=link]'
    const seen = new Set()
    for (const el of document.querySelectorAll(I)) {
      if (el.closest(OS) || !vis(el) || el.getAttribute('data-hit') === '44') continue
      // A control nested in another counted control is part of its hit area (a segment's inner pill).
      if (el.parentElement?.closest(I) && seen.has(el.parentElement.closest(I))) continue
      seen.add(el)
      const r = el.getBoundingClientRect()
      if (Math.round(r.width) < 44 || Math.round(r.height) < 44)
        out.target.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`)
    }
    for (const el of document.querySelectorAll('input,textarea,.input')) {
      if (el.closest(OS) || !vis(el)) continue
      const fs = parseFloat(getComputedStyle(el).fontSize)
      const kid = el.querySelector('span')
      const f = kid ? Math.min(fs, parseFloat(getComputedStyle(kid).fontSize)) : fs
      if (f < 16) out.input.push(`${name(el)} ${f}px`)
    }
  }
  return out
}

const frames = mod.frames().filter((f) => !filter || f.name.includes(filter))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const totals = { overflow: 0, clip: 0, pct: 0, target: 0, input: 0 }
for (const f of frames) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } })
  await page.setContent(f.html, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const coarse = !DIAGRAM.has(f.name) && (COARSE.has(f.name) || (await page.$('.touch')) !== null)
  const r = await page.evaluate(probe, coarse)
  const lines = Object.entries(r).flatMap(([k, v]) => v.map((x) => `  ${k.padEnd(8)} ${x}`))
  for (const [k, v] of Object.entries(r)) totals[k] += v.length
  if (lines.length) console.log(`${f.name}${coarse ? ' (coarse)' : ''}\n${lines.join('\n')}`)
  await page.close()
}
await browser.close()
console.log(
  `measured ${frames.length} frames · ${Object.entries(totals)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')}`,
)
process.exitCode = Object.values(totals).some(Boolean) ? 1 : 0
