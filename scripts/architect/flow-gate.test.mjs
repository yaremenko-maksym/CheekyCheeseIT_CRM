// Unit tests for scripts/architect/flow-gate.mjs.
// Run: node --test 'scripts/architect/*.test.mjs'   (CI: .github/workflows/architect-scripts.yml)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluate,
  STEPS,
  parseMarker,
  bodyLine,
  lastWorkCommit,
  isCritical,
  isTestFile,
  isProductCode,
  isUiCode,
  isCopy,
} from './flow-gate.mjs'

// --- fixtures ------------------------------------------------------------------------------------

const rv = (body, over = {}) => ({
  author: 'a-reviewer',
  state: 'COMMENTED',
  body,
  at: '2026-10-21T10:00:00Z',
  ...over,
})
const cm = (body, over = {}) => ({ author: 'a-qa', body, at: '2026-10-21T10:00:00Z', ...over })
const commit = (message, over = {}) => ({ sha: 'f'.repeat(40), message, parents: 1, ...over })

const API = 'apps/api/src/vacancies/vacancies.service.ts' // product code, not critical, not UI
const API_SPEC = 'apps/api/src/vacancies/vacancies.service.spec.ts'

// A PR that satisfies every always-required step for a plain backend change.
const FULL_BODY = 'Task: .claude/tasks/task-x.md\nPlan: in the task file\n'
const FULL_REVIEWS = [rv('Verdict: APPROVE'), rv('Spec Review: PASS')]
const good = (over = {}) => ({
  files: [API, API_SPEC],
  body: FULL_BODY,
  reviews: FULL_REVIEWS,
  comments: [],
  commits: [commit('feat(api): x\n\nac_verified: 1,2')],
  ...over,
})
const status = (r, key) => r.steps.find((s) => s.key === key)?.status
const failureFor = (r, key) => r.failures.find((f) => f.startsWith(`${key} —`))

// --- docs-only and "nothing declared" ----------------------------------------------------------

test('docs-only diff → pass, no steps evaluated', () => {
  const r = evaluate({
    files: ['docs/a.md', '.claude/rules/common/b.md', '.claude/hooks/x.sh'],
    body: '',
    reviews: [],
    comments: [],
    commits: [commit('docs: x')],
  })
  assert.equal(r.pass, true)
  assert.equal(r.docsOnly, true)
})

test('nothing declared on a UI + critical + copy diff → fail, listing every required step', () => {
  const r = evaluate({
    files: [
      'apps/web/app/routes/x.tsx',
      'apps/api/src/finance/x.ts',
      'packages/shared/src/i18n/locales/en/messages.po',
    ],
    body: '',
    reviews: [],
    comments: [],
    commits: [commit('feat: x')],
  })
  assert.equal(r.pass, false)
  const missing = r.steps.filter((s) => s.status === 'missing').map((s) => s.key)
  // Spec-Review is the only step not required: no Task: line is declared.
  assert.deepEqual(missing, [
    'Task',
    'Plan',
    'Tests',
    'Review',
    'Security-Review',
    'Copy-Review',
    'QA',
    'Design-Review',
    'AC',
  ])
  assert.equal(status(r, 'Spec-Review'), 'not-required')
  for (const f of r.failures) assert.match(f, /, or add "Skip-[A-Za-z-]+: <why>" to the PR body\.$/)
})

test('a fully evidenced plain backend PR → pass', () => {
  const r = evaluate(good())
  assert.equal(r.pass, true, r.failures.join('\n'))
  assert.equal(status(r, 'Security-Review'), 'not-required')
  assert.equal(status(r, 'QA'), 'not-required')
})

test('the fail message names the step, the cause and both ways out', () => {
  const r = evaluate(good({ reviews: [rv('Spec Review: PASS')] }))
  assert.equal(
    failureFor(r, 'Review'),
    'Review — no "Verdict: APPROVE" review. Run code-reviewer, or add "Skip-Review: <why>" to the PR body.',
  )
})

// --- each step: evidence pass / skip-with-reason pass / skip-with-short-reason fail --------------

