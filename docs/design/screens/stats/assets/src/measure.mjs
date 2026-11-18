// Reproduces the measured claims of stats.md and FAILS (exit 1) when one does not hold (R3-M21):
//  (1) loading frame vs default frame block bounds (M5)      (5) status strip height and clipping (R3-M16)
//  (2) interactive target sizes, content, sheets, states     (6) loading frames carry no data (R3-M15)
//  (3) touch-1024 sidebar pitch (M12)                        (7) per-node text contrast, default frames (R3-M21)
//  (4) the month table fits its column (M10)
// Run: `node measure.mjs` (same env as render.mjs: PLAYWRIGHT_MODULE, LUCIDE_ICONS_DIR, CHROMIUM_PATH).
// The last line is the summary quoted in stats.md §2.5.
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
let checks = 0
/** One counted check; a failing one is printed with FAIL and makes the exit code non-zero. */
const check = (ok, line) => {
  checks++
  if (!ok) failed++
  console.log(`${line} ${ok ? 'OK' : 'FAIL'}`)
}

async function open(name) {
  const f = byName[name]
  if (!f) throw new Error(`no frame named ${name}`)
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
const delta = (a, b) => {
  let worst = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++)
    worst = Math.max(worst, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]))
  return worst
}
console.log('== (1) Block bounds: loading frame vs default frame (limit 8 px) ==')
for (const [load, def] of [
  ['loading-375', 'default-375'],
  ['loading-320', 'default-320'],
  ['loading-768', 'default-768'],
  ['loading-1440', 'default-1440'],
]) {
  const a = await blocks(await open(load))
  const b = await blocks(await open(def))
  const worst = delta(a, b)
  check(
    a.length === b.length && worst <= 8,
    `${load}: ${a.length} blocks vs ${b.length}, worst top/height delta ${worst} px`,
  )
}
// Information, not a gate: the same skeleton against other fixtures shows the shift real data can cause.
for (const [load, other] of [
  ['loading-375', 'long-375'],
  ['loading-375', 'balanced-375'],
  ['loading-1440', 'long-1440'],
]) {
  const a = await blocks(await open(load))
  const b = await blocks(await open(other))
  console.log(
    `info ${load} vs ${other}: ${a.length} / ${b.length} blocks, worst delta ${delta(a, b)} px`,
  )
}

// ---- (2) target sizes: interactive elements smaller than the minimum, per frame ----
// Coarse pointer (phone, tablet, touch-1024): 44 px. Fine pointer desktop: 24 px (WCAG 2.2 SC 2.5.8).
// `scope` = the content pane only; the sidebar is reported separately (M12). A failing target fails the run.
const SEL =
  '[role=button],[role=link],[role=radio],[role=option],[role=switch],a,button,.btn,.iconbtn,.lrow'
console.log('\n== (2) Targets below the minimum (count, then the first offenders) ==')
const PHONE = '.content, .sheet'
const TARGETS = [
  ['default-375', 44, PHONE],
  ['default-320', 44, PHONE],
  ['error-375', 44, PHONE],
  ['stale-375', 44, PHONE],
  ['stale-yesterday-375', 44, PHONE],
  ['offline-375', 44, PHONE],
  ['cold-375', 44, PHONE],
  ['series-sheet-375', 44, PHONE],
  ['month-sheet-375', 44, PHONE],
  ['hint-sheet-375', 44, PHONE],
  ['default-768', 44, 'section[aria-label="Статистика"]'],
  ['default-1000', 44, 'section[aria-label="Статистика"]'],
  ['touch-1024', 44, 'main, .device > div:not(nav)'],
  ['default-1440', 24, 'main, .device > div:not(nav)'],
]
for (const [name, min, scope] of TARGETS) {
  if (!byName[name]) continue
  const page = await open(name)
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
          if (r.height < min - 0.5 || r.width < min - 0.5)
            small.push(
              `${el.tagName}.${(el.className || '').toString().slice(0, 18)} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || '').trim().slice(0, 18)}"`,
            )
        }
      return { checked: seen.size, small }
    },
    [SEL, min, scope],
  )
  check(
    res.checked > 0 && res.small.length === 0,
    `${name} (min ${min}): ${res.checked} checked, ${res.small.length} below${res.small.length ? ': ' + res.small.slice(0, 4).join(' | ') : ''}`,
  )
}

// ---- (3) touch-1024 sidebar pitch (M12) ----
console.log('\n== (3) Sidebar at a coarse pointer ==')
{
  const page = await open('touch-1024')
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
  check(
    r.rows > 0 && r.h.every((x) => x >= 44) && r.search >= 44,
    `touch-1024 sidebar: ${r.rows} rows, heights ${[...new Set(r.h)].join('/')} px, search ${r.search} px`,
  )
}

