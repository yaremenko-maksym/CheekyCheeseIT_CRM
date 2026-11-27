// Renders the Wave 0 HTML prototypes to PNG (design-gate: degraded — no Claude Design export).
// Usage: node render.mjs <shell|primitives> [frame-name-filter]
// Each frame = { name, w, h, dpr, html }. Output: ../<set>-v2/<name>.png, quantised to stay ≤ ~400 KB.
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// playwright comes from apps/e2e (through @playwright/test); the repo root is six levels up from here.
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
// Hosts without ImageMagick (Windows): SHARP_MODULE=<path to sharp/lib/index.js> quantises with sharp instead.
const SHARP = process.env.SHARP_MODULE
  ? (await import(pathToFileURL(process.env.SHARP_MODULE).href)).default
  : null
const [set, filter] = process.argv.slice(2)
const mod = await import(pathToFileURL(join(here, `${set}.mjs`)).href)
const outDir = join(here, '..', `${set === 'shell' ? 'shell' : 'primitives'}-v2`)
const htmlDir = process.env.HTML_OUT ?? mkdtempSync(join(tmpdir(), 'crm-render-'))
mkdirSync(outDir, { recursive: true })
mkdirSync(htmlDir, { recursive: true })

const frames = mod.frames().filter((f) => !filter || f.name.includes(filter))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }) // unset = the bundled browser
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
  if (SHARP) {
    const buf = await SHARP(png).png({ palette: true, colors: 256, dither: 0, compressionLevel: 9 }).toBuffer()
    writeFileSync(png, buf)
  } else
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