// For every step: a PR that REQUIRES the step and lacks its evidence, plus the evidence that cures it.
const BASE_ALL = {
  files: [
    'apps/web/app/routes/x.tsx',
    'apps/api/src/finance/x.ts',
    'packages/shared/src/i18n/locales/en/messages.po',
  ],
  body: FULL_BODY,
  reviews: [],
  comments: [],
  commits: [commit('feat: x')],
}
const EVIDENCE = {
  Task: (pr) => pr, // the base already declares Task: — tested separately below
  Plan: (pr) => pr,
  Tests: (pr) => ({ ...pr, files: [...pr.files, 'apps/web/app/routes/x.spec.tsx'] }),
  Review: (pr) => ({ ...pr, reviews: [...pr.reviews, rv('Verdict: APPROVE')] }),
  'Security-Review': (pr) => ({ ...pr, reviews: [...pr.reviews, rv('Security Review: APPROVE')] }),
  'Spec-Review': (pr) => ({ ...pr, reviews: [...pr.reviews, rv('Spec Review: PASS')] }),
  'Copy-Review': (pr) => ({ ...pr, reviews: [...pr.reviews, rv('Copy Review: PASS')] }),
  QA: (pr) => ({ ...pr, comments: [...pr.comments, cm('QA Verdict: PASS')] }),
  'Design-Review': (pr) => ({ ...pr, comments: [...pr.comments, cm('Design Review: PASS')] }),
  AC: (pr) => ({ ...pr, commits: [commit('feat: x\n\nac_verified: 1')] }),
}

test('every step in STEPS has a test fixture', () => {
  assert.deepEqual(Object.keys(EVIDENCE).sort(), STEPS.map((s) => s.key).sort())
})

for (const step of STEPS.map((s) => s.key)) {
  const without =
    step === 'Task'
      ? { ...BASE_ALL, body: 'Plan: in the task file\n' }
      : step === 'Plan'
        ? { ...BASE_ALL, body: 'Task: .claude/tasks/task-x.md\n' }
        : BASE_ALL

  test(`${step}: missing evidence → the step is missing`, () => {
    assert.equal(status(evaluate(without), step), 'missing')
  })

  test(`${step}: evidence → satisfied`, () => {
    const pr =
      step === 'Task'
        ? { ...without, body: `${without.body}Task: issue #12\n` }
        : step === 'Plan'
          ? { ...without, body: `${without.body}Plan: docs/plan.md\n` }
          : EVIDENCE[step](without)
    assert.equal(status(evaluate(pr), step), 'satisfied')
  })

  test(`${step}: Skip-${step} with a reason → skipped, reason echoed`, () => {
    const r = evaluate({
      ...without,
      body: `${without.body}Skip-${step}: light-track: a one-line config change\n`,
    })
    assert.equal(status(r, step), 'skipped')
    assert.deepEqual(
      r.skips.find((s) => s.step === step),
      { step, reason: 'light-track: a one-line config change' },
    )
  })

  test(`${step}: Skip-${step} with a reason under 10 characters → still missing`, () => {
    const r = evaluate({ ...without, body: `${without.body}Skip-${step}: trivial\n` })
    assert.equal(status(r, step), 'missing')
    assert.match(failureFor(r, step), /shorter than 10 characters/)
  })
}

test('skip key is case-insensitive and may be a list item', () => {
  const r = evaluate(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}- skip-REVIEW: owner reviewed live in a call\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
})

test('a skip inside an HTML comment (the PR template placeholder) does not count', () => {
  const r = evaluate(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}<!-- Skip-Review: reason why it is fine -->\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'missing')
})

// --- verdict semantics -------------------------------------------------------------------------

test('BLOCK after APPROVE → Review missing', () => {
  const r = evaluate(
    good({ reviews: [...FULL_REVIEWS, rv('Verdict: BLOCK', { at: '2026-10-21T11:00:00Z' })] }),
  )
  assert.equal(status(r, 'Review'), 'missing')
  assert.match(
    failureFor(r, 'Review'),
    /latest `Verdict:` verdict \(by @a-reviewer, 2026-10-21T11:00:00Z\) is negative/,
  )
})

