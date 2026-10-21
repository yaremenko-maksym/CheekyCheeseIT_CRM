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
  criticalPaths,
  globToRegExp,
  parseVerdicts,
  CRITICAL_PATH_GLOBS,
} from './review-gate.mjs'

const OWNER = 'repo-owner'
const COLLAB = 'collaborator'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)

const review = (over = {}) => ({
  author: OWNER,
  state: 'COMMENTED',
  body: 'Verdict: APPROVE\n\nLooks good.',
  commit_id: HEAD,
  submitted_at: '2026-10-21T10:00:00Z',
  ...over,
})

const pr = (over = {}) => ({
  author: COLLAB,
  owner: OWNER,
  headSha: HEAD,
  files: ['apps/web/app/components/Button.tsx'],
  reviews: [],
  labels: [],
  labelEvents: [],
  ...over,
})

const SEC_APPROVE = review({
  body: 'Security Review: APPROVE\n\nOWASP checklist passed.',
  submitted_at: '2026-10-21T10:05:00Z',
})

// --- the cases the task file names -------------------------------------------------------------

test('owner author → pass, even with no reviews and critical paths', () => {
  const r = evaluate(pr({ author: OWNER, files: ['apps/api/src/finance/x.ts'] }))
  assert.equal(r.pass, true)
  assert.deepEqual(r.missing, [])
})

test('owner login comparison is case-insensitive', () => {
  assert.equal(evaluate(pr({ author: 'Repo-Owner' })).pass, true)
})

test('collaborator, no reviews → fail naming the missing code review', () => {
  const r = evaluate(pr())
  assert.equal(r.pass, false)
  assert.equal(r.missing.length, 1)
  assert.match(r.missing[0], /no review by @repo-owner with `Verdict: APPROVE`/)
})

test('approve on an old sha → fail, and the message says it is stale', () => {
  const r = evaluate(pr({ reviews: [review({ commit_id: OLD })] }))
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /older commit \(bbbbbbb\)/)
})

test('approve on head → pass for non-critical paths', () => {
  const r = evaluate(pr({ reviews: [review()] }))
  assert.equal(r.pass, true, r.missing.join('\n'))
  assert.equal(r.critical.length, 0)
})

test('critical path without security approve → fail', () => {
  const r = evaluate(
    pr({ files: ['apps/api/src/finance/transactions.service.ts'], reviews: [review()] }),
  )
  assert.equal(r.pass, false)
  assert.equal(r.missing.length, 1)
  assert.match(r.missing[0], /security review \(critical-path files changed\)/)
})

test('critical path with security approve on head → pass', () => {
  const r = evaluate(
    pr({
      files: ['apps/api/src/finance/transactions.service.ts'],
      reviews: [review(), SEC_APPROVE],
    }),
  )
  assert.equal(r.pass, true, r.missing.join('\n'))
})