// ---- (4) month table fits its column and no cell is clipped (M10) ----
console.log('\n== (4) Month table vs its card ==')
for (const name of [
  'default-1024',
  'default-1280',
  'all-1280',
  'default-1440',
  'default-768',
  'default-1000',
  'all-768',
]) {
  if (!byName[name]) continue
  const page = await open(name)
  const r = await page.evaluate(() => {
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
    // the nearest scrolling ancestor of the table (an inner scroller on a coarse pointer is a defect, R3-M19)
    let scroller = false
    for (let e = vis.parentElement; e && e !== card; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1) scroller = true
    }
    return { card: Math.round(cr.width), table: Math.round(tr.width), clipped, scroller }
  })
  const touch = ['all-768', 'default-768', 'default-1000'].includes(name)
  check(
    !!r && r.clipped === 0 && !(touch && r.scroller),
    `${name}: card ${r?.card} px, table ${r?.table} px, cells clipped or inside the 12 px edge: ${r?.clipped}${touch ? `, inner scroller on a coarse pointer: ${r?.scroller}` : ''}`,
  )
}

// ---- (5) status strip: height, clipping, and what it costs the first viewport (R3-M16) ----
console.log(
  '\n== (5) Status strip (limit 44 px from 360 px wide; below 360 px the retry may wrap) ==',
)
const stripOf = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('[data-strip]')
    if (!s) return null
    const r = s.getBoundingClientRect()
    const d = document.querySelector('.device').getBoundingClientRect()
    const w = s.parentElement.style.position === 'sticky' ? s.parentElement : s
    const wr = w.getBoundingClientRect()
    const clipped = [...s.querySelectorAll('span')].filter((x) => x.scrollWidth > x.clientWidth + 1)
    const first = [...document.querySelectorAll('.device section, .device .group')].find(
      (e) => !e.closest('.sheet') && e.getBoundingClientRect().top > r.bottom - 1,
    )
    return {
      box: Math.round(r.height),
      occupied: Math.round(wr.height) + (w === s ? 4 : 0),
      width: Math.round(r.width),
      clipped: clipped.length,
      right: Math.round(d.right - r.right),
      firstTop: first ? Math.round(first.getBoundingClientRect().top - d.top) : null,
    }
  })
const base = {}
for (const [strip, bare, w] of [
  ['stale-375', 'default-375', 375],
  ['stale-yesterday-375', 'default-375', 375],
  ['stale-scrolled-375', null, 375],
  ['retry-busy-375', 'default-375', 375],
  ['offline-375', 'default-375', 375],
  ['cold-375', null, 375],
  ['stale-yesterday-320', 'default-320', 320],
  ['stale-1440', 'default-1440', 1440],
  ['offline-1440', 'default-1440', 1440],
]) {
  if (!byName[strip]) continue
  const s = await stripOf(await open(strip))
  let loss = ''
  if (bare) {
    base[bare] ??= (await blocks(await open(bare)))[0][0]
    const first = (await blocks(await open(strip))).find((b) => b[0] > 0)
    loss = ` , first block top ${s.firstTop ?? first?.[0]} vs ${base[bare]} px without it`
  }
  const phoneOk = w >= 360 ? s.box <= 44 : true
  check(
    !!s && phoneOk && s.clipped === 0,
    `${strip}: ${s.width} px wide, box ${s.box} px, occupies ${s.occupied} px, clipped spans ${s.clipped}${loss}`,
  )
}

// Close buttons of the sheets: the glyph is smaller than the box, the box is the hit area (R3-17).
for (const name of ['series-sheet-375', 'month-sheet-375', 'hint-sheet-375']) {
  const page = await open(name)
  const r = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet [aria-label="Закрити"], .sheet .iconbtn')].find(
      (x) => x.getBoundingClientRect().width > 1,
    )
    if (!b) return null
    const q = b.getBoundingClientRect()
    return { w: Math.round(q.width), h: Math.round(q.height) }
  })
  check(!!r && r.w >= 44 && r.h >= 44, `${name} close control: hit area ${r?.w} x ${r?.h} px`)
}