test('BLOCK then a newer APPROVE → Review satisfied', () => {
  const r = evaluate(
    good({
      reviews: [
        rv('Verdict: BLOCK', { at: '2026-10-21T09:00:00Z' }),
        rv('Verdict: APPROVE', { at: '2026-10-21T12:00:00Z' }),
        rv('Spec Review: PASS'),
      ],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
})

test('a recorded skip passes even after a BLOCK', () => {
  const r = evaluate(
    good({
      reviews: [...FULL_REVIEWS, rv('Verdict: BLOCK', { at: '2026-10-21T11:00:00Z' })],
      body: `${FULL_BODY}Skip-Review: BLOCK finding is out of scope, see #1234\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
})

test('dismissed approval does not count; dismissed BLOCK still blocks; PENDING ignored', () => {
  assert.equal(
    status(evaluate(good({ reviews: [rv('Verdict: APPROVE', { state: 'DISMISSED' })] })), 'Review'),
    'missing',
  )
  assert.equal(
    status(
      evaluate(
        good({
          reviews: [
            rv('Verdict: APPROVE'),
            rv('Verdict: BLOCK', { state: 'DISMISSED', at: '2026-10-21T11:00:00Z' }),
          ],
        }),
      ),
      'Review',
    ),
    'missing',
  )
  assert.equal(
    status(evaluate(good({ reviews: [rv('Verdict: APPROVE', { state: 'PENDING' })] })), 'Review'),
    'missing',
  )
})

test('Spec Review: ISSUES after PASS → Spec-Review missing', () => {
  const r = evaluate(
    good({ reviews: [...FULL_REVIEWS, rv('Spec Review: ISSUES', { at: '2026-10-21T11:00:00Z' })] }),
  )
  assert.equal(status(r, 'Spec-Review'), 'missing')
})

test('Design Review: POLISH-REQUESTED is negative; APPROVE is accepted as a synonym of PASS', () => {
  assert.equal(parseMarker('Design Review: POLISH-REQUESTED', 'design'), 'neg')
  assert.equal(parseMarker('Design Review: APPROVE', 'design'), 'pos')
  assert.equal(parseMarker('Design Review: PASS', 'design'), 'pos')
})

test('Review/Security/Spec/Copy read reviews only; QA/Design read reviews and comments', () => {
  const ui = { ...good(), files: ['apps/web/app/routes/x.tsx', 'apps/web/app/routes/x.spec.tsx'] }
  const viaComment = evaluate({
    ...ui,
    comments: [cm('Verdict: APPROVE'), cm('QA Verdict: PASS'), cm('Design Review: PASS')],
    reviews: [rv('Spec Review: PASS')],
  })
  assert.equal(status(viaComment, 'Review'), 'missing')
  assert.equal(status(viaComment, 'QA'), 'satisfied')
  assert.equal(status(viaComment, 'Design-Review'), 'satisfied')
})

test('parseMarker: markdown decoration tolerated, first marker wins, mid-sentence ignored', () => {
  assert.equal(parseMarker('**Verdict: APPROVE**', 'review'), 'pos')
  assert.equal(
    parseMarker('## Review\n\nVerdict: BLOCK\n\nthe old Verdict: APPROVE', 'review'),
    'neg',
  )
  assert.equal(parseMarker('I would say Verdict: APPROVE once fixed', 'review'), null)
  assert.equal(parseMarker('QA Verdict: PASSED', 'qa'), null)
  assert.equal(parseMarker('Security Review: APPROVE', 'review'), null)
})

// --- conditional requirements ------------------------------------------------------------------

test('Security-Review is required only on critical paths', () => {
  assert.equal(status(evaluate(good()), 'Security-Review'), 'not-required')
  const crit = evaluate(
    good({
      files: ['apps/api/src/auth/auth.service.ts', 'apps/api/src/auth/auth.service.spec.ts'],
    }),
  )
  assert.equal(status(crit, 'Security-Review'), 'missing')
})

test('Tests are required only when non-test product code changes', () => {
  assert.equal(status(evaluate(good({ files: ['scripts/devops/x.sh'] })), 'Tests'), 'not-required')
  assert.equal(
    status(evaluate(good({ files: ['apps/api/src/x.spec.ts'] })), 'Tests'),
    'not-required',
  )
  assert.equal(status(evaluate(good({ files: [API] })), 'Tests'), 'missing')
  assert.equal(
    status(evaluate(good({ files: [API, 'apps/e2e/tests/x.spec.ts'] })), 'Tests'),
    'satisfied',
  )
})

test('QA and Design-Review are required only on non-test UI paths', () => {
  assert.equal(status(evaluate(good()), 'QA'), 'not-required')
  assert.equal(status(evaluate(good({ files: ['apps/web/app/x.spec.tsx'] })), 'QA'), 'not-required')
  const ui = evaluate(
    good({ files: ['apps/landing/app/page.tsx', 'apps/landing/app/page.spec.tsx'] }),
  )
  assert.equal(status(ui, 'QA'), 'missing')
  assert.equal(status(ui, 'Design-Review'), 'missing')
})

test('Spec-Review is required only when Task is declared', () => {
  assert.equal(status(evaluate(good()), 'Spec-Review'), 'satisfied')
  const skipTask = evaluate(
    good({
      reviews: [rv('Verdict: APPROVE')],
      body: 'Skip-Task: drive-by fix found while reviewing #99\nPlan: none, one line\n',
    }),
  )
  assert.equal(status(skipTask, 'Task'), 'skipped')
  assert.equal(status(skipTask, 'Spec-Review'), 'not-required')
  assert.equal(skipTask.pass, true, skipTask.failures.join('\n'))
})

test('Copy-Review is required on catalogs and landing dictionaries only', () => {
  assert.equal(isCopy('packages/shared/src/i18n/locales/uk/messages.po'), true)
  assert.equal(isCopy('apps/landing/app/i18n/dictionaries/en.ts'), true)
  assert.equal(isCopy('apps/landing/app/i18n/locale.ts'), false)
})

// --- AC -----------------------------------------------------------------------------------------

test('AC is read from the last non-wip, non-merge commit', () => {
  const commits = [
    commit('feat: x\n\nac_verified: 1,2'),
    commit("Merge branch 'main' into feature", { parents: 2 }),
    commit('wip: polishing'),
  ]
  assert.equal(lastWorkCommit(commits).message.startsWith('feat: x'), true)
  assert.equal(status(evaluate(good({ commits })), 'AC'), 'satisfied')
})

test('AC: a later non-wip commit without ac_verified overrides an earlier one with it', () => {
  const r = evaluate(
    good({
      commits: [
        commit('feat: x\n\nac_verified: 1'),
        commit('fix: follow-up', { sha: 'a'.repeat(40) }),
      ],
    }),
  )
  assert.equal(status(r, 'AC'), 'missing')
  assert.match(failureFor(r, 'AC'), /aaaaaaa "fix: follow-up"/)
})

test('AC: only wip commits → missing with an explicit cause', () => {
  const r = evaluate(good({ commits: [commit('wip: a'), commit('WIP: b')] }))
  assert.match(failureFor(r, 'AC'), /every commit is `wip:` or a merge/)
})

test('AC: "ac_verified:" must start a line', () => {
  assert.equal(
    status(evaluate(good({ commits: [commit('feat: mention ac_verified: in prose')] })), 'AC'),
    'missing',
  )
})

// --- path classes, against real repository paths (measured 2026-10-21) --------------------------

for (const p of [
  'apps/api/src/auth/jwt.guard.ts',
  'apps/api/src/common/guards/roles.guard.ts',
  'apps/api/src/finance/transactions.service.ts',
  'apps/api/src/finance/company-account.service.ts',
  'apps/api/src/database/schema/transactions.ts',
  'apps/api/src/database/schema.ts',
  'apps/api/src/database/privileges/generate-privilege-sql.ts',
  'apps/api/src/documents/document-upload-rbac.util.ts',
  'apps/api/src/projects/project-visibility.util.ts',
  'apps/api/src/users/role-guards.util.ts',
  'apps/api/drizzle/manual/2026-10-18_db_roles.sql',
  'apps/api/src/integrations/meeting-recorder/meeting-recorder-webhook-verifier.ts',
  'packages/shared/src/schemas/finance/payout.ts',
  'packages/shared/src/types/roles.ts',
  '.github/workflows/deploy.yml',
  'scripts/architect/flow-gate.mjs',
]) {
  test(`critical: ${p}`, () => assert.equal(isCritical(p), true))
}
for (const p of [
  'apps/web/app/components/Button.tsx',
  'apps/api/src/vacancies/vacancies.service.ts',
  'docs/a.md',
]) {
  test(`not critical: ${p}`, () => assert.equal(isCritical(p), false))
}

test('path classes: tests, product code, UI', () => {
  assert.equal(isTestFile('apps/web/app/__tests__/x.ts'), true)
  assert.equal(isTestFile('scripts/architect/flow-gate.test.mjs'), true)
  assert.equal(isProductCode('apps/api/src/x.ts'), true)
  assert.equal(isProductCode('apps/api/README.md'), false)
  assert.equal(isProductCode('scripts/devops/x.sh'), false)
  assert.equal(isUiCode('apps/web/app/x.tsx'), true)
  assert.equal(isUiCode('apps/api/src/x.ts'), false)
})

test('bodyLine reads a value, null when absent, empty when blank', () => {
  assert.equal(bodyLine('Task: x\n', 'Task'), 'x')
  assert.equal(bodyLine('Skip-Task: y', 'Task'), null)
  assert.equal(bodyLine('Task:\n', 'Task'), '')
})

test('a blank "Task:" line (the template default) is not a declaration', () => {
  const r = evaluate(
    good({ body: 'Task:\nPlan: in the task file\n', reviews: [rv('Verdict: APPROVE')] }),
  )
  assert.equal(status(r, 'Task'), 'missing')
  assert.equal(status(r, 'Spec-Review'), 'not-required')
})

test('malformed input throws (an unread list is not an empty one)', () => {
  assert.throws(() => evaluate(good({ files: [] })), /files is empty/)
  assert.throws(() => evaluate(good({ commits: [] })), /commits is empty/)
  assert.throws(() => evaluate({ ...good(), comments: undefined }), /comments must be an array/)
  assert.throws(() => evaluate({ ...good(), body: null }), /body must be a string/)
})

// --- CLI ----------------------------------------------------------------------------------------

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'flow-gate.mjs')
const runCli = (data) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-gate-'))
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

test('CLI: PASS exits 0; the summary has the step table and echoes skips', () => {
  const r = runCli(
    good({
      body: `${FULL_BODY}Skip-Tests: covered by the existing integration spec\n`,
      files: [API],
    }),
  )
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.sum, /## Flow Gate: PASS/)
  assert.match(r.sum, /\| Tests \| SKIPPED \| covered by the existing integration spec \|/)
  assert.match(
    r.sum,
    /### Skipped on purpose\n- \*\*Tests\*\* — covered by the existing integration spec/,
  )
  assert.match(r.stdout, /^::notice title=Flow Gate skip::Tests — /m)
})

test('CLI: FAIL exits 1 with one ::error:: line per missing step', () => {
  const r = runCli(good({ reviews: [], body: '' }))
  assert.equal(r.status, 1)
  const errs = r.stdout.match(/^::error title=Flow Gate::/gm) ?? []
  assert.equal(errs.length, 3) // Task, Plan, Review (Spec-Review not required without Task)
  assert.match(r.sum, /## Flow Gate: FAIL/)
})

test('CLI: malformed input exits 2, never 0', () => {
  assert.equal(runCli('{not json').status, 2)
  assert.equal(runCli(good({ files: [] })).status, 2)
})
