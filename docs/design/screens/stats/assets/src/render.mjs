// Stats screen mockups. `node render.mjs [filter]` writes ../stats/<frame>.png.
// Reuses the foundation helpers read-only (../../../_foundation/assets/src). Same toolchain as the
// foundation renderer: playwright from apps/e2e (override PLAYWRIGHT_MODULE), lucide from apps/web
// (override LUCIDE_ICONS_DIR). PNG quantisation with ImageMagick runs only when `magick` is on PATH.
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// The repo root is six levels up (src, assets, stats, screens, design, docs).
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
const { frames } = await import(pathToFileURL(join(here, 'stats.mjs')).href)
const [filter] = process.argv.slice(2)
const outDir = join(here, '..', 'stats')
const htmlDir = process.env.HTML_OUT ?? mkdtempSync(join(tmpdir(), 'crm-stats-render-'))
mkdirSync(outDir, { recursive: true })
mkdirSync(htmlDir, { recursive: true })

let magick = true
try {
  execFileSync('magick', ['-version'], { stdio: 'ignore' })
} catch {
  magick = false
}

const list = frames().filter((f) => !filter || f.name.includes(filter))
// a filter that matches no frame is an error, not «rendered 0 of 0» with exit 0 (CR-L-1)
if (!list.length) {
  console.error(`render.mjs: no frame matches ${filter ? `«${filter}»` : '(no frames defined)'}`)
  process.exit(1)
}
// CHROMIUM_PATH: reuse an already-installed browser build when the playwright revision differs.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
let n = 0
for (const f of list) {
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: f.dpr ?? 1,
  })
  const htmlPath = join(htmlDir, `${f.name}.html`)
  writeFileSync(htmlPath, f.html)
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  // fit: the frame is as tall as its content (the [data-fit-end] marker) plus f.fit px of bottom room.
  if (f.fit != null) {
    const fitH = await page.evaluate((pad) => {
      const d = document.querySelector('.device')
      const e = document.querySelector('[data-fit-end]')
      const hgt = Math.ceil(e.getBoundingClientRect().bottom - d.getBoundingClientRect().top + pad)
      d.style.height = `${hgt}px`
      return hgt
    }, f.fit)
    await page.setViewportSize({ width: f.w, height: Math.min(fitH + 40, 6000) })
  }
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth)
      return ['document']
    // an element that pokes out of the device on the right is clipped text or a layout bug
    const d = document.querySelector('.device')
    const r = d.getBoundingClientRect().right
    return [...d.querySelectorAll('*')]
      .filter(
        (el) =>
          !el.closest('svg') &&
          !el.closest('.sheet') &&
          !el.closest('[style*="clip:rect"]') &&
          el.getBoundingClientRect().width > 1 &&
          el.getBoundingClientRect().right > r + 1,
      )
      .slice(0, 3)
      .map((el) => `${el.tagName}.${el.className} "${(el.textContent || '').slice(0, 30)}"`)
  })
  const png = join(outDir, `${f.name}.png`)
  await page.screenshot({ path: png, fullPage: Boolean(f.full || f.fit != null) })
  if (magick)
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
  console.log(
    `${f.name}.png ${Math.round(statSync(png).size / 1024)} KB${overflow.length ? ` HORIZONTAL-OVERFLOW ${overflow.join(' | ')}` : ''}`,
  )
  await page.close()
  n++
}
await browser.close()
console.log(
  `rendered ${n} of ${list.length} frames${magick ? '' : ' (no magick: PNG not quantised)'}`,
)
