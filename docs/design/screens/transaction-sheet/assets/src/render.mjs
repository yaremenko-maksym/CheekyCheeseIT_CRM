// Renders the transaction-sheet HTML prototypes to PNG (design-gate: degraded — no Claude Design export).
// Usage: node render.mjs [frame-name-filter]
// Output: ../transaction-sheet/<frame>.png (+ the self-contained HTML in $HTML_OUT, default a temp dir).
// Env overrides (the same idea as the foundation's render.mjs):
//   PLAYWRIGHT_MODULE — path to a playwright(-core) entry; default: apps/e2e's playwright
//   CHROMIUM_PATH     — a chromium / headless-shell executable, when the default lookup fails
//   LUCIDE_ICONS_DIR  — lucide's dist/esm/icons, when apps/web has no node_modules
//   SHARP_MODULE      — path to sharp, used to quantise when ImageMagick (`magick`) is absent
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

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
const { frames } = await import(pathToFileURL(join(here, 'frames.mjs')).href)
const filter = process.argv[2]
const outDir = join(here, '..', 'transaction-sheet')
const htmlDir = process.env.HTML_OUT ?? mkdtempSync(join(tmpdir(), 'tsheet-html-'))
mkdirSync(outDir, { recursive: true })
mkdirSync(htmlDir, { recursive: true })

// Self-contained: drop the web-font links (Inter must be installed locally; the fallback is system-ui).
// INTER_DIR — a directory of @fontsource/inter `files/*.woff2`, for a host without Inter installed.
const INTER = process.env.INTER_DIR
  ? `<style>${[400, 500, 600, 700]
      .flatMap((wt) =>
        ['latin', 'cyrillic'].map(
          (sub) =>
            `@font-face{font-family:Inter;font-weight:${wt};font-style:normal;src:url(${pathToFileURL(join(process.env.INTER_DIR, `inter-${sub}-${wt}-normal.woff2`)).href}) format('woff2')}`,
        ),
      )
      .join('')}</style>`
  : ''
const selfContained = (html) =>
  html
    .replace(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, '')
    .replace('</head>', `${INTER}</head>`)

async function quantise(png) {
  try {
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
    return
  } catch {
    if (!process.env.SHARP_MODULE) return // shortcut: unquantised PNG when neither tool exists
  }
  const sharp = (await import(pathToFileURL(process.env.SHARP_MODULE).href)).default
  const buf = await sharp(png)
    .png({ palette: true, colors: 256, dither: 0, compressionLevel: 9 })
    .toBuffer()
  writeFileSync(png, buf)
}

const list = frames().filter((f) => !filter || f.name.includes(filter))
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
let n = 0
for (const f of list) {
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: f.dpr,
  })
  const htmlPath = join(htmlDir, `${f.name}.html`)
  writeFileSync(htmlPath, selfContained(f.html))
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const png = join(outDir, `${f.name}.png`)
  await page.screenshot({ path: png })
  await quantise(png)
  console.log(`${f.name}.png ${Math.round(statSync(png).size / 1024)} KB`)
  await page.close()
  n++
}
await browser.close()
console.log(`rendered ${n} of ${list.length} frames`)
