// Council r4 (R3-18): every visible string in a frame must have a uk + en row in primitives-v2 §12 Strings.
// Usage: node strings.mjs <shell|primitives> [frame-name-filter]   (same env as measure.mjs)
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
const mod = await import(pathToFileURL(join(here, `${set}.mjs`)).href)

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
const emptyEn = rows.filter((r) => r[1] && !r[2])
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
const exact = new Set()
const wild = []
for (const [, uk] of rows)
  for (const raw of uk.split(/\s·\s/)) {
    for (const alt of raw.split(/\s\/\s/)) {
      const t = norm(alt.replace(/\s\((one|few|many|other)\)$/, ''))
      if (!t) continue
      if (t.includes('{'))
        wild.push(
          new RegExp(
            `^${t
              .replace(/[.*+?^$()[\]\\|]/g, '\\$&')
              .replace(/\{([^}]+)\}/g, (_, p) => (NUMERIC.has(p) ? NUM_PART : '.+?'))}$`,
          ),
        )
      else exact.add(t)
    }
  }
const covered = (t) => exact.has(t) || wild.some((re) => re.test(t))

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
    let b = el
    while (b.parentElement && inline(b) && b.parentElement !== document.body) b = b.parentElement
    if (taken.has(b)) continue
    taken.add(b)
    // Child blocks are read on their own: take only this block's inline text.
    const text = [...b.childNodes]
      .map((n) =>
        n.nodeType === 3 ? n.textContent : n.nodeType === 1 && inline(n) ? n.textContent : '\n',
      )
      .join('')
    out.push(text)
  }
  return out
}

// A diagram of scaled-down screens with motion annotations, not UI at 1:1 (as in measure.mjs).
const DIAGRAM = new Set(['transition-storyboard'])
const frames = mod
  .frames()
  .filter((f) => (!filter || f.name.includes(filter)) && !DIAGRAM.has(f.name))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const missing = new Map()
let nBlocks = 0
let nTokens = 0
for (const f of frames) {
  const page = await browser.newPage({ viewport: { width: f.w, height: f.h } })
  await page.setContent(f.html, { waitUntil: 'networkidle' })
  for (const b of await page.evaluate(blocks)) {
    nBlocks++
    for (const line of b.split('\n'))
      for (const t of split(line)) {
        nTokens++
        if (isData(t) || covered(t)) continue
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
for (const r of emptyEn) console.log(`no en    «${r[1]}»`)
console.log(
  `strings: ${frames.length} frames · ${nBlocks} text blocks · ${nTokens} strings read · table ${rows.length} rows, ${exact.size + wild.length} tokens · missing ${missing.size} · rows without en ${emptyEn.length}`,
)
process.exitCode = missing.size || emptyEn.length || !rows.length || !nTokens ? 1 : 0
