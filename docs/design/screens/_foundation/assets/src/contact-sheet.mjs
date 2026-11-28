// contact-sheet.sh for hosts without ImageMagick (Windows): the same three sheets, laid out in a browser and
// quantised with sharp. Usage: SHARP_MODULE=<sharp/lib/index.js> node contact-sheet.mjs <shell|primitives>
// (env as render.mjs). Tiles are inlined as data URLs: a setContent page cannot load file:// images. Grouping and tiles match contact-sheet.sh; each sheet stays ≤ ~400 KB.
import { readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const sharp = (await import(pathToFileURL(process.env.SHARP_MODULE).href)).default
const dir = join(here, '..', `${process.argv[2]}-v2`)
for (const f of readdirSync(dir)) if (f.startsWith('_contact-sheet')) rmSync(join(dir, f))
const all = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort()
const base = (f) => f.replace(/\.png$/, '')
const detail = all.filter((f) => ['chart-desktop', 'transition-storyboard'].includes(base(f)))
const phones = all.filter((f) => /-(320|375)$/.test(base(f)))
const wide = all.filter((f) => !phones.includes(f) && !detail.includes(f))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
async function sheet(out, files, { cols, tw, th, font }) {
  if (!files.length) return
  const tiles = files
    .map(
      (f) =>
        `<figure><div class="box" style="${tw ? `width:${tw}px;height:${th}px` : ''}"><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}"></div><figcaption>${base(f)}</figcaption></figure>`,
    )
    .join('')
  const css = `body{margin:0;background:#141414;font:${font}px Arial,sans-serif;color:#d0d0d0}
  main{display:grid;grid-template-columns:repeat(${cols},max-content);gap:20px 22px;padding:12px;width:max-content}
  figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
  .box{display:flex;align-items:center;justify-content:center}.box img{max-width:100%;max-height:100%}`
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<style>${css}</style><main>${tiles}</main>`, { waitUntil: 'load' })
  const png = await page.locator('main').screenshot()
  await page.close()
  const path = join(dir, out)
  // Same ladder as contact-sheet.sh: 256 colours, then 96, then smaller scales, until ≤ 400 KB.
  for (const [scale, colors] of [
    [1, 256],
    [1, 96],
    [0.9, 96],
    [0.8, 64],
    [0.72, 48],
    [0.6, 48],
  ]) {
    const meta = await sharp(png).metadata()
    const buf = await sharp(png)
      .resize(Math.round(meta.width * scale))
      .png({ palette: true, colors, dither: 0, compressionLevel: 9 })
      .toBuffer()
    writeFileSync(path, buf)
    if (buf.length <= 409600) break
  }
  console.log(`${path} ${Math.round(statSync(path).size / 1024)} KB from ${files.length} frames`)
}
await sheet('_contact-sheet.png', phones, { cols: 6, tw: 300, th: 400, font: 13 })
await sheet('_contact-sheet-wide.png', wide, { cols: 3, tw: 620, th: 465, font: 15 })
await sheet('_contact-sheet-detail.png', detail, { cols: 1, font: 18 })
await browser.close()
