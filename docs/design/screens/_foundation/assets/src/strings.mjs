// Council r4 (R3-18): every visible string in a frame must have a uk + en row in primitives-v2 §12 Strings.
// r5 (R4-11): both directions and the uk <-> en pairing, by the table's stable `ID` column:
//   frame -> table  every rendered string is covered by a row (as before) whose en cell is filled;
//   table -> frame  every uk token of a row is drawn in some frame, unless the row's Kind is `interaction`
//                   (an announcement, an accessible name, a state no frame draws) — only with set `all`;
//   uk <-> en       per row: the same number of « · » parts and « / » alternatives (plural tags collapsed)
//                   and the same {placeholders}.
// r6 (R5-18, R5-28): `two ways` — one string drawn with two texts that differ only by a trailing «…», «.» or «:»;
//   `dangling` — a rendered line that ends on «·» (per frame, from the text's Range rects).
// Usage: node strings.mjs <shell|primitives|all> [frame-name-filter]   (same env as measure.mjs)
// Reads the uk and en columns of the §12 Strings table, renders each frame, collects every visible text block
// (drawn OS chrome and [data-note] captions exempt), splits it on « · », drops pure numbers / amounts / times /
// dates, and drops fixture data (FIXTURE below: names, descriptions, projects — record data, not product copy).
// A string is covered when it equals a table token or matches a `{placeholder}` token. Prints the missing
// strings with the frames that draw them, then one count line. Exit 1 on any missing string, an empty
// table, or a row whose en cell is empty.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FIXTURE, NOTE } from './strings-fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const [set, filter] = process.argv.slice(2)
const sets = set === 'all' ? ['shell', 'primitives'] : [set]
const mods = await Promise.all(sets.map((x) => import(pathToFileURL(join(here, `${x}.mjs`)).href)))

const norm = (s) => s.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim()
// « · » separates strings; a trailing «·» (a wrapped meta line) is dropped.
const split = (s) =>
  norm(s)
    .split(/\s·\s|\s·$|^·\s/)
    .map((t) => t.trim())
    .filter(Boolean)

