// Unit tests for scripts/architect/review-gate.mjs — run with `node --test scripts/architect/`.
// CI: .github/workflows/architect-scripts.yml.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluate,
  isDocsOnly,
  parseVerdict,
  parseSkipReason,
  FAIL_MESSAGE,
} from './review-gate.mjs'

const review = (over = {}) => ({
  author: 'some-reviewer',
  state: 'COMMENTED',
  body: 'Verdict: APPROVE\n\nLooks good.',
  submitted_at: '2026-10-21T10:00:00Z',
  ...over,
})

const pr = (over = {}) => ({
  files: ['apps/api/src/finance/transactions.service.ts'],
  reviews: [],
  labels: [],
  body: '',
  ...over,
})

const REASON = 'Skip-Review-Reason: hotfix for a broken deploy, reviewed live with the owner'

// --- the cases named by the decision -----------------------------------------------------------

test('nothing (code diff, no review, no label) → fail with the instruction message', () => {
  const r = evaluate(pr())
  assert.equal(r.pass, false)
  assert.equal(r.missing[0], FAIL_MESSAGE)
  assert.equal(r.missing.length, 1)
})

test('docs-only diff → pass', () => {
  const r = evaluate(
    pr({ files: ['docs/architecture/x.md', '.claude/rules/common/y.md', 'README.md'] }),
  )
  assert.equal(r.pass, true)
  assert.equal(r.via, 'docs-only')
})

test('verdict APPROVE → pass', () => {
  const r = evaluate(pr({ reviews: [review()] }))
  assert.equal(r.pass, true)
  assert.equal(r.via, 'verdict')
  assert.match(r.reason, /@some-reviewer/)
})

