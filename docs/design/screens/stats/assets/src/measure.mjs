// Reproduces the measured claims of stats.md and FAILS (exit 1) when one does not hold (R3-M21):
//  (1) loading frame vs default frame block bounds (M5)      (5) status strip height and clipping (R3-M16)
//  (2) interactive target sizes, content, sheets, states     (6) loading frames carry no data (R3-M15)
//  (3) touch-1024 sidebar pitch (M12)                        (7) per-node text contrast, every frame (R3-M21)
//  (4) the month table fits its column (M10)                 (8) only a row with open projects is a disclosure (R4-01)
//  (9) the pending-validation tile equals the drawn pills (R4-02)  (10) string gate against stats.md §2.6 (R4-07)
//  (11) tablet hint popover ends above the series control (R4-04)  (12) plot band widths (R4-09)
// (7) runs over every frame, with non-text contrast 3 : 1 (R4-06); (8)–(10) share that single pass.
// Run: `node measure.mjs` (same env as render.mjs: PLAYWRIGHT_MODULE, LUCIDE_ICONS_DIR, CHROMIUM_PATH).
// The last line is the summary quoted in stats.md §2.5.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// One page at a time: every caller is done with the previous page before it opens the next one, so the
// previous page is closed here (an open page per frame exhausted the browser over 59 frames: goto timeouts).
let last
async function open(name) {
  const f = byName[name]
  if (!f) throw new Error(`no frame named ${name}`)
  if (last) await last.close()
  const page = (last = await browser.newPage({
    viewport: { width: f.w, height: f.h },
    deviceScaleFactor: 1,
  }))
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
  ['stale-768', 44, 'section[aria-label="Статистика"]'],
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
  ['stale-768', 'default-768', 768],
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
    // Non-text contrast (1.4.11, 3 : 1): every chart mark and progress fill against what is next to it.
    // Data bars (solid fill), loss bars (outline and hatch line), the selected bar's outline: against the plot
    // background, with a hovered band's fill composed under them. Progress fills (compliance tracks, partner
    // share bars): against their own track. Gridlines and the hover band are decorative (§2.5). Skeletons skip.
    const nt = { n: 0, fails: [], worst: Infinity }
    const mark = (what, colour, op, bg) => {
      const c = rgba(colour)
      if (c[3] === 0) return
      const eff = over(c, bg, c[3] * op)
      const [L1, L2] = [lum(eff), lum(bg)].sort((a, b) => b - a)
      const ratio = (L1 + 0.05) / (L2 + 0.05)
      nt.n++
      nt.worst = Math.min(nt.worst, ratio)
      if (ratio < 3) nt.fails.push(`${what} ${ratio.toFixed(2)}:3`)
    }
    const opacity = (el) => {
      let op = 1
      for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity)
      return op
    }
    for (const svg of document.querySelectorAll('.device svg[role=group]')) {
      if (svg.closest('.skel')) continue
      const plotBg = background(svg)
      if (!plotBg) continue
      for (const bar of svg.querySelectorAll('rect[rx="3"]')) {
        const band = bar.parentElement?.parentElement?.querySelector(':scope > rect[rx="4"]')
        const bf = band ? rgba(getComputedStyle(band).fill) : [0, 0, 0, 0]
        const bg = bf[3] > 0 ? over(bf, plotBg, bf[3]) : plotBg
        const cs = getComputedStyle(bar)
        const op = opacity(bar)
        const label = bar.closest('[aria-label]')?.getAttribute('aria-label') ?? 'bar'
        if (cs.fill.startsWith('url')) {
          const line = svg.querySelector('pattern line')
          if (line) mark(`hatch line, ${label}`, getComputedStyle(line).stroke, op, bg)
        } else mark(`bar fill, ${label}`, cs.fill, op, bg)
        if (cs.stroke !== 'none') mark(`bar outline, ${label}`, cs.stroke, op, bg)
      }
    }
    for (const fill of document.querySelectorAll('.device span > i')) {
      if (fill.closest('.skel') || fill.getBoundingClientRect().width < 1) continue
      const track = background(fill.parentElement)
      if (track) mark('progress fill', getComputedStyle(fill).backgroundColor, opacity(fill), track)
    }
    return { n, exempt, unmeasured, fails, worst: min, nt }
  })

// ---- (10) string gate input: every visible string and accessible name a frame carries ----
const stringsOf = (page) =>
  page.evaluate(() => {
    const out = new Set()
    const walker = document.createTreeWalker(document.querySelector('.device'), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (el.closest('style,script,defs')) continue
      const t = node.textContent.replace(/\s+/g, ' ').trim()
      if (t) out.add(t)
    }
    for (const el of document.querySelectorAll('.device [aria-label],.device [title],.device [placeholder]'))
      for (const a of ['aria-label', 'title', 'placeholder'])
        if (el.getAttribute(a)) out.add(el.getAttribute(a).replace(/\s+/g, ' ').trim())
    return [...out]
  })
