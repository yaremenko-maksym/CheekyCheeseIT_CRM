// Renders the Wave 0 HTML prototypes to PNG (design-gate: degraded — no Claude Design export).
// Usage: node render.mjs <shell|primitives> [frame-name-filter]
// Each frame = { name, w, h, dpr, html }. Output: ../<set>-v2/<name>.png, quantised to stay ≤ ~400 KB.
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const PW =
  process.env.PLAYWRIGHT_MODULE ??
  '/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs'
const { chromium } = await import(PW)

const here = dirname(fileURLToPath(import.meta.url))
const [set, filter] = process.argv.slice(2)
const mod = await import(join(here, `${set}.mjs`))
const outDir = join(here, '..', `${set === 'shell' ? 'shell' : 'primitives'}-v2`)
const htmlDir = process.env.HTML_OUT ?? '/tmp/designer-w08/html'
mkdirSync(outDir, { recursive: true })
mkdirSync(htmlDir, { recursive: true })

const frames = mod.frames().filter((f) => !filter || f.name.includes(filter))
const browser = await chromium.launch()
let n = 0
for (const f of frames) {
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: f.dpr ?? 1,
  })
  const htmlPath = join(htmlDir, `${f.name}.html`)
  writeFileSync(htmlPath, f.html)
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const png = join(outDir, `${f.name}.png`)
  await page.screenshot({ path: png, fullPage: Boolean(f.full) })
  // Lossy palette quantisation keeps dark UI crisp and the file small.
  execFileSync('magick', [
    png,
    '-strip',
    '-dither',
    'None',
    '-colors',
    '256',
    '-define',
    'png:compression-level=9',
    `PNG8:${png}`,
  ])
  console.log(`${f.name}.png ${Math.round(statSync(png).size / 1024)} KB`)
  await page.close()
  n++
}
await browser.close()
console.log(`rendered ${n} of ${frames.length} frames`)
