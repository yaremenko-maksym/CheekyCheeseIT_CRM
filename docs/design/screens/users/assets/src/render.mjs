// Renders the users-screen HTML prototypes to PNG (design-gate: degraded — no Claude Design export).
// Usage: node render.mjs [frame-name-filter]
// Same pipeline as _foundation/assets/src/render.mjs, but writes to ../users/ and quantises with sharp
// (ImageMagick is not required). Each frame = { name, w, h, dpr, full?, html }.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
// The repo root is six levels up (src, assets, users, screens, design, docs).
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

// sharp is not hoisted; take it from the pnpm store. Missing sharp → PNGs stay unquantised.
async function loadSharp() {
  // SHARP_MODULE: absolute path to sharp's entry, for a checkout without node_modules.
  if (process.env.SHARP_MODULE)
    return (await import(pathToFileURL(process.env.SHARP_MODULE).href)).default
  const store = join(REPO, 'node_modules/.pnpm')
  if (!existsSync(store)) return null
  const dir = readdirSync(store).find((d) => d.startsWith('sharp@'))
  if (!dir) return null
  const req = createRequire(join(store, dir, 'node_modules/sharp/package.json'))
  return (await import(pathToFileURL(req.resolve('sharp')).href)).default
}
const sharp = await loadSharp()

const [filter] = process.argv.slice(2)
const mod = await import(pathToFileURL(join(here, 'users.mjs')).href)
const outDir = join(here, '..', 'users')
const htmlDir = process.env.HTML_OUT ?? mkdtempSync(join(tmpdir(), 'crm-users-render-'))
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
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const png = join(outDir, `${f.name}.png`)
  const buf = await page.screenshot({ fullPage: Boolean(f.full) })
  // Palette quantisation keeps the dark UI crisp and the file small.
  const out = sharp
    ? await sharp(buf)
        .png({ palette: true, colors: 256, dither: 0, compressionLevel: 9 })
        .toBuffer()
    : buf
  writeFileSync(png, out)
  console.log(`${f.name}.png ${Math.round(statSync(png).size / 1024)} KB`)
  await page.close()
  n++
}
await browser.close()
console.log(`rendered ${n} of ${frames.length} frames`)