// ---- the table -------------------------------------------------------------------------------------------
const md = readFileSync(join(here, '../../primitives-v2.md'), 'utf8')
const start = md.indexOf('### Strings (F0-27)')
const end = md.indexOf('\n### ', start + 10)
const rows = md
  .slice(start, end)
  .split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
  .slice(1) // header
  .map((l) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim()),
  )
  // ID | Where | uk | en | Kind  ->  [uk, en, id, kind]  (uk / en keep their old indexes 1 / 2 below)
  .map(([id, , uk, en, kind]) => [id.replace(/`/g, ''), uk, en, kind])
const emptyEn = rows.filter((r) => r[1] && !r[2])
const dupId = rows.filter((r, i) => rows.findIndex((q) => q[0] === r[0]) !== i)
// A numeric placeholder matches a number, an amount with its code, a time, a date or a percentage only,
// so «{n} хв» never covers a word; every other placeholder ({name}, {title}, {query}…) matches any text.
const NUMERIC = new Set([
  'n',
  'total',
  'time',
  'amount',
  'pct',
  'count',
  'd',
  'date',
  'size',
  'left',
])
const NUM_PART = '[−+]?[\\d .,:%]+(?: ?(?:USD|USDT|UAH|EUR|МБ|с))?'
const exact = new Map() // token -> row ids
const wild = [] // [regexp, row id]
const tokensOf = new Map() // row id -> its uk tokens
for (const [id, uk] of rows)
  for (const raw of uk.split(/\s·\s/)) {
    for (const alt of raw.split(/\s\/\s/)) {
      const t = norm(alt.replace(/\s\((one|few|many|other)\)$/, ''))
      if (!t) continue
      if (!tokensOf.has(id)) tokensOf.set(id, [])
      tokensOf.get(id).push(t)
      if (t.includes('{'))
        wild.push([
          new RegExp(
            `^${t
              .replace(/[.*+?^$()[\]\\|]/g, '\\$&')
              .replace(/\{([^}]+)\}/g, (_, p) => (NUMERIC.has(p) ? NUM_PART : '.+?'))}$`,
          ),
          id,
          t,
        ])
      else exact.set(t, [...(exact.get(t) || []), id])
    }
  }
const used = new Set() // `${id}\u0000${token}` drawn somewhere
// Returns the covering row ids (empty = not covered) and records which table tokens were drawn.
const cover = (t) => {
  const ids = [...(exact.get(t) || [])]
  for (const id of ids) used.add(`${id}\u0000${t}`)
  for (const [re, id, tok] of wild)
    if (re.test(t)) {
      ids.push(id)
      used.add(`${id}\u0000${tok}`)
    }
  return ids
}
// uk <-> en pairing: parts, alternatives (plural tags collapsed) and placeholders per row.
const shape = (cell) => {
  const parts = cell.split(/\s·\s/)
  const alts = parts.map(
    (p) =>
      new Set(p.split(/\s\/\s/).map((a) => a.replace(/\s\((one|few|many|other)\)$/, '#'))).size,
  )
  const ph = [...new Set([...cell.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]))].sort().join(',')
  return { n: parts.length, alts: alts.join(','), ph }
}
const unpaired = rows.filter(([, uk, en]) => {
  if (!uk || !en) return false
  const a = shape(uk)
  const b = shape(en)
  return a.n !== b.n || a.ph !== b.ph
})

// ---- data that is not copy -------------------------------------------------------------------------------
const NUM =
  /^[−+-]?\s?[\d\s.,:%×/]+\s?(USD|USDT|UAH|EUR|МБ|КБ|px|ГБ|грн|₴|\$)?[.,]?$|^[\d\s.,:%−+-]*(USD|USDT|UAH)$|^\d{1,2}:\d{2}(:\d{2})?$|^\d{1,2}\.\d{1,2}(\.\d{4})?$/
// Intl-formatted dates (a month or weekday name with digits, «вер», «I кв», «Пн») and key caps are values, not catalog strings.
const MON =
  'січ|лют|бер|квіт|трав|черв|лип|серп|вер|жовт|лист|груд|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня'
const NOM =
  'Січень|Лютий|Березень|Квітень|Травень|Червень|Липень|Серпень|Вересень|Жовтень|Листопад|Грудень'
const DATE = new RegExp(
  `^((\\d{1,2} )?(${MON})\\.?( \\d{4})?(, \\d{1,2}:\\d{2})?|(${NOM})( \\d{4})?|(${NOM}) – (${MON}|листопад) \\d{4}|I{1,3} кв|IV кв|Пн|Вт|Ср|Чт|Пт|Сб|Нд)$`,
)
const KEY = /^(⌘|Ctrl|Esc|Enter|Shift|Tab|[A-Z]|⌘[A-Z↵]|⌘ \/ Ctrl|[↑↓←→↵?/])$/
const isData = (t) =>
  NUM.test(t) ||
  DATE.test(t) ||
  KEY.test(t) ||
  FIXTURE.has(t) ||
  /^\{\{\w+\}\}/.test(t) || // a document template with {{variables}} is record data, not copy
  NOTE.has(t) ||
  !/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(t)

// ---- the frames ------------------------------------------------------------------------------------------
function blocks() {
  const OS = '.status,.kbd,.kbar,.homebar,[data-note]'
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return (
      r.width > 1 &&
      r.height > 1 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      Number(cs.opacity) > 0
    )
  }
  const own = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
  // Only plain inline elements join a string; an inline-flex button or chip is a string of its own.
  const inline = (el) => getComputedStyle(el).display === 'inline'
  const out = []
  const taken = new Set()
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(OS) || !vis(el) || !own(el) || /^(STYLE|SCRIPT|SVG)$/i.test(el.tagName)) continue
    // The text block is the nearest ancestor-or-self that is not inline, so «Збережеться <span>−1 250,50 USD</span> …» is one string.
    let b = el.closest('[data-file]') || el // R4-16: a middle-ellipsized file name is one string
    while (b.parentElement && inline(b) && b.parentElement !== document.body) b = b.parentElement
    if (taken.has(b)) continue
    taken.add(b)
    // Child blocks are read on their own: take only this block's inline text.
    const text = b.matches('[data-file]')
      ? b.textContent
      : [...b.childNodes]
          .map((n) =>
            n.nodeType === 3 ? n.textContent : n.nodeType === 1 && inline(n) ? n.textContent : '\n',
          )
          .join('')
    out.push(text)
  }
  return out
}

// r6 (R5-28): a rendered line that ends on «·» (the separator binds to the next item, primitives-v2 §12.0).
function dangling() {
  const OS = '.status,.kbd,.kbar,.homebar,[data-note],[aria-hidden="true"]'
  const out = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement
    if (!el || el.closest(OS) || /^(STYLE|SCRIPT)$/.test(el.tagName)) continue
    const t = n.textContent
    for (let i = t.indexOf('·'); i !== -1; i = t.indexOf('·', i + 1)) {
      const j = t.slice(i + 1).search(/[^\s\u00a0]/)
      if (j === -1) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + 1)
      const a = r.getBoundingClientRect()
      r.setStart(n, i + 1 + j)
      r.setEnd(n, i + 2 + j)
      const b = r.getBoundingClientRect()
      if (a.width && b.width && b.top > a.top + a.height / 2)
        out.push(t.slice(Math.max(0, i - 24), i + 1).replace(/\s+/g, ' '))
    }
  }
  return out
}

// A diagram of scaled-down screens with motion annotations, not UI at 1:1 (as in measure.mjs).
const DIAGRAM = new Set(['transition-storyboard'])
const frames = mods
  .flatMap((m) => m.frames())
  .filter((f) => (!filter || f.name.includes(filter)) && !DIAGRAM.has(f.name))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const missing = new Map()
const dangles = new Map() // frame -> lines ending on «·»
// r6 (R5-18): one string per ID — two drawn texts that differ only by a trailing «…», «.» or «:» are one
// string drawn two ways («Видалити…» / «Видалити»); pick one.
const variants = new Map() // normalised -> Set of drawn texts
const vkey = (t) => t.replace(/[….:]+$/, '').trim()
const noEnDrawn = new Set()
let nBlocks = 0
let nTokens = 0
for (const f of frames) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } })
  await page.setContent(f.html, { waitUntil: 'networkidle' })
  const dl = await page.evaluate(dangling)
  if (dl.length) dangles.set(f.name, dl)
  for (const b of await page.evaluate(blocks)) {
    nBlocks++
    for (const line of b.split('\n'))
      for (const t of split(line)) {
        nTokens++
        if (isData(t)) {
          cover(t) // a drawn value («62%») still marks its table token as used
          continue
        }
        const ids = cover(t)
        if (!variants.has(vkey(t))) variants.set(vkey(t), new Set())
        variants.get(vkey(t)).add(t)
        if (ids.length) {
          if (!ids.some((id) => rows.find((r) => r[0] === id)?.[2])) noEnDrawn.add(t)
          continue
        }
        if (!missing.has(t)) missing.set(t, new Set())
        missing.get(t).add(f.name)
      }
  }
  await page.close()
}
await browser.close()
for (const [t, fs] of [...missing].sort((a, b) => a[0].localeCompare(b[0], 'uk')))
  console.log(
    `missing  «${t}»  ${[...fs].slice(0, 3).join(', ')}${fs.size > 3 ? ` +${fs.size - 3}` : ''}`,
  )
for (const r of emptyEn) console.log(`no en    ${r[0]} «${r[1]}»`)
for (const t of noEnDrawn) console.log(`drawn, no en  «${t}»`)
for (const r of unpaired) console.log(`unpaired ${r[0]}  uk «${r[1]}»  en «${r[2]}»`)
for (const r of dupId) console.log(`dup id   ${r[0]}`)
const twoWays = [...variants.values()].filter((v) => v.size > 1)
for (const v of twoWays) console.log(`two ways «${[...v].join('» / «')}»`)
for (const [fr, l] of dangles) console.log(`dangling ${fr}: «${l.slice(0, 2).join('» «')}»${l.length > 2 ? ` +${l.length - 2}` : ''}`)
// table -> frame: only meaningful over every frame of both sets.
const full = set === 'all' && !filter
const interaction = rows.filter((r) => r[3] === 'interaction')
const unused = full
  ? rows.filter(
      ([id, , , kind]) =>
        kind !== 'interaction' &&
        (tokensOf.get(id) || []).some((t) => !used.has(`${id}\u0000${t}`)),
    )
  : []
for (const [id, uk] of unused) {
  const miss = tokensOf.get(id).filter((t) => !used.has(`${id}\u0000${t}`))
  console.log(`unused   ${id}  «${miss.join('» «')}»`)
}
const nTok = [...tokensOf.values()].reduce((n, v) => n + v.length, 0)
console.log(
  `strings ${set}: ${frames.length} frames · ${nBlocks} text blocks · ${nTokens} strings read · table ${rows.length} rows, ${nTok} tokens\n` +
    `  frame -> table: missing ${missing.size} · drawn without en ${noEnDrawn.size}\n` +
    `  table -> frame: ${full ? `rows with an undrawn token ${unused.length} · interaction-only rows ${interaction.length}` : 'n/a (run with set all, no filter)'}\n` +
    `  uk <-> en: rows without en ${emptyEn.length} · unpaired rows ${unpaired.length} · duplicate ids ${dupId.length}\n` +
    `  drawn: one string two ways ${twoWays.length} · frames with a line ending on «·» ${dangles.size}`,
)
process.exitCode =
  missing.size ||
  noEnDrawn.size ||
  emptyEn.length ||
  unpaired.length ||
  dupId.length ||
  twoWays.length ||
  dangles.size ||
  unused.length ||
  !rows.length ||
  !nTokens
    ? 1
    : 0