test('BLOCK after APPROVE → fail, and the detail names the block', () => {
  const r = evaluate(
    pr({
      reviews: [
        review(),
        review({ body: 'Verdict: BLOCK\n\nCR-H-1', submitted_at: '2026-10-21T11:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(
    r.missing[1],
    /`Verdict: BLOCK` by @some-reviewer \(2026-10-21T11:00:00Z\) came after/,
  )
})

test('BLOCK, then a newer APPROVE → pass (the block is superseded)', () => {
  const r = evaluate(
    pr({
      reviews: [
        review({ body: 'Verdict: BLOCK', submitted_at: '2026-10-21T09:00:00Z' }),
        review({ submitted_at: '2026-10-21T12:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, true)
})

test('label skip-review without a reason → fail', () => {
  const r = evaluate(pr({ labels: ['skip-review'] }))
  assert.equal(r.pass, false)
  assert.match(r.missing[1], /no `Skip-Review-Reason: <why>` line/)
})

test('reason without the label → fail', () => {
  const r = evaluate(pr({ body: `Summary\n\n${REASON}\n` }))
  assert.equal(r.pass, false)
  assert.match(r.missing[1], /label `skip-review` is not set/)
})

test('label + reason → pass, and the reason is echoed', () => {
  const r = evaluate(pr({ labels: ['skip-review'], body: `Summary\n\n${REASON}\n` }))
  assert.equal(r.pass, true)
  assert.equal(r.via, 'skip-review')
  assert.match(r.reason, /hotfix for a broken deploy/)
})

// --- edges --------------------------------------------------------------------------------------

test('label + a reason shorter than 10 characters → fail', () => {
  const r = evaluate(pr({ labels: ['skip-review'], body: 'Skip-Review-Reason: trivial' }))
  assert.equal(r.pass, false)
  assert.match(r.missing[1], /shorter than 10 characters/)
})

test('reason key is case-insensitive and may be indented', () => {
  const r = evaluate(
    pr({ labels: ['skip-review'], body: '  skip-review-REASON:   typo fix in a log line' }),
  )
  assert.equal(r.pass, true)
})

test('a reason key in the middle of a line is not the reason line', () => {
  assert.equal(parseSkipReason('see Skip-Review-Reason: nothing here'), null)
})

test('one non-docs path makes the diff non-docs', () => {
  assert.equal(isDocsOnly(['docs/a.md', 'apps/web/app/x.tsx']), false)
  assert.equal(isDocsOnly(['.claude/hooks/pre-bash-x.sh']), true) // .claude/** is light-track meta
  assert.equal(isDocsOnly(['docs/diagram.png']), false)
})

test('a DISMISSED approval does not count', () => {
  assert.equal(evaluate(pr({ reviews: [review({ state: 'DISMISSED' })] })).pass, false)
})

test('a DISMISSED BLOCK still blocks', () => {
  const r = evaluate(
    pr({
      reviews: [
        review(),
        review({
          state: 'DISMISSED',
          body: 'Verdict: BLOCK',
          submitted_at: '2026-10-21T11:00:00Z',
        }),
      ],
    }),
  )
  assert.equal(r.pass, false)
})

test('a PENDING (unsubmitted) review does not count', () => {
  assert.equal(evaluate(pr({ reviews: [review({ state: 'PENDING' })] })).pass, false)
})

test('a verdict quoted mid-sentence is not a verdict', () => {
  const r = evaluate(
    pr({ reviews: [review({ body: 'I would give Verdict: APPROVE once fixed.' })] }),
  )
  assert.equal(r.pass, false)
})

test('a BLOCK after APPROVE still allows the skip-review path when recorded', () => {
  const r = evaluate(
    pr({
      reviews: [review(), review({ body: 'Verdict: BLOCK', submitted_at: '2026-10-21T11:00:00Z' })],
      labels: ['skip-review'],
      body: REASON,
    }),
  )
  assert.equal(r.pass, true)
  assert.equal(r.via, 'skip-review')
})

test('parseVerdict tolerates markdown decoration and takes the first marker', () => {
  assert.equal(parseVerdict('**Verdict: APPROVE**'), 'APPROVE')
  assert.equal(
    parseVerdict('## Code review\n\nVerdict: BLOCK\n\nthe old Verdict: APPROVE'),
    'BLOCK',
  )
  assert.equal(parseVerdict('Security Review: APPROVE'), null)
  assert.equal(parseVerdict(null), null)
})

test('malformed input throws instead of passing (empty file list = the fetch did not run)', () => {
  assert.throws(() => evaluate(pr({ files: [] })), /files is empty/)
  assert.throws(() => evaluate({ ...pr(), reviews: undefined }), /reviews must be an array/)
  assert.throws(() => evaluate({ ...pr(), body: null }), /body must be a string/)
})

// --- CLI: exit status and the artifacts it writes ----------------------------------------------

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'review-gate.mjs')
const runCli = (data) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-gate-'))
  const input = join(dir, 'in.json')
  const summary = join(dir, 'summary.md')
  writeFileSync(input, typeof data === 'string' ? data : JSON.stringify(data))
  const res = spawnSync(process.execPath, [SCRIPT, '--input', input, '--summary', summary], {
    encoding: 'utf8',
  })
  let sum = ''
  try {
    sum = readFileSync(summary, 'utf8')
  } catch {}
  return { ...res, sum }
}

test('CLI: PASS exits 0 and the summary names the path taken and echoes the reason', () => {
  const r = runCli(pr({ labels: ['skip-review'], body: REASON }))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.sum, /## Review Gate: PASS/)
  assert.match(r.sum, /passed via \*\*skip-review\*\* — review skipped on purpose: hotfix/)
})

test('CLI: FAIL exits 1 and prints the instruction as an ::error:: line', () => {
  const r = runCli(pr())
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^::error title=Review Gate::No reviewer verdict\./m)
  assert.match(r.sum, /## Review Gate: FAIL/)
})

test('CLI: malformed input exits 2, never 0', () => {
  assert.equal(runCli('{not json').status, 2)
  assert.equal(runCli(pr({ files: [] })).status, 2)
})