// ---- (8) receiver rows: only a row with open projects is a disclosure (R4-01) ----
// A row is the element that ends in the `.chev` slot and carries the `x / y` count. Complete (x = y): no
// role="button", no aria-expanded on it or above it, no chevron. Incomplete (x < y): a button with aria-expanded.
const rowAudit = (page) =>
  page.evaluate(() => {
    const out = { complete: 0, open: 0, bad: [] }
    for (const s of document.querySelectorAll('.device span')) {
      const m = /^(\d+) \/ (\d+)$/.exec(s.textContent.trim())
      if (!m || s.children.length) continue
      const row = s.closest(':has(> .chev)')
      if (!row) continue
      const done = m[1] === m[2]
      // lucide chevron-down / chevron-up path data
      const glyph = row.querySelector(':scope > .chev').innerHTML
      if (done) {
        out.complete++
        if (row.closest('[aria-expanded],[role=button]') || /m6 9|m18 15/.test(glyph))
          out.bad.push(`complete ${m[0]} is a disclosure`)
      } else {
        out.open++
        if (!row.matches('[role=button][aria-expanded]')) out.bad.push(`open ${m[0]} not a button`)
      }
    }
    return out
  })
// ---- (9) «На валідації у бухгалтера» = the drawn pending-project pills (R4-02) ----
// Only a frame that expands every receiver with open projects draws all project pills, so only those frames
// can be compared; the project pill sits in the expanded detail, outside the receiver row (the row badge
// «На валідації» is inside the row and not counted). At least two frames must qualify.
const tileOf = (page) =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll('.device div')].find(
      (d) => d.children.length === 0 && d.textContent.trim() === 'На валідації у бухгалтера',
    )
    if (!label) return null
    const rows = [...document.querySelectorAll('.device [aria-expanded]')]
    if (!rows.length || rows.some((x) => x.getAttribute('aria-expanded') !== 'true')) return null
    const pills = [...document.querySelectorAll('.device .pill')].filter(
      (p) => p.textContent.trim() === 'На валідації' && !p.closest(':has(> .chev)'),
    ).length
    return { tile: Number(label.nextElementSibling?.textContent.trim()), pills }
  })

// ---- (10) string gate: every frame string has a row in stats.md §2.6 (R4-07) ----
// A string passes when §2.6 contains it, when it fully matches a table cell read as a template ({x} = any
// text, each « / » or « · » alternative separately, «{n} » allowed before a plural form), when each « · »
// part passes, or when it is a number, an amount or initials only. Digits compare as one class, so a
// literal example («14:32», «Листопад 2026») covers the same shape with other figures.
const spec = readFileSync(join(here, '../../stats.md'), 'utf8')
const s26 = spec.slice(spec.indexOf('### 2.6'), spec.indexOf('### 2.7'))
if (s26.length < 1000) throw new Error('stats.md §2.6 not found: the string gate cannot read its table')
const norm = (t) =>
  t
    .replace(/[  ]/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
const corpus = norm(s26.replace(/[`*]/g, '').replace(/\s*\|\s*/g, ' | '))
const templates = []
for (const line of s26.split('\n').filter((l) => l.startsWith('|')))
  for (const cell of line.split('|').slice(2, -1))
    for (const part of cell.replace(/\([^)]*\)/g, '').split(/ \/ | · /)) {
      const p = norm(part.replace(/[`*]/g, ''))
      if (!p.includes('{')) continue
      const re = p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}/g, '.+?')
      templates.push(new RegExp(`^(?:# )?${re}$`))
    }
