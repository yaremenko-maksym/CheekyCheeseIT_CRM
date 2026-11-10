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
 * only INVOKED from here; none of its code is copied into this repository.
 *
 * Usage (run with apps/api's tsx, so fixtures.ts and the OpenResume TypeScript both load):
 *   NODE_OPTIONS=--conditions=source apps/api/node_modules/.bin/tsx \
 *     scripts/devops/openresume-oracle.mjs <openresume-dir> <pdf-dir>
 * The OpenResume dir needs `npm ci --ignore-scripts` (its own lockfile) first.
 *
 * Expectations come from apps/api/src/resumes/ats/__ats__/fixtures.ts (the single source); a PDF is
 * named `<template>.<fixture>.pdf` by the suite. Exit 1 on any miss, on zero PDFs, or on a PDF whose
 * fixture is unknown.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = join(ROOT, 'apps/api/node_modules/.bin/tsx')

// ── Child mode: runs with cwd = OpenResume checkout so its tsconfig `lib/*` paths resolve. ──
if (process.argv[2] === '--parse') {
  const [, , , orDir, pdfDir] = process.argv
  // pdfjs-dist 3.x fake-worker path: OpenResume sets workerSrc to the webpack worker entry, which
  // Node cannot load; a preloaded `globalThis.pdfjsWorker` is the documented Node fallback.
  globalThis.pdfjsWorker = createRequire(join(orDir, 'package.json'))(
    'pdfjs-dist/build/pdf.worker.js',
  )
  const { parseResumeFromPdf } = await import(
    pathToFileURL(join(orDir, 'src/app/lib/parse-resume-from-pdf/index.ts')).href
  )
  const out = {}
  for (const f of readdirSync(pdfDir)
    .filter((n) => n.endsWith('.pdf'))
    .sort()) {
    const r = await parseResumeFromPdf(join(pdfDir, f))
    out[f] = {
      name: r.profile.name,
      email: r.profile.email,
      jobs: r.workExperiences.map((w) => ({
        company: w.company,
        role: w.jobTitle,
        period: w.date,
      })),
    }
  }
  process.stdout.write(JSON.stringify(out))
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

const pdfs = readdirSync(pdfDir).filter((n) => n.endsWith('.pdf'))
if (pdfs.length === 0) {
  console.error(
    `::error::openresume-oracle: no PDFs in ${pdfDir} — the suite did not write the matrix`,
  )
  process.exit(1)
}

const child = spawnSync(TSX, [fileURLToPath(import.meta.url), '--parse', orDir, pdfDir], {
  cwd: orDir,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (child.status !== 0) {
  console.error(
    `::error::openresume-oracle: OpenResume parser exited ${child.status ?? child.signal}`,
  )
  process.exit(1)
}
const parsed = JSON.parse(child.stdout)

const { ATS_FIXTURES } = await import(
  pathToFileURL(join(ROOT, 'apps/api/src/resumes/ats/__ats__/fixtures.ts')).href
)
const byName = new Map(ATS_FIXTURES.map((f) => [f.name, f]))
const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()

const failures = []
for (const [file, got] of Object.entries(parsed)) {
  const fixtureName = file
    .replace(/\.pdf$/, '')
    .split('.')
    .slice(1)
    .join('.')
  const fx = byName.get(fixtureName)
  if (!fx) {
    failures.push(`${file}: unknown fixture "${fixtureName}"`)
    continue
  }
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

const n = Object.keys(parsed).length
if (n !== pdfs.length) failures.push(`parsed ${n} PDFs, found ${pdfs.length}`)
for (const f of failures) console.error(`::error::${f}`)
console.log(`openresume-oracle: ${n} PDFs parsed, ${failures.length} failure(s)`)
process.exit(failures.length === 0 ? 0 : 1)
