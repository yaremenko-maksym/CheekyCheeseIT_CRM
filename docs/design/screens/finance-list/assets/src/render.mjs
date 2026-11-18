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
import { swipeContrast } from './contrast.mjs'

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
  const m = f.html.match(/data-match="(\d+)"/)
  if (m && +m[1] !== n) bad.push(`${f.name}: «Показано ${m[1]}», ${n} rows drawn`)
  if (/^(role-junior|role-drop|drop-)/.test(f.name) && f.html.includes('aria-label="Пошук"'))
    bad.push(`${f.name}: search icon on a page without search`)
}
if (bad.length) throw new Error(`frames do not add up:\n- ${bad.join('\n- ')}`)
console.log(`frames add up: ${all.length} checked`)
const list = all.filter((f) => !filter || f.name.includes(filter))
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
  const png = join(outDir, `${f.name}.png`)
  await page.screenshot({ path: png, fullPage: Boolean(f.full) })
  if (magick)
    execFileSync('magick', [png, '-strip', '-dither', 'None', '-colors', '256', `PNG8:${png}`])
  console.log(`${f.name}.png ${Math.round(statSync(png).size / 1024)} KB`)
  await page.close()
}
await browser.close()
console.log(`rendered ${list.length} frames${magick ? '' : ' (no magick: unquantised)'}`)