// ---- (6) loading frames carry placeholders only (R3-M15) ----
console.log('\n== (6) Loading frames: no visible data, no chromatic fill, uniform bars ==')
for (const name of ['loading-375', 'loading-320', 'loading-768', 'loading-1440']) {
  const page = await open(name)
  const r = await page.evaluate(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    const cx = cv.getContext('2d', { willReadFrequently: true })
    const rgba = (c) => {
      cx.clearRect(0, 0, 1, 1)
      cx.fillStyle = '#000'
      cx.fillStyle = c
      cx.fillRect(0, 0, 1, 1)
      const d = cx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const chroma = (c) => {
      const [r, g, b, a] = rgba(c)
      return a > 0.05 ? Math.max(r, g, b) - Math.min(r, g, b) : 0
    }
    const root = document.querySelector('.skel')
    if (!root) return { skel: false }
    const text = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim()
      const el = n.parentElement
      if (!t || el.closest('[style*="clip:rect"]')) continue
      const cs = getComputedStyle(el)
      const col = el instanceof SVGElement ? cs.fill : cs.color
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (rgba(col)[3] > 0.05) text.push(t.slice(0, 20))
    }
    const chromatic = []
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('defs')) continue
      const svg = el instanceof SVGElement
      let op = 1
      for (let e = el; e && e !== root; e = e.parentElement)
        op *= parseFloat(getComputedStyle(e).opacity)
      if (op < 0.05) continue
      const paints = [cs.backgroundColor]
      for (const s of ['Top', 'Right', 'Bottom', 'Left'])
        if (parseFloat(cs[`border${s}Width`]) > 0) paints.push(cs[`border${s}Color`])
      if (svg)
        paints.push(
          cs.fill === 'none' ? 'transparent' : cs.fill,
          cs.stroke === 'none' ? 'transparent' : cs.stroke,
        )
      if (paints.some((p) => chroma(p) > 12))
        chromatic.push(`${el.tagName}.${(el.getAttribute('class') || '').slice(0, 14)}`)
    }
    const bars = [...root.querySelectorAll('svg[role=group] rect')]
      .filter((x) => {
        const f = getComputedStyle(x).fill
        return f !== 'none' && rgba(f)[3] > 0.05
      })
      .map((x) => Math.round(x.getBoundingClientRect().height * 10) / 10)
    return { skel: true, text, chromatic, bars }
  })
  check(
    r.skel && r.text.length === 0,
    `${name}: visible text nodes ${r.text?.length}${r.text?.length ? ': ' + r.text.slice(0, 4).join(' | ') : ''}`,
  )
  check(
    r.skel && r.chromatic.length === 0,
    `${name}: chromatic fills or borders ${r.chromatic?.length}${r.chromatic?.length ? ': ' + [...new Set(r.chromatic)].slice(0, 4).join(' | ') : ''}`,
  )
  if (r.bars?.length)
    check(
      new Set(r.bars).size === 1,
      `${name}: ${r.bars.length} placeholder bars, ${new Set(r.bars).size} distinct height(s)`,
    )
}

// ---- (7) text contrast, per text node: computed colour against the computed background ----
// 4.5:1 for body text, 3:1 for large text (>= 24 px, or >= 18.66 px bold). A disabled control is exempt
// (WCAG 1.4.3) and counted. A node on a gradient or image cannot be resolved and is counted as unmeasured.
// Non-text contrast (1.4.11) is not measured here; see stats.md §2.5.
console.log('\n== (7) Text contrast (default and state frames) ==')
const contrastOf = (page) =>
  page.evaluate(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    const cx = cv.getContext('2d', { willReadFrequently: true })
    const rgba = (c) => {
      cx.clearRect(0, 0, 1, 1)
      cx.fillStyle = '#000'
      cx.fillStyle = c
      cx.fillRect(0, 0, 1, 1)
      const d = cx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const over = (top, bot, a) => top.map((c, i) => (i < 3 ? c * a + bot[i] * (1 - a) : 1))
    const background = (el) => {
      const layers = []
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e)
        if (cs.backgroundImage !== 'none') return null
        const c = rgba(cs.backgroundColor)
        if (c[3] > 0) layers.push(c)
        if (c[3] >= 0.999) break
      }
      if (!layers.length || layers[layers.length - 1][3] < 0.999) return null
      let acc = layers[layers.length - 1]
      for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc, layers[i][3])
      return acc
    }
    let n = 0
    let exempt = 0
    let unmeasured = 0
    let min = Infinity
    const fails = []
    const walker = document.createTreeWalker(
      document.querySelector('.device'),
      NodeFilter.SHOW_TEXT,
    )
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.textContent.trim()
      const el = node.parentElement
      if (!t || el.closest('[style*="clip:rect"]') || el.closest('style,script')) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      if (el.closest('[aria-disabled=true],[disabled]')) {
        exempt++
        continue
      }
      const bg = background(el)
      let op = 1
      for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity)
      const fg = rgba(el instanceof SVGElement ? cs.fill : cs.color)
      if (!bg || fg[3] === 0) {
        unmeasured++
        continue
      }
      const eff = over(fg, bg, fg[3] * op)
      const [L1, L2] = [lum(eff), lum(bg)].sort((a, b) => b - a)
      const ratio = (L1 + 0.05) / (L2 + 0.05)
      const px = parseFloat(cs.fontSize)
      const large = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700)
      const need = large ? 3 : 4.5
      n++
      min = Math.min(min, ratio / need)
      if (ratio < need) fails.push(`"${t.slice(0, 22)}" ${ratio.toFixed(2)}:${need} (${px}px)`)
    }
    return { n, exempt, unmeasured, fails, worst: min }
  })
for (const name of [
  'default-375',
  'default-320',
  'default-768',
  'default-1000',
  'default-1440',
  'stale-375',
  'offline-375',
  'cold-375',
  'error-375',
]) {
  if (!byName[name]) continue
  const r = await contrastOf(await open(name))
  check(
    r.n > 0 && r.fails.length === 0,
    `${name}: ${r.n} text nodes measured (lowest ${(r.worst * 100).toFixed(0)} % of the required ratio), ${r.exempt} disabled exempt, ${r.unmeasured} unmeasured, ${r.fails.length} below the minimum${r.fails.length ? ': ' + r.fails.slice(0, 4).join(' | ') : ''}`,
  )
}

await browser.close()
console.log(
  `\nmeasure.mjs: ${checks} checks, ${failed} failed${failed ? '' : ' — all measured claims hold'}`,
)
process.exit(failed ? 1 : 0)
