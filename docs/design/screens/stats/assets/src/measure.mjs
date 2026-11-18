// Reproduces the measured claims of stats.md: (1) loading frame vs default frame block bounds (M5),
// (2) interactive target sizes per class (§2.5), (3) the month table fits its column (M10).
// Run: `node measure.mjs` (same env as render.mjs: PLAYWRIGHT_MODULE, LUCIDE_ICONS_DIR, CHROMIUM_PATH).
// Output is plain text; a non-zero exit code means a measured claim failed.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const { frames } = await import(pathToFileURL(join(here, 'stats.mjs')).href)
const dir = mkdtempSync(join(tmpdir(), 'crm-stats-measure-'))
const all = frames()
const byName = Object.fromEntries(all.map((f) => [f.name, f]))
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
let failed = 0

async function open(f) {
  const page = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: 1,
  })
  const path = join(dir, `${f.name}.html`)
  writeFileSync(path, f.html)
  await page.goto(pathToFileURL(path).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  return page
}

// ---- (1) block bounds: cards, groups and section heads, in document order ----
const blocks = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('.device').getBoundingClientRect()
    return [...document.querySelectorAll('.device section, .device .group, .device .sechead')]
      .filter((e) => !e.closest('.sheet'))
      .map((e) => {
        const r = e.getBoundingClientRect()
        return [Math.round(r.top - d.top), Math.round(r.height), Math.round(r.width)]
      })
  })
console.log('== Block bounds: loading frame vs default frame (limit 8 px) ==')
for (const [load, def] of [
  ['loading-375', 'default-375'],
  ['loading-320', 'default-320'],
  ['loading-768', 'default-768'],
  ['loading-1440', 'default-1440'],
]) {
  const a = await blocks(await open(byName[load]))
  const b = await blocks(await open(byName[def]))
  let worst = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++)
    worst = Math.max(worst, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]))
  const ok = a.length === b.length && worst <= 8
  if (!ok) failed++
  console.log(
    `${load}: ${a.length} blocks vs ${b.length}, worst top/height delta ${worst} px ${ok ? 'OK' : 'FAIL'}`,
  )
}

// ---- (2) target sizes: interactive elements smaller than the minimum, per frame ----
// Coarse pointer (phone, tablet, touch-1024): 44 px. Fine pointer desktop: 24 px (WCAG 2.2 SC 2.5.8).
// `scope` = the content pane only for the desktop shell; the sidebar is reported separately (M12).
const SEL =
  '[role=button],[role=link],[role=radio],[role=option],[role=switch],a,button,.btn,.iconbtn,.lrow'
console.log('\n== Targets below the minimum (content pane; count, then the first offenders) ==')
for (const [name, min, scope] of [
  ['default-375', 44, '.content'],
  ['default-320', 44, '.content'],
  ['default-768', 44, 'section[aria-label="Статистика"]'],
  ['default-1000', 44, 'section[aria-label="Статистика"]'],
  ['touch-1024', 44, 'main, .device > div:not(nav)'],
  ['default-1440', 24, 'main, .device > div:not(nav)'],
]) {
  const page = await open(byName[name])
  const res = await page.evaluate(
    ([sel, min, scope]) => {
      const roots = [...document.querySelectorAll(scope)]
      const seen = new Set()
      const small = []
      for (const root of roots)
        for (const el of root.querySelectorAll(sel)) {
          if (seen.has(el) || el.closest('svg') || el.closest('[style*="clip:rect"]')) continue
          seen.add(el)
          const r = el.getBoundingClientRect()
          if (r.width < 1) continue
          // a smaller glyph box inside a 44 px hit area counts by the hit area
          const kid = el.firstElementChild
          const h = Math.max(r.height, kid && kid.getBoundingClientRect().height > r.height ? 0 : 0)
          if (h < min - 0.5 || r.width < min - 0.5)
            small.push(
              `${el.tagName}.${(el.className || '').toString().slice(0, 18)} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || '').trim().slice(0, 18)}"`,
            )
        }
      return { checked: seen.size, small }
    },
    [SEL, min, scope],
  )
  console.log(
    `${name} (min ${min}): ${res.checked} checked, ${res.small.length} below${res.small.length ? ': ' + res.small.slice(0, 4).join(' | ') : ''}`,
  )
}

// ---- touch-1024 sidebar pitch (M12) ----
{
  const page = await open(byName['touch-1024'])
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('nav .srow')]
    const s = [...document.querySelectorAll('nav span.grow')].find((x) =>
      x.textContent.startsWith('Пошук'),
    )?.parentElement
    return {
      rows: rows.length,
      h: rows.map((x) => Math.round(x.getBoundingClientRect().height)),
      search: s ? Math.round(s.getBoundingClientRect().height) : null,
    }
  })
  console.log(
    `\ntouch-1024 sidebar: ${r.rows} rows, heights ${[...new Set(r.h)].join('/')} px, search ${r.search} px`,
  )
}

// ---- (3) month table fits its column and no cell is clipped (M10) ----
console.log('\n== Month table vs its card ==')
for (const name of [
  'default-1024',
  'default-1280',
  'all-1280',
  'default-1440',
  'default-768',
  'default-1000',
]) {
  const page = await open(byName[name])
  const r = await page.evaluate(() => {
    const t = document.querySelector('.device table:not([style*="clip"])')
    const vis = [...document.querySelectorAll('.device table')].find(
      (x) => !x.closest('[style*="clip:rect"]'),
    )
    if (!vis) return null
    const card = vis.closest('section')
    const cr = card.getBoundingClientRect()
    const tr = vis.getBoundingClientRect()
    const clipped = [...vis.querySelectorAll('th,td')].filter(
      (c) =>
        c.scrollWidth > c.clientWidth + 1 || c.getBoundingClientRect().right > cr.right - 12 + 0.5,
    ).length
    return { card: Math.round(cr.width), table: Math.round(tr.width), clipped, t: !!t }
  })
  const ok = r && r.clipped === 0
  if (!ok) failed++
  console.log(
    `${name}: card ${r?.card} px, table ${r?.table} px, cells clipped or inside the 12 px edge: ${r?.clipped} ${ok ? 'OK' : 'FAIL'}`,
  )
}

await browser.close()
console.log(failed ? `\n${failed} measured claim(s) FAILED` : '\nall measured claims hold')
process.exit(failed ? 1 : 0)
