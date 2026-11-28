// Foundation council r1: measures the frames in a real browser instead of by eye.
// Usage: node measure.mjs <shell|primitives> [frame-name-filter]   (same env as render.mjs: PLAYWRIGHT_MODULE, CHROMIUM_PATH)
// Prints the offenders per frame, then one count line per check. Exit 1 when any check has an offender.
//
// Checks:
//   overflow — the page is wider than the viewport (nothing may scroll sideways; 320 is the hard case)
//   clip     — text cut by overflow:hidden WITHOUT an ellipsis (an ellipsis is a drawn, specified truncation)
//   pct      — a percentage («62%») cut by an ellipsis (F0-32: a percentage never truncates)
//   target   — under a coarse pointer, an interactive element whose box is under 44 × 44. r2 (R1-01): the set
//              now holds every `a`, `button`, `[role=…]`, the sidebar rows (`.srow`), section headers (`.shead`),
//              list rows (`.lrow`), table rows (`tr`) and any element a frame marks `.tgt`. A control inside a
//              row is measured too (only the old pill-in-pill nesting is skipped).
//   never    — a percentage («62%»), a time («14:20») or a signed amount cut by the box of the element that holds
//              it (an ellipsis OR a line clamp): found by the Range rects of the match, not by the element's size.
//   fab      — the «+» button covers a drawn amount (F0 FAB band, R1-04: rows never reflow for it).
//   clipy    — text cut vertically by overflow:hidden without a line clamp.
//   target+  — r3 (R2-28): a span / div that looks like a control (rounded, bordered or filled, one of a row of same-class siblings) is a target too
//   input    — under a coarse pointer, an input / textarea / input-looking control with text under 16 px
//   reach    — r5 (R4-01): a list drawn `[data-reach="N"]` must hold N `[data-dest]` rows, and every row must be
//              scrollable fully into view: inside its scroller's box, inside the viewport, above the home indicator.
//   scrim    — r5 (R4-02): every `[role=alertdialog]` has a scrim (its previous sibling) and nothing but the dialog
//              paints above that scrim inside the scrim's box (a 16 px point grid, OS chrome exempt).
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
const COARSE = new Set([
  'shell-touch-1180',
  'shell-touch-collapsed-1180',
  'datepicker-popover-touch-1180',
  'desktop-cmdk-touch-1180',
  'desktop-shortcuts-touch-1180',
])
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
  const out = {
    overflow: [],
    clip: [],
    clipy: [],
    pct: [],
    never: [],
    fab: [],
    target: [],
    input: [],
    reach: [],
    scrim: [],
  }
  for (const sc of document.querySelectorAll('[data-reach]')) {
    const rows = [...sc.querySelectorAll('[data-dest]')]
    const want = Number(sc.getAttribute('data-reach'))
    if (rows.length !== want) out.reach.push(`${rows.length} of ${want} destinations drawn`)
    const cs = getComputedStyle(sc)
    const scrolls = /auto|scroll/.test(cs.overflowY)
    const home = document.querySelector('.homebar')
    const floor = Math.min(innerHeight, home ? home.getBoundingClientRect().top : innerHeight)
    const keep = sc.scrollTop
    for (const el of rows) {
      if (scrolls) el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      const b = sc.getBoundingClientRect()
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.bottom > floor + 1 || r.top < 0)
        out.reach.push(
          `"${el.getAttribute('data-dest')}" unreachable (${Math.round(r.top)}–${Math.round(r.bottom)}, box ${Math.round(b.top)}–${Math.round(b.bottom)}, floor ${Math.round(floor)})`,
        )
    }
    sc.scrollTop = keep
  }
  for (const dlg of document.querySelectorAll('[role="alertdialog"]')) {
    const sc = dlg.previousElementSibling
    const sr = sc && sc.getBoundingClientRect()
    if (!sc || sr.width < innerWidth * 0.5) {
      out.scrim.push('alertdialog without a scrim sibling')
      continue
    }
    let bad = 0
    let first = ''
    for (let y = Math.max(0, sr.top) + 8; y < Math.min(innerHeight, sr.bottom); y += 16)
      for (let x = Math.max(0, sr.left) + 8; x < Math.min(innerWidth, sr.right); x += 16) {
        const hit = document.elementFromPoint(x, y)
        if (!hit || hit === sc || sc.contains(hit) || dlg.contains(hit) || hit.closest(OS)) continue
        bad++
        first ||= `${name(hit)} at ${Math.round(x)},${Math.round(y)}`
      }
    if (bad) out.scrim.push(`${bad} points above the alert scrim, first ${first}`)
  }
  let examined = 0
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
    if (own && el.clientHeight > 1 && /hidden|clip/.test(cs.overflowY)) {
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
      if (el.scrollHeight > el.clientHeight + 1 && !clamp)
        out.clipy.push(`${name(el)} ${el.scrollHeight}>${el.clientHeight}`)
    }
    // never-truncate tokens: a Range rect outside the holder's box means the token is cut.
    if (own && /hidden|clip/.test(cs.overflowX + cs.overflowY)) {
      const box = el.getBoundingClientRect()
      const NEVER = /[+−-]?\d[\d\s\u00a0\u202f]*,\d\d[\s\u00a0][A-Z]{3}|\d{1,3}\s?%|\d{1,2}:\d{2}/g
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue
        for (const m of n.textContent.matchAll(NEVER)) {
          const rg = document.createRange()
          rg.setStart(n, m.index)
          rg.setEnd(n, m.index + m[0].length)
          const q = rg.getBoundingClientRect()
          if (q.width && (q.right > box.right + 1 || q.bottom > box.bottom + 1))
            out.never.push(`${name(el)} cut «${m[0].trim()}»`)
        }
      }
    }
  }
  const fab = document.querySelector('.fab')
  if (fab) {
    const f = fab.getBoundingClientRect()
    for (const a of document.querySelectorAll('.content .amount')) {
      const q = a.getBoundingClientRect()
      if (vis(a) && q.right > f.left && q.left < f.right && q.bottom > f.top && q.top < f.bottom)
        out.fab.push(`${name(a)} under the FAB`)
    }
  }
  if (coarse) {
    const I0 =
      'button,a[href],input,select,textarea,summary,[role=button],[role=option],[role=tab],[role=menuitem],[role=switch],[role=radio],[role=checkbox],[role=link]'
    // r2: the rows, headers and anything marked `.tgt` count as targets too, and `a` without an href.
    const I = `${I0},a,.srow,.shead,.lrow,tbody tr,.tgt,.chip`
    const seen = new Set()
    // r3 (R2-28): a span / div that LOOKS like a control (a bordered or filled rounded box with text, one of a
    // row of siblings that share its class, no role, no button) is a target too: the 1180 filter chips were plain
    // spans and the role-based set skipped them. Status pills (`.pill`), key caps, skeletons and badges are exempt.
    const looks = (el) => {
      if (!/^(SPAN|DIV)$/.test(el.tagName) || el.getAttribute('role') || el.closest(I0))
        return false
      if (el.matches('.pill,.kbdkey,.sk,.num,.t-cap,.t-foot,.iconbtn,.btn,.dsearch,.lead,.avatar'))
        return false
      const cs = getComputedStyle(el)
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (!own || parseFloat(cs.borderTopLeftRadius) < 8) return false
      const boxed = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
      const filled = !/rgba?\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)
      if (!boxed && !filled) return false
      const r = el.getBoundingClientRect()
      if (r.height > 60 || r.width > 320) return false
      const sib = [...(el.parentElement?.children ?? [])].filter(
        (s) => s !== el && s.tagName === el.tagName && s.className === el.className,
      )
      return sib.length > 0
    }
    const extra = [...document.querySelectorAll('span,div')].filter(looks)
    for (const el of [...document.querySelectorAll(I), ...extra]) {
      if (el.closest(OS) || !vis(el) || el.getAttribute('data-hit') === '44') continue
      // A control nested in another counted control is part of its hit area (a segment's inner pill); a
      // control inside a ROW is its own target and is measured.
      const par = el.parentElement?.closest(I0)
      if (par && seen.has(par)) continue
      seen.add(el)
      examined++
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
  out.examined = examined
  return out
}

const frames = mod.frames().filter((f) => !filter || f.name.includes(filter))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const totals = {
  overflow: 0,
  clip: 0,
  clipy: 0,
  pct: 0,
  never: 0,
  fab: 0,
  target: 0,
  input: 0,
  reach: 0,
  scrim: 0,
}
let examinedAll = 0
for (const f of frames) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } })
  await page.setContent(f.html, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const coarse = !DIAGRAM.has(f.name) && (COARSE.has(f.name) || (await page.$('.touch')) !== null)
  const r = await page.evaluate(probe, coarse)
  examinedAll += r.examined
  delete r.examined
  const lines = Object.entries(r).flatMap(([k, v]) => v.map((x) => `  ${k.padEnd(8)} ${x}`))
  for (const [k, v] of Object.entries(r)) totals[k] += v.length
  if (lines.length) console.log(`${f.name}${coarse ? ' (coarse)' : ''}\n${lines.join('\n')}`)
  await page.close()
}
await browser.close()
console.log(
  `measured ${frames.length} frames · ${examinedAll} coarse targets examined · ${Object.entries(
    totals,
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ')}`,
)
process.exitCode = Object.values(totals).some(Boolean) ? 1 : 0
