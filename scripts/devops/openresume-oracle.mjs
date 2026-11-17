#!/usr/bin/env node
/**
 * openresume-oracle.mjs — an external parser reads our résumé PDFs (verified-base-resume Task 8).
 *
 * The ATS suite (`pnpm --filter @crm/api test:ats`) checks our PDFs with our own text extraction.
 * This is the second opinion: OpenResume's `parse-resume-from-pdf` (a third-party, browser-oriented
 * ATS-style parser) reads every matrix PDF and must recover, per fixture, the name, the email, and
 * for every job its company, role and period.
 *
 * LICENCE: OpenResume is AGPL-3.0. It is checked out by CI into $RUNNER_TEMP at a pinned sha and
 * only INVOKED from here (its exported functions are called); none of its code is in this repository.
 *
 * Usage (run with apps/api's tsx, so fixtures.ts and the OpenResume TypeScript both load):
 *   NODE_OPTIONS=--conditions=source apps/api/node_modules/.bin/tsx \
 *     scripts/devops/openresume-oracle.mjs <openresume-dir> <pdf-dir>
 * The OpenResume dir needs `npm ci --ignore-scripts` (its own lockfile) first.
 *
 * Expectations come from apps/api/src/resumes/ats/__ats__/fixtures.ts (the single source), passed
 * through `toRenderableDeep` exactly as the suite does; a PDF is named `<template>.<fixture>.pdf`.
 * Exit 1 on any miss, or when the PDF set is not exactly RESUME_TEMPLATE_NAMES × fixtures.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = join(ROOT, 'apps/api/node_modules/.bin/tsx')

// ── Child mode: runs with cwd = OpenResume checkout so its tsconfig `lib/*` paths resolve. ──
if (process.argv[2] === '--parse') {
  const [, , , orDir, pdfDir, outFile] = process.argv
  const req = createRequire(join(orDir, 'package.json'))
  // pdfjs-dist 3.x fake-worker path: OpenResume sets workerSrc to the webpack worker entry, which
  // Node cannot load; a preloaded `globalThis.pdfjsWorker` is the documented Node fallback.
  globalThis.pdfjsWorker = req('pdfjs-dist/build/pdf.worker.js')
  const pdfjs = req('pdfjs-dist')
  const lib = (p) => import(pathToFileURL(join(orDir, 'src/app/lib/parse-resume-from-pdf', p)).href)
  const { readPdf } = await lib('read-pdf.ts')
  const { groupTextItemsIntoLines } = await lib('group-text-items-into-lines.ts')
  const { groupLinesIntoSections } = await lib('group-lines-into-sections.ts')
  const { extractResumeFromSections } = await lib('extract-resume-from-sections/index.ts')

  const out = {}
  for (const f of readdirSync(pdfDir)
    .filter((n) => n.endsWith('.pdf'))
    .sort()) {
    const path = join(pdfDir, f)
    const items = await readPdf(path)
    // Page-boundary shim (ruling R10b). pdfjs-dist 3.7.107 never sets `hasEOL` on a page's LAST text
    // item (it flushes without appendEOL at the end of the content stream), and OpenResume's readPdf
    // concatenates all pages with no separator; groupTextItemsIntoLines breaks only on `hasEOL`, so
    // page 1's last line fuses with page 2's first line ("Mentored two engineersJunior Developer")
    // and the job whose role starts page 2 is lost. Repro: a 2-page Typst doc with a plain
    // `#pagebreak()` fuses too (/tmp/vbr8b/min/v0.typ, VBR Task 8b report). Real extractors emit a
    // page break, so we mark each page's last item end-of-line. Page boundaries come from pdfjs's
    // own per-page item counts (readPdf maps them 1:1), so grouping inside a page is untouched.
    const doc = await pdfjs.getDocument(path).promise
    let end = 0
    let pageBreaks = 0
    for (let p = 1; p <= doc.numPages; p++) {
      const page = (await (await doc.getPage(p)).getTextContent()).items
      // readPdf drops whitespace-only items without EOL; count what it keeps.
      end += page.filter((t) => t.hasEOL || t.str.trim() !== '').length
      if (p < doc.numPages && end > 0) {
        items[end - 1].hasEOL = true
        pageBreaks++
      }
    }
    await doc.destroy()
    if (end !== items.length)
      throw new Error(`${f}: pdfjs counted ${end} items, readPdf ${items.length}`)
    const r = extractResumeFromSections(groupLinesIntoSections(groupTextItemsIntoLines(items)))
    out[f] = {
      pageBreaks,
      name: r.profile.name,
      email: r.profile.email,
      jobs: r.workExperiences.map((w) => ({
        company: w.company,
        role: w.jobTitle,
        period: w.date,
      })),
    }
  }
  // A file, not stdout: pdfjs prints `Warning: ...` through console.log, which would corrupt JSON.
  writeFileSync(outFile, JSON.stringify(out))
  process.exit(0)
}

// ── Parent mode ──
const [orDirArg, pdfDirArg] = process.argv.slice(2)
if (!orDirArg || !pdfDirArg) {
  console.error('usage: openresume-oracle.mjs <openresume-dir> <pdf-dir>')
  process.exit(2)
}
const orDir = resolve(orDirArg)
const pdfDir = resolve(pdfDirArg)

const { ATS_FIXTURES } = await import(
  pathToFileURL(join(ROOT, 'apps/api/src/resumes/ats/__ats__/fixtures.ts')).href
)
const { toRenderableDeep } = await import(
  pathToFileURL(join(ROOT, 'apps/api/src/resumes/resume-glyphs.ts')).href
)
// Resolved from apps/api (the root has no @crm/shared link); `--conditions=source` picks its TS source.
const { RESUME_TEMPLATE_NAMES } = await import(
  pathToFileURL(createRequire(join(ROOT, 'apps/api/package.json')).resolve('@crm/shared')).href
)

// shortcut: OpenResume (like our own equivalence parser) cannot split a wrapped role from its
// company; upgrade when a parser can
const SKIP_FIXTURES = new Set(['long-names-wrapped'])

const failures = []
// Vacuity guard: the PDF set must be exactly the full matrix, not merely non-empty.
const expectedFiles = RESUME_TEMPLATE_NAMES.flatMap((t) =>
  ATS_FIXTURES.map((fx) => `${t}.${fx.name}.pdf`),
)
const present = new Set(readdirSync(pdfDir).filter((n) => n.endsWith('.pdf')))
for (const f of expectedFiles) if (!present.has(f)) failures.push(`missing matrix PDF ${f}`)
for (const f of present) if (!expectedFiles.includes(f)) failures.push(`unexpected PDF ${f}`)

const outFile = join(mkdtempSync(join(tmpdir(), 'openresume-oracle-')), 'parsed.json')
const child = spawnSync(TSX, [fileURLToPath(import.meta.url), '--parse', orDir, pdfDir, outFile], {
  cwd: orDir,
  stdio: ['ignore', 'inherit', 'inherit'],
})
if (child.status !== 0) {
  console.error(
    `::error::openresume-oracle: OpenResume parser exited ${child.status ?? child.signal}`,
  )
  process.exit(1)
}
const parsed = JSON.parse(readFileSync(outFile, 'utf8'))

const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
let asserted = 0
let skipped = 0
for (const file of expectedFiles.filter((f) => present.has(f))) {
  const got = parsed[file]
  if (!got) {
    failures.push(`${file}: not parsed`)
    continue
  }
  const [template, fixtureName] = file.replace(/\.pdf$/, '').split('.')
  if (SKIP_FIXTURES.has(fixtureName)) {
    skipped++
    continue
  }
  asserted++
  const raw = ATS_FIXTURES.find((f) => f.name === fixtureName)
  const fx = toRenderableDeep(
    { displayName: raw.displayName, email: raw.email, content: raw.content },
    template,
  ).value
  if (norm(got.name) !== norm(fx.displayName))
    failures.push(`${file}: name ${JSON.stringify(got.name)} != ${JSON.stringify(fx.displayName)}`)
  if (norm(got.email) !== norm(fx.email))
    failures.push(`${file}: email ${JSON.stringify(got.email)} != ${JSON.stringify(fx.email)}`)
  for (const job of fx.content.experience) {
    const want = { company: norm(job.company), role: norm(job.role), period: norm(job.period) }
    const hit = got.jobs.some(
      (j) =>
        norm(j.company) === want.company &&
        norm(j.role) === want.role &&
        norm(j.period) === want.period,
    )
    if (!hit)
      failures.push(
        `${file}: job not recovered ${JSON.stringify(want)}; parsed ${JSON.stringify(got.jobs)}`,
      )
  }
}

// Self-check of the page-boundary shim: these PDFs are 2 pages and a job's role starts page 2.
// The shim must have marked a boundary in each, and that page-2 job must be among the parsed jobs.
const PAGE2_JOB = {
  'classic.career-15y.pdf': 'Willowmere Media',
  'modern.career-15y.pdf': 'Willowmere Media',
  'technical.career-15y.pdf': 'Ironbark Studio',
}
for (const [file, company] of Object.entries(PAGE2_JOB)) {
  const got = parsed[file]
  if (!got || got.pageBreaks < 1 || !got.jobs.some((j) => norm(j.company) === company))
    failures.push(`page-boundary shim self-check: ${file} lost the page-2 job "${company}"`)
}

for (const f of failures) console.error(`::error::${f}`)
console.log(
  `openresume-oracle: ${asserted} PDFs asserted, ${skipped} skipped (${[...SKIP_FIXTURES].join(', ')}), ${failures.length} failure(s)`,
)
process.exit(failures.length === 0 && asserted > 0 ? 0 : 1)
