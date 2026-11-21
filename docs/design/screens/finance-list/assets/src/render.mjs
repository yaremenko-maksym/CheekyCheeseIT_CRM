// Renders the finance-list HTML prototypes to PNG (design-gate: degraded — no Claude Design export).
// Usage: node render.mjs [frame-name-filter]
// Playwright: PLAYWRIGHT_MODULE=<path to playwright(-core)/index.mjs>, else resolved through apps/e2e.
// Output: ../finance-list/<name>.png. Quantised with ImageMagick when `magick` is on PATH.
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { frames } from './finance-list.mjs'
import { stateFrames } from './states.mjs'
import { roleFrames } from './roles.mjs'
import { round1Frames, assertFixtures } from './round1.mjs'
import { swipeContrast, textContrast } from './contrast.mjs'

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
const filter = process.argv[2]
const outDir = join(here, '..', 'finance-list')
const htmlDir = process.env.HTML_OUT ?? mkdtempSync(join(tmpdir(), 'crm-finance-list-'))
mkdirSync(outDir, { recursive: true })

let magick = true
try {
  execFileSync('magick', ['-version'], { stdio: 'ignore' })
} catch {
  magick = false
}

console.log(`fixtures add up: ${assertFixtures()} records checked`)
const sc = swipeContrast()
const del = sc.rows.find((r) => r.tone === 'del').ratio
console.log(`swipe «Видалити» label: ${sc.before}:1 (foundation) -> ${del}:1 (this screen)`)
const tc = textContrast()
console.log(
  `pills and muted text: lowest ${Math.min(...tc.map((r) => r.ratio))}:1 over ${tc.length} pairs`,
)
// A later module may redraw a frame by name; the last one wins.
const all = [
  ...new Map(
    [...frames(), ...stateFrames(), ...roleFrames(), ...round1Frames()].map((f) => [f.name, f]),
  ).values(),
]
// Frame checks (P7, P10, P13), over every frame, before any render: no placeholder text; the pager
// and the match line equal the rows drawn (`data-tx`); no search icon where the page has no search.
const bad = []
for (const f of all) {
  const text = f.html.replace(/<style>[\s\S]*?<\/style>/g, '')
  if (/\bundefined\b|\bNaN\b/.test(text)) bad.push(`${f.name}: placeholder text`)
  const n = (f.html.match(/ data-tx[\s>]/g) ?? []).length
  const p = f.html.match(/data-pager="(\d+)-(\d+)"/)
  if (p && +p[2] - +p[1] + 1 !== n) bad.push(`${f.name}: pager ${p[1]}–${p[2]}, ${n} rows drawn`)
  // R3-07: the match line counts matches; the page draws at most its 50-row window of them.
  const m = f.html.match(/data-match="(\d+)"/)
  if (m && Math.min(+m[1], 50) !== n)
    bad.push(`${f.name}: «Показано ${m[1]}», ${n} rows drawn (expected ${Math.min(+m[1], 50)})`)
  if (/^(role-junior|role-drop|drop-)/.test(f.name) && f.html.includes('aria-label="Пошук"'))
    bad.push(`${f.name}: search icon on a page without search`)
}
if (bad.length) throw new Error(`frames do not add up:\n- ${bad.join('\n- ')}`)
console.log(`frames add up: ${all.length} checked`)
const list = all.filter((f) => !filter || f.name.includes(filter))
// M21: at rest the phone FAB (56 px, 16 px end inset, 8 px above the tab bar; it hides on scroll-down
// in shell v2) never covers a trailing amount. A list row under the FAB's footprint takes a trailing
// inset of the FAB width + 16 px; then every amount in the frame is measured against the FAB.
const fabRule = () => {
  const fab = [...document.querySelectorAll('.fab')].find((e) => e.offsetParent)
  if (!fab) return []
  const r = fab.getBoundingClientRect()
  for (const row of document.querySelectorAll('.lrow')) {
    const b = row.getBoundingClientRect()
    if (b.bottom > r.top - 8 && b.top < r.bottom + 8 && b.right > r.left) {
      const pad = parseFloat(getComputedStyle(row).paddingRight) || 0
      row.style.paddingRight = `${pad + r.width + 16}px`
    }
  }
  const hit = []
  for (const a of document.querySelectorAll('.amount, .lrow .num')) {
    const b = a.getBoundingClientRect()
    if (b.width && b.bottom > r.top && b.top < r.bottom && b.right > r.left && b.left < r.right)
      hit.push(a.textContent.trim())
  }
  return hit
}
// R3-05: the desktop Учасник column never drops under 220 px, at any width or pointer.
const partyRule = () =>
  [...document.querySelectorAll('th')]
    .filter((th) => th.textContent.trim() === 'Учасник' && th.offsetParent)
    .map((th) => Math.round(th.getBoundingClientRect().width))
// R3-09: the desktop toolbar never wraps and never runs past its own row (§3.3).
const toolbarRule = () =>
  [...document.querySelectorAll('[role="searchbox"]')]
    .map((s) => [s, s.parentElement])
    .filter(([, row]) => row.children.length > 1)
    .map(([s, row]) => {
      const edge = row.getBoundingClientRect().right + 0.5
      const h = s.getBoundingClientRect().height + 1
      // the empty `grow` spacer has no width and may sit one gap past the edge: not content
      return [...row.children]
        .map((c) => [c, c.getBoundingClientRect()])
        .filter(([, r]) => r.width > 0 && (r.right > edge || r.height > h))
        .map(([c]) => c)
        .map((c) => c.textContent.trim().slice(0, 24) || c.tagName)
    })
let measured = 0
let toolbars = 0
const covered = []
const browser = await chromium.launch()
for (const f of list) {
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: f.dpr ?? 1,
  })
  const htmlPath = join(htmlDir, `${f.name}.html`)
  writeFileSync(htmlPath, f.html)
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const hit = await page.evaluate(fabRule)
  if (hit.length) covered.push(`${f.name}: FAB over ${hit.join(', ')}`)
  const party = await page.evaluate(partyRule)
  measured += party.length
  const narrow = party.filter((px) => px < 220)
  if (narrow.length) covered.push(`${f.name}: Учасник ${narrow.join(', ')} px (< 220, R3-05)`)
  const rows = await page.evaluate(toolbarRule)
  toolbars += rows.length
  const spill = rows.flat()
  if (spill.length)
    covered.push(`${f.name}: toolbar wraps or overflows at ${spill.join(', ')} (R3-09)`)
  const png = join(outDir, `${f.name}.png`)
  await page.screenshot({ path: png, fullPage: Boolean(f.full) })
  if (magick)
    execFileSync('magick', [png, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${png}`])
  console.log(`${f.name}.png ${Math.round(statSync(png).size / 1024)} KB`)
  await page.close()
}
await browser.close()
console.log(`rendered ${list.length} frames${magick ? '' : ' (no magick: unquantised)'}`)
if (covered.length)
  throw new Error(`layout checks failed (M21, R3-05, R3-09):\n- ${covered.join('\n- ')}`)
console.log(
  `FAB clear of every amount in ${list.length} frames; Учасник ≥ 220 px in ${measured} tables; ${toolbars} toolbars in one row`,
)