test('critical path with security approve on an OLD sha → fail', () => {
  const r = evaluate(
    pr({
      files: ['apps/api/drizzle/manual/2026-10-21_x.sql'],
      reviews: [review(), { ...SEC_APPROVE, commit_id: OLD }],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /Security Review: APPROVE`? is on an older commit/)
})

test('BLOCK after APPROVE → fail', () => {
  const r = evaluate(
    pr({
      reviews: [
        review(),
        review({ body: 'Verdict: BLOCK\n\nCR-H-1 ...', submitted_at: '2026-10-21T11:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /Verdict: BLOCK`? \(2026-10-21T11:00:00Z\) after the latest APPROVE/)
})

test('BLOCK then a newer APPROVE on head → pass (the block is superseded)', () => {
  const r = evaluate(
    pr({
      reviews: [
        review({ body: 'Verdict: BLOCK', commit_id: OLD, submitted_at: '2026-10-21T09:00:00Z' }),
        review({ submitted_at: '2026-10-21T12:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, true, r.missing.join('\n'))
})

test('merge-approved applied by the collaborator → fail with an explicit message', () => {
  const r = evaluate(
    pr({
      reviews: [review()],
      labels: ['merge-approved'],
      labelEvents: [{ actor: COLLAB, created_at: '2026-10-21T10:30:00Z' }],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /applied by @collaborator, not by the repository owner @repo-owner/)
})

test('merge-approved: only the LATEST labeled event counts (collaborator after owner → fail)', () => {
  const r = evaluate(
    pr({
      reviews: [review()],
      labels: ['merge-approved'],
      labelEvents: [
        { actor: OWNER, created_at: '2026-10-21T10:30:00Z' },
        { actor: COLLAB, created_at: '2026-10-21T10:40:00Z' },
      ],
    }),
  )
  assert.equal(r.pass, false)
})

test('merge-approved: owner re-applied after the collaborator → pass', () => {
  const r = evaluate(
    pr({
      reviews: [review()],
      labels: ['merge-approved'],
      labelEvents: [
        { actor: COLLAB, created_at: '2026-10-21T10:30:00Z' },
        { actor: OWNER, created_at: '2026-10-21T10:40:00Z' },
      ],
    }),
  )
  assert.equal(r.pass, true, r.missing.join('\n'))
})

test('merge-approved present but no labeled event fetched → fail (does not assume the owner)', () => {
  const r = evaluate(pr({ reviews: [review()], labels: ['merge-approved'], labelEvents: [] }))
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /no labeled event names who applied it/)
})

test('a "Verdict: APPROVE" review posted by the collaborator himself does not count', () => {
  const r = evaluate(
    pr({
      reviews: [
        review({ author: COLLAB }),
        review({
          author: COLLAB,
          body: 'Security Review: APPROVE',
          submitted_at: '2026-10-21T10:01:00Z',
        }),
      ],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /no review by @repo-owner/)
  assert.ok(r.missing.some((m) => /verdict lines in reviews by @collaborator do not count/.test(m)))
})

// --- hardening around the core decision --------------------------------------------------------

test('a DISMISSED owner approval does not count', () => {
  assert.equal(evaluate(pr({ reviews: [review({ state: 'DISMISSED' })] })).pass, false)
})

test('a DISMISSED owner BLOCK still blocks (dismissal is not a way around a block)', () => {
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

test('a PENDING (unsubmitted) owner review does not count', () => {
  assert.equal(evaluate(pr({ reviews: [review({ state: 'PENDING' })] })).pass, false)
})

test('a native GitHub APPROVED owner review with the marker counts', () => {
  assert.equal(evaluate(pr({ reviews: [review({ state: 'APPROVED' })] })).pass, true)
})

test('an unsuperseded Security Review: BLOCK blocks even on a non-critical PR', () => {
  const r = evaluate(
    pr({
      reviews: [
        review(),
        review({ body: 'Security Review: BLOCK', submitted_at: '2026-10-21T11:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, false)
  assert.match(r.missing[0], /Security Review: BLOCK/)
})

test('both reviews present but security BLOCK after security APPROVE on a critical PR → fail', () => {
  const r = evaluate(
    pr({
      files: ['apps/api/src/auth/jwt.guard.ts'],
      reviews: [
        review(),
        SEC_APPROVE,
        review({ body: 'Security Review: BLOCK', submitted_at: '2026-10-21T12:00:00Z' }),
      ],
    }),
  )
  assert.equal(r.pass, false)
})

test('a verdict quoted mid-sentence is not a marker', () => {
  const r = evaluate(
    pr({ reviews: [review({ body: 'I would give this Verdict: APPROVE once CR-H-1 is fixed.' })] }),
  )
  assert.equal(r.pass, false)
})

test('missing items are all listed together, not just the first', () => {
  const r = evaluate(
    pr({
      files: ['.github/workflows/deploy.yml'],
      labels: ['merge-approved'],
      labelEvents: [{ actor: COLLAB, created_at: '2026-10-21T10:00:00Z' }],
    }),
  )
  assert.equal(r.pass, false)
  assert.equal(r.missing.length, 3) // code review, security review, label
})

test('malformed input throws instead of passing (empty file list = the fetch did not run)', () => {
  assert.throws(() => evaluate(pr({ files: [] })), /files is empty/)
  assert.throws(() => evaluate(pr({ owner: '' })), /owner must be a non-empty string/)
  assert.throws(() => evaluate({ ...pr(), reviews: undefined }), /reviews must be an array/)
})

// --- verdict parsing ---------------------------------------------------------------------------

test('parseVerdicts tolerates markdown decoration and takes the first marker of each kind', () => {
  assert.deepEqual(parseVerdicts('**Verdict: APPROVE**'), { code: 'APPROVE', security: null })
  assert.deepEqual(parseVerdicts('## Code review\n\nVerdict: BLOCK\n\nthe old Verdict: APPROVE'), {
    code: 'BLOCK',
    security: null,
  })
  assert.deepEqual(parseVerdicts('Security Review: APPROVE\r\n'), {
    code: null,
    security: 'APPROVE',
  })
  assert.deepEqual(parseVerdicts(null), { code: null, security: null })
})

// --- critical-path globs, against real repository paths (measured 2026-10-21) ------------------

test('globToRegExp semantics: ** spans zero or more segments, * stays in one segment', () => {
  assert.ok(globToRegExp('apps/api/src/**/finance/**').test('apps/api/src/finance/x.ts'))
  assert.ok(globToRegExp('apps/api/src/**/finance/**').test('apps/api/src/a/b/finance/c/x.ts'))
  assert.ok(!globToRegExp('apps/api/src/**/finance/**').test('apps/web/app/finance/x.ts'))
  assert.ok(globToRegExp('**/*.guard.ts').test('roles.guard.ts'))
  assert.ok(!globToRegExp('apps/*/x.ts').test('apps/a/b/x.ts'))
  assert.ok(!globToRegExp('a.b').test('aXb'))
})

const CRITICAL_SAMPLES = [
  'apps/api/src/auth/jwt.guard.ts',
  'apps/api/src/auth/auth.service.ts',
  'apps/api/src/common/guards/roles.guard.ts',
  'apps/api/src/common/decorators/roles.decorator.ts',
  'apps/api/src/telemetry/telemetry-digest-token.guard.ts',
  'apps/api/src/finance/transactions.service.ts',
  'apps/api/src/finance/company-account.service.ts',
  'apps/api/src/database/schema/transactions.ts',
  'apps/api/src/database/schema.ts',
  'apps/api/src/database/privileges/generate-privilege-sql.ts',
  'apps/api/src/database/privilege-denied-reporter.ts',
  'apps/api/src/documents/document-upload-rbac.util.ts',
  'apps/api/src/projects/project-visibility.util.ts',
  'apps/api/src/users/role-guards.util.ts',
  'apps/api/drizzle/manual/2026-10-18_db_roles.sql',
  'apps/api/src/integrations/meeting-recorder/meeting-recorder-webhook-verifier.ts',
  'packages/shared/src/schemas/finance/payout.ts',
  'packages/shared/src/schemas/view-permissions.ts',
  'packages/shared/src/types/roles.ts',
  '.github/workflows/deploy.yml',
  'scripts/architect/review-gate.mjs',
]

const NON_CRITICAL_SAMPLES = [
  'apps/web/app/components/Button.tsx',
  'apps/api/src/vacancies/vacancies.service.ts',
  'docs/architecture/some-adr.md',
  '.claude/skills/ecc/database-migrations/SKILL.md',
  'packages/shared/src/i18n/locales/en/messages.po',
]

for (const p of CRITICAL_SAMPLES) {
  test(`critical: ${p}`, () => assert.equal(criticalPaths([p]).length, 1))
}
for (const p of NON_CRITICAL_SAMPLES) {
  test(`not critical: ${p}`, () => assert.equal(criticalPaths([p]).length, 0))
}

test('every critical glob compiles and the list is non-empty', () => {
  assert.ok(CRITICAL_PATH_GLOBS.length > 10)
  for (const g of CRITICAL_PATH_GLOBS) assert.ok(globToRegExp(g) instanceof RegExp)
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

test('CLI: PASS exits 0 and writes a summary that says PASS', () => {
  const r = runCli(pr({ reviews: [review()] }))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.sum, /## Review Gate: PASS/)
})

test('CLI: FAIL exits 1 and prints one ::error:: line per missing item', () => {
  const r = runCli(pr({ files: ['apps/api/src/finance/x.ts'] }))
  assert.equal(r.status, 1)
  assert.equal((r.stdout.match(/^::error title=Review Gate::/gm) ?? []).length, 2)
  assert.match(r.sum, /## Review Gate: FAIL/)
})

test('CLI: malformed input exits 2, never 0', () => {
  assert.equal(runCli('{not json').status, 2)
  assert.equal(runCli(pr({ files: [] })).status, 2)
})