const passes = (s) => {
  const n = norm(s)
  if (!n.replace(/#|USDT|USD|тис\.|[\s.,:%+\-−–—’'/×()]/g, '')) return true
  if (/^[А-ЯЄІЇҐ]{2}$/.test(n) || corpus.includes(n) || templates.some((r) => r.test(n))) return true
  const parts = n.split(' · ')
  return parts.length > 1 && parts.every(passes)
}

// ---- One pass over every frame: (7) text and non-text contrast, (8) rows, (9) tile, (10) strings ----
console.log(`\n== (7) Text and non-text contrast, (8) receiver rows, (9) tile, every frame (${all.length}) ==`)
{
  const tx = { n: 0, exempt: 0, unmeasured: 0, worst: Infinity, worstAt: '', fails: [] }
  const nt = { n: 0, frames: 0, worst: Infinity, worstAt: '', fails: [] }
  const rows = { complete: 0, open: 0, frames: 0, bad: [] }
  let compared = 0
  let strings = 0
  const unmatched = new Map()
  for (const f of all) {
    const page = await open(f.name)
    const c = await contrastOf(page)
    tx.n += c.n
    tx.exempt += c.exempt
    tx.unmeasured += c.unmeasured
    if (c.worst < tx.worst) [tx.worst, tx.worstAt] = [c.worst, f.name]
    tx.fails.push(...c.fails.map((x) => `${f.name}: ${x}`))
    if (c.nt.n) nt.frames++
    nt.n += c.nt.n
    if (c.nt.worst < nt.worst) [nt.worst, nt.worstAt] = [c.nt.worst, f.name]
    nt.fails.push(...c.nt.fails.map((x) => `${f.name}: ${x}`))
    const r = await rowAudit(page)
    if (r.complete + r.open) rows.frames++
    rows.complete += r.complete
    rows.open += r.open
    rows.bad.push(...r.bad.map((b) => `${f.name}: ${b}`))
    const t = await tileOf(page)
    if (t) {
      compared++
      check(t.tile === t.pills, `${f.name}: tile ${t.tile}, drawn «На валідації» project pills ${t.pills}`)
    }
    for (const s of await stringsOf(page)) {
      strings++
      if (!passes(s)) unmatched.set(s, [...(unmatched.get(s) ?? []), f.name])
    }
  }
  check(
    tx.n > 0 && tx.fails.length === 0,
    `text contrast: ${tx.n} text nodes in ${all.length} frames, lowest ${(tx.worst * 100).toFixed(0)} % of the required ratio (${tx.worstAt}), ${tx.exempt} disabled exempt, ${tx.unmeasured} unmeasured, ${tx.fails.length} below the minimum${tx.fails.length ? ': ' + tx.fails.slice(0, 4).join(' | ') : ''}`,
  )
  check(
    nt.n > 0 && nt.fails.length === 0,
    `non-text contrast (3 : 1): ${nt.n} chart marks and progress fills in ${nt.frames} frames, lowest ${nt.worst.toFixed(2)} : 1 (${nt.worstAt}), ${nt.fails.length} below 3 : 1${nt.fails.length ? ': ' + [...new Set(nt.fails)].slice(0, 4).join(' | ') : ''}`,
  )
  check(
    rows.complete > 0 && rows.bad.length === 0,
    `receiver rows: ${rows.frames} frames with rows, ${rows.complete} complete rows (none a disclosure), ${rows.open} rows with open projects (each a button with aria-expanded), ${rows.bad.length} defects${rows.bad.length ? ': ' + rows.bad.slice(0, 4).join(' | ') : ''}`,
  )
  check(compared >= 2, `pending-validation tile: ${compared} frames expand every receiver and were compared (at least 2)`)
  console.log('\n== (10) String gate: every frame string against stats.md §2.6 ==')
  for (const [s, at] of unmatched) console.log(`  no row: "${s.slice(0, 90)}" (${at.length} frames, e.g. ${at[0]})`)
  check(
    strings > 0 && unmatched.size === 0,
    `strings: ${strings} visible strings and accessible names in ${all.length} frames, ${templates.length} template cells, ${unmatched.size} distinct strings without a §2.6 row`,
  )
}

// ---- (11) tablet hint popover ends above the series control (R4-04) ----
console.log('\n== (11) Tablet hint popover and plot bands ==')
{
  const page = await open('hint-popover-768')
  const g = await page.evaluate(() => {
    const box = (e) => e?.getBoundingClientRect()
    const dlg = box(document.querySelector('.device [role=dialog]'))
    const groups = [...document.querySelectorAll('.device [role=radiogroup]')].map(box)
    const series = groups.find((r) => r.top > dlg.top) ?? null
    const readout = box(document.querySelector('.device [aria-live]'))
    return { bottom: dlg.bottom, series: series?.top, readout: readout?.top }
  })
  check(
    g.series != null && g.bottom < g.series && g.bottom < g.readout,
    `hint-popover-768: popover bottom ${Math.round(g.bottom)} px, series control top ${Math.round(g.series)} px, readout top ${Math.round(g.readout)} px (popover ends above both)`,
  )
}
// ---- (12) plot band width under each class (R4-09): the band is the tap target of one month ----
for (const name of ['default-320', 'default-375', 'scrub-12m-375', 'all-375', 'all-320', 'default-768', 'all-768', 'all-1280']) {
  if (!byName[name]) continue
  const page = await open(name)
  const w = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.device svg[role=group] g[role=button] > rect[rx="4"]')]
    return b.length ? [b.length, Math.min(...b.map((x) => x.getBoundingClientRect().width))] : [0, 0]
  })
  check(w[0] > 0 && w[1] >= 24, `${name}: ${w[0]} bands drawn, narrowest ${w[1].toFixed(1)} px (at least 24 px, SC 2.5.8)`)
}

await browser.close()
console.log(
  `\nmeasure.mjs: ${checks} checks, ${failed} failed${failed ? '' : ' — all measured claims hold'}`,
)
process.exit(failed ? 1 : 0)
