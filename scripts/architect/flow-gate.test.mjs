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
  render,
  comparePlan,
  statedCommit,
  isDoc,
  isInertDoc,
  MAX_COMPARES,
  MAX_COMPARE_FILES,
} from './flow-gate.mjs'

// `headSha` defaults to the last listed commit, which is what GitHub reports for a real PR. A
// fixture that wants a stale verdict overrides the reviews' `commit_id`, not the head.
const withCounts = (pr) =>
  pr && typeof pr === 'object' && Array.isArray(pr.files) && Array.isArray(pr.commits)
    ? {
        counts: { changedFiles: pr.files.length, commits: pr.commits.length },
        headSha: pr.commits.length ? pr.commits[pr.commits.length - 1].sha : undefined,
        ...pr,
      }
    : pr
const ev = (pr) => evaluate(withCounts(pr))

// --- fixtures ------------------------------------------------------------------------------------

const rv = (body, over = {}) => ({
  author: 'a-reviewer',
  association: 'OWNER',
  state: 'COMMENTED',
  body,
  at: '2026-10-21T10:00:00Z',
  commit_id: 'f'.repeat(40), // the default `commit()` sha, so a default review is on the head
  ...over,
})
const cm = (body, over = {}) => ({
  author: 'a-qa',
  association: 'COLLABORATOR',
  body,
  at: '2026-10-21T10:00:00Z',
  ...over,
})
// A comment-borne verdict carries no `commit_id`, so it must name the commit it judged. `cmv` is
// the ordinary case: a verdict on the default head. `cm` is left bare for the fixtures that test
// what happens without the line.
const cmv = (body, over = {}) => cm(`${body}\nCommit: ${'f'.repeat(40)}`, over)
// No `committedAt`: the gate reads no commit date (SEC-1). The two fixtures that still supply one
// do it adversarially, to prove it is ignored.
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

test('SR-M-4: the template skip block un-commented without editing → every Skip-* rejected, FAIL', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const template = readFileSync(
    join(here, '..', '..', '.github', 'pull_request_template.md'),
    'utf8',
  )
  const open = '<!-- To skip a step, move its line out of this comment block and write the reason.'
  assert.ok(template.includes(open), 'template skip block opener moved; update this test')
  const start = template.indexOf(open)
  const end = template.indexOf('-->', start)
  const block = template.slice(start + open.length, end)
  const body = template.slice(0, start) + block + template.slice(end + 3)
  assert.match(body, /^Skip-Security-Review: <.*> \(required on/m)
  const r = ev({
    files: ['apps/api/src/auth/auth.service.ts', 'apps/api/src/auth/auth.service.spec.ts'],
    body,
    reviews: [rv('Verdict: APPROVE')],
    comments: [],
    commits: [commit('feat(auth): x\n\nac_verified: 1')],
  })
  assert.equal(r.pass, false)
  assert.equal(r.skips.length, 0)
  assert.equal(status(r, 'Security-Review'), 'missing')
  assert.match(failureFor(r, 'Security-Review'), /template placeholder/)
})

test('SR-M-4: a real skip reason still passes', () => {
  const r = ev(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}Skip-Review: docs-only rename of a constant\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
})

// --- docs-only and "nothing declared" ----------------------------------------------------------

test('docs-only diff → pass, no steps evaluated', () => {
  const r = ev({
    files: ['docs/a.md', '.claude/rules/common/b.md', 'README.md'],
    body: '',
    reviews: [],
    comments: [],
    commits: [commit('docs: x')],
  })
  assert.equal(r.pass, true)
  assert.equal(r.docsOnly, true)
})

test('nothing declared on a UI + critical + copy diff → fail, listing every required step', () => {
  const r = ev({
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
  const r = ev(good())
  assert.equal(r.pass, true, r.failures.join('\n'))
  assert.equal(status(r, 'Security-Review'), 'not-required')
  assert.equal(status(r, 'QA'), 'not-required')
})

test('the fail message names the step, the cause and both ways out', () => {
  const r = ev(good({ reviews: [rv('Spec Review: PASS')] }))
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
  QA: (pr) => ({ ...pr, comments: [...pr.comments, cmv('QA Verdict: PASS')] }),
  'Design-Review': (pr) => ({ ...pr, comments: [...pr.comments, cmv('Design Review: PASS')] }),
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
    assert.equal(status(ev(without), step), 'missing')
  })

  test(`${step}: evidence → satisfied`, () => {
    const pr =
      step === 'Task'
        ? { ...without, body: `${without.body}Task: issue #12\n` }
        : step === 'Plan'
          ? { ...without, body: `${without.body}Plan: docs/plan.md\n` }
          : EVIDENCE[step](without)
    assert.equal(status(ev(pr), step), 'satisfied')
  })

  test(`${step}: Skip-${step} with a reason → skipped, reason echoed`, () => {
    const r = ev({
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
    const r = ev({ ...without, body: `${without.body}Skip-${step}: trivial\n` })
    assert.equal(status(r, step), 'missing')
    assert.match(failureFor(r, step), /shorter than 10 characters/)
  })
}

test('skip key is case-insensitive and may be a list item', () => {
  const r = ev(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}- skip-REVIEW: owner reviewed live in a call\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
})

test('a skip inside an HTML comment (the PR template placeholder) does not count', () => {
  const r = ev(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}<!-- Skip-Review: reason why it is fine -->\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'missing')
})

test('SR-H-1: the verbatim PR template on a critical-path diff with no reviews → FAIL', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const template = readFileSync(
    join(here, '..', '..', '.github', 'pull_request_template.md'),
    'utf8',
  )
  // The template must actually carry the column-0 skip lines this test is about.
  assert.match(template, /^Skip-Security-Review:/m)
  const r = ev({
    files: ['apps/api/src/auth/auth.service.ts', 'apps/api/src/auth/auth.service.spec.ts'],
    body: template,
    reviews: [],
    comments: [],
    commits: [commit('feat(auth): x\n\nac_verified: 1')],
  })
  assert.equal(r.pass, false)
  assert.equal(r.skips.length, 0)
  for (const k of ['Task', 'Plan', 'Review', 'Security-Review'])
    assert.equal(status(r, k), 'missing', k)
})

test('SR-H-1: a skip line inside a multi-line comment or a fenced block does not count', () => {
  for (const body of [
    `${FULL_BODY}<!--\nSkip-Review: reason why it is fine\n-->\n`,
    `${FULL_BODY}\`\`\`\nSkip-Review: reason why it is fine\n\`\`\`\n`,
    `${FULL_BODY}~~~md\nSkip-Review: reason why it is fine\n~~~\n`,
    `${FULL_BODY}<!-- unterminated\nSkip-Review: reason why it is fine\n`,
  ]) {
    const r = ev(good({ reviews: [rv('Spec Review: PASS')], body }))
    assert.equal(status(r, 'Review'), 'missing', JSON.stringify(body))
  }
  // Prose after a closed fence is read again.
  const after = ev(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}\`\`\`\nexample\n\`\`\`\nSkip-Review: reason why it is fine\n`,
    }),
  )
  assert.equal(status(after, 'Review'), 'skipped')
})

test('SR-H-1: a placeholder reason "<…>" is not a reason', () => {
  const r = ev(
    good({
      reviews: [rv('Spec Review: PASS')],
      body: `${FULL_BODY}Skip-Review: <why no code-reviewer approval at all>\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'missing')
  assert.match(failureFor(r, 'Review'), /template placeholder/)
})

// --- docs-only is markdown only; .claude executable config is critical -------------------------

const bare = (files, over = {}) => ({
  files,
  body: '',
  reviews: [],
  comments: [],
  commits: [commit('chore: x')],
  ...over,
})

test('SR-M-3: the docs-only summary states the real rule (every path ends in .md)', () => {
  const pr = withCounts(bare(['docs/a.md']))
  const text = render(evaluate(pr), pr)
  assert.match(text, /ends in `\.md`/)
  assert.doesNotMatch(text, /under `\.claude\/`/)
})

test('a PR touching only .claude/rules/x.md is docs-only', () => {
  assert.equal(ev(bare(['.claude/rules/x.md'])).docsOnly, true)
})

test('a PR touching only .claude/hooks/x.sh is NOT docs-only and requires Security-Review', () => {
  const r = ev(bare(['.claude/hooks/x.sh']))
  assert.equal(r.docsOnly, false)
  assert.equal(status(r, 'Security-Review'), 'missing')
})

test('.claude/settings.json and settings.local.json are critical; other .claude json is not docs', () => {
  assert.equal(isCritical('.claude/settings.json'), true)
  assert.equal(isCritical('.claude/settings.local.json'), true)
  const r = ev(bare(['.claude/skills/x/config.json']))
  assert.equal(r.docsOnly, false)
  assert.equal(status(r, 'Security-Review'), 'not-required')
})

// --- renames ------------------------------------------------------------------------------------

test('a rename from a non-.md path to a .md path is not docs-only, and the source is classified', () => {
  const files = [
    { filename: 'notes/x.md', previous_filename: 'apps/api/src/auth/x.ts', status: 'renamed' },
  ]
  const r = ev(bare(files))
  assert.equal(r.docsOnly, false)
  assert.equal(status(r, 'Security-Review'), 'missing')
})

test('a deleted non-.md file is not docs-only', () => {
  assert.equal(
    ev(bare([{ filename: 'apps/api/src/x.ts', status: 'removed' }, 'docs/a.md'])).docsOnly,
    false,
  )
})

test('a .md → .md rename stays docs-only', () => {
  const files = [{ filename: 'docs/b.md', previous_filename: 'docs/a.md', status: 'renamed' }]
  assert.equal(ev(bare(files)).docsOnly, true)
})

// --- repository association --------------------------------------------------------------------

test('an outsider APPROVE (association NONE) is ignored', () => {
  const r = ev(
    good({ reviews: [rv('Verdict: APPROVE', { association: 'NONE' }), rv('Spec Review: PASS')] }),
  )
  assert.equal(status(r, 'Review'), 'missing')
})

test('an outsider BLOCK (association CONTRIBUTOR) after an APPROVE is ignored', () => {
  const r = ev(
    good({
      reviews: [
        ...FULL_REVIEWS,
        rv('Verdict: BLOCK', { association: 'CONTRIBUTOR', at: '2026-10-21T11:00:00Z' }),
      ],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
})

test('an outsider QA comment is ignored; MEMBER and COLLABORATOR count', () => {
  const ui = good({ files: ['apps/web/app/x.tsx', 'apps/web/app/x.spec.tsx'] })
  assert.equal(
    status(ev({ ...ui, comments: [cmv('QA Verdict: PASS', { association: 'NONE' })] }), 'QA'),
    'missing',
  )
  assert.equal(
    status(ev({ ...ui, comments: [cmv('QA Verdict: PASS', { association: 'MEMBER' })] }), 'QA'),
    'satisfied',
  )
  assert.equal(
    status(
      ev({ ...ui, comments: [cmv('QA Verdict: PASS', { association: 'COLLABORATOR' })] }),
      'QA',
    ),
    'satisfied',
  )
})

test('the PR author is not excluded: an OWNER review on an owner PR counts', () => {
  assert.equal(
    status(
      ev(
        good({
          reviews: [rv('Verdict: APPROVE', { author: 'the-owner' }), rv('Spec Review: PASS')],
        }),
      ),
      'Review',
    ),
    'satisfied',
  )
})

test('a review with no association field does not count (fail closed)', () => {
  const { association: _a, ...noAssoc } = rv('Verdict: APPROVE')
  assert.equal(
    status(ev(good({ reviews: [noAssoc, rv('Spec Review: PASS')] })), 'Review'),
    'missing',
  )
})

// --- completeness (fail closed on truncation) --------------------------------------------------

test('listed files fewer than the PR reports → FAIL "could not read the whole PR", even when docs-only', () => {
  const r = ev({ ...bare(['docs/a.md']), counts: { changedFiles: 2, commits: 1 } })
  assert.equal(r.pass, false)
  assert.equal(r.docsOnly, false)
  assert.match(
    r.failures[0],
    /^Completeness — could not read the whole PR \(listed 1 changed files, the PR reports 2\)/,
  )
})

test('listed commits fewer than the PR reports → FAIL', () => {
  const r = ev({ ...good(), counts: { changedFiles: 2, commits: 3 } })
  assert.equal(r.pass, false)
  assert.match(r.failures[0], /listed 1 commits, the PR reports 3/)
})

test('changed_files ≥ 3000 or commits ≥ 250 → FAIL even when the counts match', () => {
  const files = Array.from({ length: 3000 }, (_, i) => `docs/f${i}.md`)
  assert.match(
    ev({ ...bare(files), counts: { changedFiles: 3000, commits: 1 } }).failures[0],
    /lists at most 3000/,
  )
  const commits = Array.from({ length: 250 }, () => commit('wip: x'))
  assert.match(
    ev({ ...good({ commits }), counts: { changedFiles: 2, commits: 250 } }).failures[0],
    /lists at most 250/,
  )
})

test('missing counts → FAIL, a skip line cannot cover it', () => {
  // Deliberately NOT through `ev`: that helper derives the counts, and this case is their absence.
  const r = evaluate({
    ...good(),
    headSha: 'f'.repeat(40),
    body: `${FULL_BODY}Skip-Completeness: whatever reason here\n`,
  })
  assert.equal(r.pass, false)
  assert.match(r.failures[0], /counts were not provided/)
})

// --- verdict semantics -------------------------------------------------------------------------

test('BLOCK after APPROVE → Review missing', () => {
  const r = ev(
    good({ reviews: [...FULL_REVIEWS, rv('Verdict: BLOCK', { at: '2026-10-21T11:00:00Z' })] }),
  )
  assert.equal(status(r, 'Review'), 'missing')
  assert.match(
    failureFor(r, 'Review'),
    /latest `Verdict:` verdict \(by @a-reviewer, 2026-10-21T11:00:00Z\) is negative/,
  )
})

test('BLOCK then a newer APPROVE → Review satisfied', () => {
  const r = ev(
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
  const r = ev(
    good({
      reviews: [...FULL_REVIEWS, rv('Verdict: BLOCK', { at: '2026-10-21T11:00:00Z' })],
      body: `${FULL_BODY}Skip-Review: BLOCK finding is out of scope, see #1234\n`,
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
})

test('dismissed approval does not count; dismissed BLOCK still blocks; PENDING ignored', () => {
  assert.equal(
    status(ev(good({ reviews: [rv('Verdict: APPROVE', { state: 'DISMISSED' })] })), 'Review'),
    'missing',
  )
  assert.equal(
    status(
      ev(
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
    status(ev(good({ reviews: [rv('Verdict: APPROVE', { state: 'PENDING' })] })), 'Review'),
    'missing',
  )
})

test('Spec Review: ISSUES after PASS → Spec-Review missing', () => {
  const r = ev(
    good({ reviews: [...FULL_REVIEWS, rv('Spec Review: ISSUES', { at: '2026-10-21T11:00:00Z' })] }),
  )
  assert.equal(status(r, 'Spec-Review'), 'missing')
})

test('Design Review: POLISH-REQUESTED is negative; APPROVE is accepted as a synonym of PASS', () => {
  assert.equal(parseMarker('Design Review: POLISH-REQUESTED', 'design'), 'neg')
  assert.equal(parseMarker('Design Review: APPROVE', 'design'), 'pos')
  assert.equal(parseMarker('Design Review: PASS', 'design'), 'pos')
})

test('Review/Security/Spec read reviews only; Copy/QA/Design read reviews and comments', () => {
  const ui = {
    ...good(),
    files: [
      'apps/web/app/routes/x.tsx',
      'apps/web/app/routes/x.spec.tsx',
      'apps/api/src/auth/x.ts',
      'packages/shared/src/i18n/locales/en/messages.po',
    ],
  }
  const viaComment = ev({
    ...ui,
    comments: [
      cm('Verdict: APPROVE'),
      cm('Security Review: APPROVE'),
      cm('Spec Review: PASS'),
      cmv('Copy Review: PASS'),
      cmv('QA Verdict: PASS'),
      cmv('Design Review: PASS'),
    ],
    reviews: [],
  })
  assert.equal(status(viaComment, 'Review'), 'missing')
  assert.equal(status(viaComment, 'Security-Review'), 'missing')
  assert.equal(status(viaComment, 'Spec-Review'), 'missing')
  assert.equal(status(viaComment, 'Copy-Review'), 'satisfied')
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

test('CR-M-3: a later security-reviewer BLOCK (template body) defeats an earlier APPROVE', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const agent = readFileSync(
    join(here, '..', '..', '.claude', 'agents', 'security-reviewer.md'),
    'utf8',
  )
  // The BLOCK template in the agent prompt, as an agent would post it.
  const m = /"body": "(Verdict: BLOCK[^"]*)"/.exec(agent)
  assert.ok(m, 'security-reviewer.md has a BLOCK template body')
  const blockBody = m[1].replace(/\\n/g, '\n')
  assert.equal(parseMarker(blockBody, 'security'), 'neg')
  const r = ev(
    good({
      files: ['apps/api/src/auth/auth.service.ts', 'apps/api/src/auth/auth.service.spec.ts'],
      reviews: [
        ...FULL_REVIEWS,
        rv('Security Review: APPROVE', { at: '2026-10-21T10:00:00Z' }),
        rv(blockBody, { at: '2026-10-21T11:00:00Z' }),
      ],
    }),
  )
  assert.equal(status(r, 'Security-Review'), 'missing')
})

test('SR-M-2: quoted, fenced and commented verdicts are ignored', () => {
  assert.equal(parseMarker('> Verdict: APPROVE', 'review'), null)
  assert.equal(parseMarker('  > **Verdict: APPROVE**', 'review'), null)
  assert.equal(parseMarker('```\nVerdict: APPROVE\n```', 'review'), null)
  assert.equal(parseMarker('~~~\nSecurity Review: APPROVE\n~~~', 'security'), null)
  assert.equal(parseMarker('<!--\nVerdict: APPROVE\n-->', 'review'), null)
  // A quoted earlier APPROVE does not hide the author's own BLOCK below it.
  assert.equal(parseMarker('> Verdict: APPROVE\n\nVerdict: BLOCK', 'review'), 'neg')
  // End to end: a quote-only review leaves Review missing.
  const r = ev(good({ reviews: [rv('> Verdict: APPROVE'), rv('Spec Review: PASS')] }))
  assert.equal(status(r, 'Review'), 'missing')
})

// --- conditional requirements ------------------------------------------------------------------

test('Security-Review is required only on critical paths', () => {
  assert.equal(status(ev(good()), 'Security-Review'), 'not-required')
  const crit = ev(
    good({
      files: ['apps/api/src/auth/auth.service.ts', 'apps/api/src/auth/auth.service.spec.ts'],
    }),
  )
  assert.equal(status(crit, 'Security-Review'), 'missing')
})

test('Tests are required only when non-test product code changes', () => {
  assert.equal(status(ev(good({ files: ['scripts/devops/x.sh'] })), 'Tests'), 'not-required')
  assert.equal(status(ev(good({ files: ['apps/api/src/x.spec.ts'] })), 'Tests'), 'not-required')
  assert.equal(status(ev(good({ files: [API] })), 'Tests'), 'missing')
  assert.equal(status(ev(good({ files: [API, 'apps/e2e/tests/x.spec.ts'] })), 'Tests'), 'satisfied')
})

test('LOW-2: Tests are triggered by code extensions only, not by package.json / catalogs / CSS / assets', () => {
  for (const p of [
    'apps/api/package.json',
    'packages/shared/src/i18n/locales/en/messages.po',
    'apps/web/app/styles/app.css',
    'apps/landing/public/logo.svg',
    'apps/web/public/favicon.png',
  ])
    assert.equal(status(ev(good({ files: [p] })), 'Tests'), 'not-required', p)
  for (const p of [
    'apps/api/src/x.ts',
    'apps/web/app/x.tsx',
    'apps/web/app/x.js',
    'apps/web/app/x.jsx',
    'packages/shared/src/x.mjs',
    'apps/api/x.cjs',
  ])
    assert.equal(status(ev(good({ files: [p] })), 'Tests'), 'missing', p)
})

test('QA and Design-Review are required only on non-test UI paths', () => {
  assert.equal(status(ev(good()), 'QA'), 'not-required')
  assert.equal(status(ev(good({ files: ['apps/web/app/x.spec.tsx'] })), 'QA'), 'not-required')
  const ui = ev(good({ files: ['apps/landing/app/page.tsx', 'apps/landing/app/page.spec.tsx'] }))
  assert.equal(status(ui, 'QA'), 'missing')
  assert.equal(status(ui, 'Design-Review'), 'missing')
})

test('Spec-Review is required only when Task is declared', () => {
  assert.equal(status(ev(good()), 'Spec-Review'), 'satisfied')
  const skipTask = ev(
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
  assert.equal(status(ev(good({ commits })), 'AC'), 'satisfied')
})

test('AC: a later non-wip commit without ac_verified overrides an earlier one with it', () => {
  const r = ev(
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
  const r = ev(good({ commits: [commit('wip: a'), commit('WIP: b')] }))
  assert.match(failureFor(r, 'AC'), /every commit is `wip:` or a merge/)
})

test('AC: "ac_verified:" must start a line', () => {
  assert.equal(
    status(ev(good({ commits: [commit('feat: mention ac_verified: in prose')] })), 'AC'),
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
  // LOW-1: test-support helpers are test files, not product code.
  assert.equal(isTestFile('apps/api/src/approvals/__test-helpers__/approvals-stub.ts'), true)
  assert.equal(isProductCode('apps/api/src/approvals/__test-helpers__/approvals-stub.ts'), false)
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
  const r = ev(good({ body: 'Task:\nPlan: in the task file\n', reviews: [rv('Verdict: APPROVE')] }))
  assert.equal(status(r, 'Task'), 'missing')
  assert.equal(status(r, 'Spec-Review'), 'not-required')
})

test('malformed input throws (an unread list is not an empty one)', () => {
  assert.throws(() => ev(good({ files: [] })), /files is empty/)
  assert.throws(() => ev(good({ commits: [] })), /commits is empty/)
  assert.throws(() => ev({ ...good(), comments: undefined }), /comments must be an array/)
  assert.throws(() => ev({ ...good(), body: null }), /body must be a string/)
})

// --- CLI ----------------------------------------------------------------------------------------

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'flow-gate.mjs')
const runCli = (data) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-gate-'))
  const input = join(dir, 'in.json')
  const summary = join(dir, 'summary.md')
  writeFileSync(input, typeof data === 'string' ? data : JSON.stringify(withCounts(data)))
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

// --- verdict freshness: a verdict is pinned to the commit it was given on -----------------------
//
// Backlog 311 (fourth gap), PR #1110: both verdicts were given on `abc3fa24c`, a further commit
// landed, and the gate still reported both steps `done`. The reviewed code and the merged code
// were different code.

const HEAD = 'f'.repeat(40) // the default `commit()` sha, and so the default head
const OLD = '1'.repeat(40)
const GONE = '2'.repeat(40)

// `ownedAt` is the PR's own changed-file set AT `base` — by default the same files it owns now.
// A fixture testing SEC-2 passes a wider set.
const cmp = (base, paths, over = {}) => ({
  base,
  paths,
  ownedAt: [API, API_SPEC],
  truncated: false,
  ...over,
})
/** Two commits: an older one a review was given on, then the head. */
const twoCommits = (headMessage = 'feat(api): follow-up\n\nac_verified: 1,2') => [
  commit('wip: first cut', { sha: OLD }),
  commit(headMessage, { sha: HEAD }),
]
const mergeCommits = (driftPaths) => ({
  commits: [
    commit('feat(api): x\n\nac_verified: 1,2', { sha: OLD }),
    commit("Merge branch 'main' into feature", { sha: HEAD, parents: 2 }),
  ],
  compares: [cmp(OLD, driftPaths)],
})

test('AC-1: a positive review verdict on an older sha is NOT done', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.equal(r.pass, false)
  assert.match(failureFor(r, 'Review'), /1111111/)
  assert.match(failureFor(r, 'Review'), /fffffff/)
})

test('a positive review verdict on the head sha is done', () => {
  const r = ev(good({ commits: twoCommits(), compares: [] }))
  assert.equal(status(r, 'Review'), 'satisfied')
  assert.equal(status(r, 'Spec-Review'), 'satisfied')
  assert.equal(r.pass, true, r.failures.join('\n'))
})

test('a stale verdict followed only by a docs commit stays done', () => {
  const r = ev(
    good({
      files: [API, API_SPEC, 'README.md'],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits('docs: fix a typo in the README\n\nac_verified: 1,2'),
      compares: [cmp(OLD, ['README.md'])],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
  assert.match(r.steps.find((s) => s.key === 'Review').detail, /docs/)
})

test("a base-branch merge that leaves the PR's own files alone keeps the verdict", () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      // The merge brought in base-branch files; none of them is a file this PR changes.
      ...mergeCommits(['apps/api/src/unrelated/other.service.ts', 'docs/x.md']),
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
  assert.match(r.steps.find((s) => s.key === 'Review').detail, /base/)
})

test('a merge whose conflict resolution touched a file the PR owns makes the verdict stale', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      ...mergeCommits(['apps/api/src/unrelated/other.service.ts', API]),
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.ok(failureFor(r, 'Review').includes(API), failureFor(r, 'Review'))
})

test('a review with no commit_id is unverifiable, so not done (fail closed)', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: null }), rv('Spec Review: PASS')],
      commits: twoCommits(),
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.match(failureFor(r, 'Review'), /no commit_id/)
})

test('a verdict on a commit that is no longer in the PR (force-push) is stale', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: GONE }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.match(failureFor(r, 'Review'), /no longer part of the PR/)
})

test('a stale verdict with no drift measurement fails closed', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.match(failureFor(r, 'Review'), /could not be measured/)
})

test('a truncated or unavailable drift measurement fails closed', () => {
  for (const over of [{ truncated: true }, { unavailable: true }]) {
    const r = ev(
      good({
        reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
        commits: twoCommits(),
        compares: [cmp(OLD, [], over)],
      }),
    )
    assert.equal(status(r, 'Review'), 'stale', JSON.stringify(over))
  }
})

test('an earlier FRESH positive verdict is honoured even when a later one is stale', () => {
  const r = ev(
    good({
      reviews: [
        rv('Verdict: APPROVE', { commit_id: HEAD, at: '2026-10-21T13:00:00Z' }),
        rv('Verdict: APPROVE', { commit_id: OLD, at: '2026-10-21T14:00:00Z' }),
        rv('Spec Review: PASS'),
      ],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
})

test('a fresh positive BEFORE a negative does not revive it', () => {
  const r = ev(
    good({
      reviews: [
        rv('Verdict: APPROVE', { commit_id: HEAD, at: '2026-10-21T13:00:00Z' }),
        rv('Verdict: BLOCK', { commit_id: HEAD, at: '2026-10-21T14:00:00Z' }),
        rv('Spec Review: PASS'),
      ],
      commits: twoCommits(),
    }),
  )
  assert.equal(status(r, 'Review'), 'missing')
  assert.match(failureFor(r, 'Review'), /is negative/)
})

test('a negative verdict reads as before — unchanged behaviour, not stale', () => {
  const r = ev(
    good({
      reviews: [rv('Verdict: BLOCK', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(r, 'Review'), 'missing')
  assert.match(failureFor(r, 'Review'), /is negative/)
})

test('a stale verdict is still waivable by a recorded Skip line', () => {
  const r = ev(
    good({
      body: `${FULL_BODY}Skip-Review: owner re-read the delta in the chat before merging\n`,
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(r, 'Review'), 'skipped')
  assert.equal(r.pass, true, r.failures.join('\n'))
})

// --- comment-borne verdicts: no commit_id, so the body must state the sha ----------------------

const UI = 'apps/web/app/routes/x.tsx'
const UI_SPEC = 'apps/web/app/routes/x.spec.tsx'
const uiPr = (over = {}) =>
  good({
    files: [UI, UI_SPEC],
    reviews: FULL_REVIEWS,
    commits: twoCommits(),
    ...over,
  })
const uiCmp = (base, paths, over = {}) => cmp(base, paths, { ownedAt: [UI, UI_SPEC], ...over })

test('a comment-borne verdict naming the head is done', () => {
  const r = ev(
    uiPr({
      comments: [
        cm(`QA Verdict: PASS\nCommit: ${HEAD}`),
        cm(`Design Review: PASS\nCommit: ${HEAD}`),
      ],
    }),
  )
  assert.equal(status(r, 'QA'), 'satisfied')
  assert.equal(status(r, 'Design-Review'), 'satisfied')
})

test('a comment-borne verdict may abbreviate the sha and may decorate the line', () => {
  const r = ev(
    uiPr({
      comments: [
        cm(`QA Verdict: PASS\n**Commit:** ${HEAD.slice(0, 7)}`),
        cm(`Design Review: PASS\n- Commit: ${HEAD.slice(0, 12)}`),
      ],
    }),
  )
  assert.equal(status(r, 'QA'), 'satisfied')
  assert.equal(status(r, 'Design-Review'), 'satisfied')
})

test('a comment-borne verdict with no `Commit:` line is stale, not fresh', () => {
  const r = ev(uiPr({ comments: [cm('QA Verdict: PASS'), cm('Design Review: PASS')] }))
  assert.equal(status(r, 'QA'), 'stale')
  assert.equal(status(r, 'Design-Review'), 'stale')
  assert.match(failureFor(r, 'QA'), /no `Commit: <sha>` line/)
  // The remedy for this one is the line, not another QA pass.
  assert.match(failureFor(r, 'QA'), /Add a `Commit: <sha>` line/)
})

test('a quoted or fenced `Commit:` line is not a statement', () => {
  assert.equal(statedCommit(`> Commit: ${HEAD}`), null)
  assert.equal(statedCommit('```\nCommit: abc1234\n```'), null)
  assert.equal(statedCommit(`<!--\nCommit: ${HEAD}\n-->`), null)
  assert.equal(statedCommit('Commit: ABC1234'), 'abc1234')
  assert.equal(statedCommit('Commit: abc'), null) // shorter than 7 hex characters
})

test('a comment-borne verdict naming an older commit, with code drift since, is stale', () => {
  const r = ev(
    uiPr({
      comments: [cm(`QA Verdict: PASS\nCommit: ${OLD}`), cm(`Design Review: PASS\nCommit: ${OLD}`)],
      compares: [uiCmp(OLD, [UI])],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
  assert.equal(status(r, 'Design-Review'), 'stale')
  assert.match(failureFor(r, 'QA'), /Commit:/)
})

test('a comment-borne verdict followed only by a docs commit stays done', () => {
  const r = ev(
    uiPr({
      files: [UI, UI_SPEC, 'README.md'],
      comments: [cm(`QA Verdict: PASS\nCommit: ${OLD}`)],
      compares: [uiCmp(OLD, ['README.md'], { ownedAt: [UI, UI_SPEC, 'README.md'] })],
    }),
  )
  assert.equal(status(r, 'QA'), 'satisfied')
})

test('a `Commit:` line naming a commit outside the PR is stale', () => {
  const r = ev(
    uiPr({
      comments: [cm(`QA Verdict: PASS\nCommit: ${GONE}`)],
      compares: [],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
  assert.match(failureFor(r, 'QA'), /no longer part of the PR/)
})

test('an abbreviation matching more than one commit of the PR is refused, not guessed', () => {
  const r = ev(
    uiPr({
      comments: [cm('QA Verdict: PASS\nCommit: aaaaaaa')],
      commits: [
        commit('wip: a', { sha: 'aaaaaaa1'.padEnd(40, '0') }),
        commit('wip: b', { sha: 'aaaaaaa2'.padEnd(40, '0') }),
        commit('feat: c\n\nac_verified: 1', { sha: HEAD }),
      ],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
  assert.match(failureFor(r, 'QA'), /matches 2 commits/)
})

// --- the compare plan: which drift measurements the workflow must fetch --------------------------

test('comparePlan names each distinct reference sha, never the head, and only hex shas', () => {
  const plan = comparePlan(
    withCounts(
      good({
        reviews: [
          rv('Verdict: APPROVE', { commit_id: OLD }),
          rv('Spec Review: PASS', { commit_id: OLD }),
          rv('Security Review: APPROVE', { commit_id: HEAD }),
        ],
        commits: twoCommits(),
      }),
    ),
  )
  assert.deepEqual(plan, [OLD])
})

test('comparePlan resolves the sha a comment-borne verdict states, abbreviation included', () => {
  const plan = comparePlan(
    withCounts(
      uiPr({
        comments: [cm(`QA Verdict: PASS\nCommit: ${OLD.slice(0, 8)}`)],
      }),
    ),
  )
  assert.deepEqual(plan, [OLD])
})

test('comparePlan is capped, and an unmeasured sha then fails closed', () => {
  assert.equal(typeof MAX_COMPARES, 'number')
  const commits = []
  const reviews = [rv('Spec Review: PASS')]
  for (let i = 0; i < MAX_COMPARES + 3; i++) {
    const sha = (i + 10).toString(16).padStart(2, '0').repeat(20)
    commits.push(commit(`wip: ${i}`, { sha }))
    reviews.push(
      rv('Verdict: APPROVE', {
        commit_id: sha,
        at: `2026-10-22T${String(i).padStart(2, '0')}:00:00Z`,
      }),
    )
  }
  commits.push(commit('feat: last\n\nac_verified: 1', { sha: HEAD }))
  const plan = comparePlan(withCounts(good({ reviews, commits })))
  assert.equal(plan.length, MAX_COMPARES)
  for (const sha of plan) assert.match(sha, /^[0-9a-f]{7,40}$/)
})

// --- completeness: the head must be among the listed commits -----------------------------------

test('a head sha absent from the listed commits fails closed', () => {
  const r = ev(good({ headSha: 'b'.repeat(40), commits: twoCommits() }))
  assert.equal(r.pass, false)
  assert.match(r.failures.join('\n'), /could not read the whole PR/)
})

test('a missing headSha is malformed input, not an empty head', () => {
  assert.throws(() => evaluate({ ...withCounts(good()), headSha: null }), /headSha/)
})

test('render names STALE in the table', () => {
  const pr = withCounts(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  const text = render(evaluate(pr), pr)
  assert.match(text, /\| Review \| STALE \|/)
  assert.match(text, /a fresh pass on the new code/)
})

// --- SEC-1 / SEC-2: the freshness check must not key on anything the PR author controls --------

test('SEC-1: a backdated commit must not make a comment-borne verdict read fresh', () => {
  // `committedAt` is git metadata — `git commit --date` sets it to anything. Backdated to AFTER
  // the reviewed commit but BEFORE the verdict comment, the head became the newest commit the
  // comment could have seen, and the date-keyed reference read the verdict as given on the head.
  // The verdict names its commit now, so the dates below are decoration and the drift decides.
  const r = ev(
    uiPr({
      comments: [cm(`QA Verdict: PASS\nCommit: ${OLD}`, { at: '2026-10-21T10:00:00Z' })],
      commits: [
        commit('feat: reviewed', { sha: OLD, committedAt: '2026-10-21T08:00:00Z' }),
        commit('feat: NOT reviewed\n\nac_verified: 1', {
          sha: HEAD,
          committedAt: '2026-10-21T09:00:00Z',
        }),
      ],
      compares: [uiCmp(OLD, [UI])],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
})

test('SEC-2: a path the PR reverted AFTER the verdict still counts as owned', () => {
  // `pulls/files` is the PR's NET diff, so a file reverted after the review is no longer "owned"
  // and a change to it would fall under the base-merge exemption — the verdict would survive a
  // change to code the reviewer did read.
  const REVERTED = 'apps/api/src/vacancies/reverted.service.ts'
  const r = ev(
    good({
      files: [API, API_SPEC], // REVERTED is NOT here: the PR no longer changes it
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      // It drifted between the reviewed commit and the head, and it WAS part of the PR at the
      // reviewed commit.
      compares: [cmp(OLD, [REVERTED], { ownedAt: [API, API_SPEC, REVERTED] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
})

// --- SR-M-1 / CR-M-5: a read that returned nothing is not a measurement of nothing -------------

test('SR-M-1: an EMPTY owned side is "not measured", not "the PR owned nothing"', () => {
  // A PR always changes a file (`validate` rejects an empty `files` list for that reason), so an
  // empty owned set can only mean the read did not happen. Left as a zero-path measurement it
  // produces a POSITIVE claim — "everything since touches base-branch files only" — from a compare
  // that never carried a file list. Exit 0 without the artifact.
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [], { ownedAt: [] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.match(failureFor(r, 'Review'), /could not be measured/)
})

test('an empty DRIFT side with a real owned side is a genuine "nothing moved"', () => {
  // The asymmetry is deliberate: a merge whose tree equals the reviewed commit's moves nothing,
  // and that is a real answer. Only the owned side is asserted non-empty.
  const r = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [])],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
})

// --- SR-M-2: markdown an agent reads as instructions is not exempt prose -----------------------

test('SR-M-2: a follow-up commit to `.claude/**` markdown does NOT keep a verdict', () => {
  const AGENT_DOC = '.claude/agents/coder.md'
  const r = ev(
    good({
      files: [API, API_SPEC, AGENT_DOC],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits('docs(agents): rewrite the coder rules\n\nac_verified: 1'),
      compares: [cmp(OLD, [AGENT_DOC], { ownedAt: [API, API_SPEC, AGENT_DOC] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.ok(failureFor(r, 'Review').includes(AGENT_DOC), failureFor(r, 'Review'))
})

test('SR-M-2: `.github/**` markdown is gate configuration, so it is not exempt either', () => {
  const TEMPLATE = '.github/pull_request_template.md'
  const r = ev(
    good({
      files: [API, API_SPEC, TEMPLATE],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [TEMPLATE], { ownedAt: [API, API_SPEC, TEMPLATE] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
})

test('SR-M-3: isInertDoc is an ALLOWLIST — every instruction file is excluded', () => {
  // A denylist exempted `CLAUDE.md`, the file loaded into every session. The asymmetry of being
  // wrong is the argument: a missing denylist entry silently exempts behaviour, a missing allowlist
  // entry costs one review round and the author says so. Paths below are real, from
  // `git ls-tree -r --name-only origin/main` on 2026-10-24.
  for (const p of [
    'docs/architecture/2026-10-20-xml-parser-dependency-review.md',
    'docs/architecture/2026-05-23-dev-flow-rca.md',
    'docs/business/overview.md',
    'docs/business/modules/finance.md',
    'README.md',
  ])
    assert.equal(isInertDoc(p), true, p)
  for (const p of [
    // root-level instruction files — the defect the first edition had
    'CLAUDE.md',
    'AGENTS.md',
    'CONTEXT.md',
    'GEMINI.md',
    // auto-loaded rules and agent prompts
    '.claude/rules/common/git-policy.md',
    '.claude/agents/coder.md',
    '.claude/RULES.md',
    // read on demand to decide what a LIVE rule means
    'docs/architecture/rules-rationale/verification-integrity.md',
    // upstream rule/agent copies an architect reads before adapting a pattern
    'docs/architecture/ecc-reference/RULES.upstream.md',
    // procedures agents follow
    'docs/runbooks/human-only.md',
    // vendored agent prompts, at the repository root — a denylist would not have named these
    'agents/code-reviewer.md',
    'skills/ecc/common/testing.md',
    'docs/superpowers/writing-plans.md',
    'hooks/COEXISTENCE.md',
    // gate configuration that happens to be markdown
    '.github/pull_request_template.md',
    // deliberately-rejected requests, read to avoid redoing them
    '.out-of-scope/README.md',
    // not in the allowlist: an undated architecture file, and docs outside the two subtrees
    'docs/architecture/notes.md',
    'docs/runbooks/README.md',
    'docs/design/x.md',
    'docs/legal/contract.md',
    'docs/README.md',
    'apps/api/README.md',
    // not markdown at all
    'docs/business/x.ts',
  ])
    assert.equal(isInertDoc(p), false, p)
})

test('SR-M-3: a follow-up commit touching only CLAUDE.md makes the verdict STALE', () => {
  // The predicate having the right truth value and the gate honouring it are different claims.
  const r = ev(
    good({
      files: [API, API_SPEC, 'CLAUDE.md'],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits('docs: tighten a CLAUDE.md pointer\n\nac_verified: 1'),
      compares: [cmp(OLD, ['CLAUDE.md'], { ownedAt: [API, API_SPEC, 'CLAUDE.md'] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.ok(failureFor(r, 'Review').includes('CLAUDE.md'), failureFor(r, 'Review'))
})

test('SR-M-3: a follow-up commit touching only a dated ADR keeps the verdict', () => {
  const ADR = 'docs/architecture/2026-10-24-flow-gate-verdict-staleness.md'
  const r = ev(
    good({
      files: [API, API_SPEC, ADR],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [cmp(OLD, [ADR], { ownedAt: [API, API_SPEC, ADR] })],
    }),
  )
  assert.equal(status(r, 'Review'), 'satisfied')
  assert.match(r.steps.find((s) => s.key === 'Review').detail, /docs-only/)
})

test('SR-M-3: the allowlist is checked against the tree, not invented', () => {
  // Every path the allowlist claims is inert must exist in the repository, and the two excluded
  // subtrees under docs/architecture must still be there — otherwise the dated-file rule is
  // guarding nothing and the next reader cannot tell.
  const here = dirname(fileURLToPath(import.meta.url))
  // HEAD, not `origin/main`: `actions/checkout` fetches a single ref, so `origin/main` does not
  // resolve on a runner — this test failed in CI with "Not a valid object name origin/main" while
  // passing locally. HEAD is also the more correct question, being the tree under judgement.
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
    cwd: join(here, '..', '..'),
    encoding: 'utf8',
  })
  // "I could not check the allowlist" and "the allowlist is wrong" are different findings and both
  // are RED. Skipping on an unreadable tree would report nothing and read as a pass, which is
  // `verification-integrity.md` form 1 — the defect this whole PR is about.
  assert.equal(
    ls.status,
    0,
    `COULD NOT READ THE TREE (exit ${ls.status}) — this says nothing about the allowlist: ${ls.stderr}`,
  )
  const tracked = new Set(ls.stdout.split('\n'))
  const md = [...tracked].filter(isDoc)
  assert.ok(
    md.length > 100,
    `COULD NOT READ THE TREE — only ${md.length} markdown paths came back, so the checks below would pass on an empty answer`,
  )
  for (const p of ['CLAUDE.md', 'CONTEXT.md', 'README.md', 'docs/business/overview.md'])
    assert.ok(tracked.has(p), `${p} is gone — revisit the allowlist`)
  assert.ok(
    md.some((p) => p.startsWith('docs/architecture/rules-rationale/')),
    'rules-rationale is gone — the dated-file rule may no longer be excluding anything',
  )
  assert.ok(
    md.some((p) => /^docs\/architecture\/\d{4}-\d{2}-\d{2}-/.test(p)),
    'no dated architecture record — the allowlist exempts nothing',
  )
  // The inert set must stay a small minority of the corpus: if a change ever makes most of the
  // repository's markdown exempt, the allowlist has drifted back into a denylist.
  const inert = md.filter(isInertDoc)
  assert.ok(
    inert.length > 0 && inert.length < md.length / 2,
    `${inert.length} of ${md.length} markdown files are inert — too many for an allowlist`,
  )
})

test('the WHOLE-PR docs exemption is deliberately NOT narrowed', () => {
  // `isDocsOnly` still goes by extension alone: there the reviewers the flow requires are looking
  // at the diff in front of them, where `isInertDoc` inherits a verdict given on other code.
  assert.equal(isDoc('.claude/rules/common/git-policy.md'), true)
  assert.equal(ev(bare(['.claude/rules/x.md'])).docsOnly, true)
  assert.equal(ev(bare(['CLAUDE.md'])).docsOnly, true)
})

// --- CR-M-1: for a review, `commit_id` is the only thing read ----------------------------------

test('CR-M-1: a `Commit:` line in a REVIEW body cannot override its recorded commit_id', () => {
  // Downgrade attempt: the review was submitted against OLD, and its body claims the head.
  const stale = ev(
    good({
      reviews: [
        rv(`Verdict: APPROVE\nCommit: ${HEAD}`, { commit_id: OLD }),
        rv('Spec Review: PASS'),
      ],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(stale, 'Review'), 'stale')
  assert.match(failureFor(stale, 'Review'), /1111111/)
  // And the reverse: a body naming an older commit cannot make a head review stale.
  const fresh = ev(
    good({
      reviews: [
        rv(`Verdict: APPROVE\nCommit: ${OLD}`, { commit_id: HEAD }),
        rv('Spec Review: PASS'),
      ],
      commits: twoCommits(),
      compares: [cmp(OLD, [API])],
    }),
  )
  assert.equal(status(fresh, 'Review'), 'satisfied')
})

// --- CR-M-2: mutations that survived a scratch-copy run ----------------------------------------

test('CR-M-2: a stated sha is resolved by PREFIX, not by substring', () => {
  // `abcdef1` occurs INSIDE the commit sha but does not begin it. Resolving by substring would
  // accept it as naming that commit; resolving by prefix does not, and an unresolved sha is stale.
  const sha = `0abcdef1${'0'.repeat(32)}`
  assert.equal(sha.includes('abcdef1'), true)
  assert.equal(sha.startsWith('abcdef1'), false)
  const r = ev(
    uiPr({
      comments: [cm('QA Verdict: PASS\nCommit: abcdef1')],
      commits: [commit('wip: a', { sha }), commit('feat: b\n\nac_verified: 1', { sha: HEAD })],
      compares: [],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
  assert.match(failureFor(r, 'QA'), /no longer part of the PR/)
})

test('CR-M-2: comparePlan skips a sha that is not one of the PR commits', () => {
  // Nothing to measure against a commit the PR does not contain, and the verdict is stale on the
  // membership check alone — asking the API for it would be a read with no question behind it.
  const plan = comparePlan(
    withCounts(
      good({
        reviews: [rv('Verdict: APPROVE', { commit_id: GONE }), rv('Spec Review: PASS')],
        commits: twoCommits(),
      }),
    ),
  )
  assert.deepEqual(plan, [])
})

test('CR-M-2: comparePlan emits hex only — a sha is interpolated into an API path', () => {
  for (const bad of ['../../../etc/passwd', 'main;rm -rf /', 'z'.repeat(40), 'HEAD']) {
    const plan = comparePlan(
      withCounts(
        good({
          reviews: [rv('Verdict: APPROVE', { commit_id: bad }), rv('Spec Review: PASS')],
          commits: [
            commit('wip: a', { sha: bad }),
            commit('feat: b\n\nac_verified: 1', { sha: HEAD }),
          ],
        }),
      ),
    )
    assert.deepEqual(plan, [], bad)
  }
})

test('CR-M-2: a drift or owned list AT the 300-file cap is truncated, not complete', () => {
  const many = (n, pre) => Array.from({ length: n }, (_, i) => `${pre}/f${i}.ts`)
  const at = MAX_COMPARE_FILES
  for (const over of [
    { paths: many(at, 'base'), ownedAt: [API, API_SPEC] },
    { paths: [], ownedAt: many(at, 'own') },
  ]) {
    const r = ev(
      good({
        reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
        commits: twoCommits(),
        compares: [{ base: OLD, truncated: false, ...over }],
      }),
    )
    assert.equal(status(r, 'Review'), 'stale', JSON.stringify(Object.keys(over)))
    assert.match(failureFor(r, 'Review'), /too large to list in full/)
  }
  // One file under the cap, and the same lists are a complete answer.
  const ok = ev(
    good({
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [{ base: OLD, truncated: false, paths: many(at - 1, 'base'), ownedAt: [API] }],
    }),
  )
  assert.equal(status(ok, 'Review'), 'satisfied')
})

// --- CR-M-3: the original SEC-1 exploit, as it was before the `Commit:` line existed -----------

test('SEC-1b: the original exploit — no `Commit:` line at all, head backdated', () => {
  // This is the shape that read `done` before the fix: the verdict comment said nothing about
  // which commit it judged, and the head's committer date was set to before the comment.
  const r = ev(
    uiPr({
      comments: [cm('QA Verdict: PASS', { at: '2026-10-21T10:00:00Z' })],
      commits: [
        { sha: OLD, message: 'feat: reviewed', parents: 1, committedAt: '2026-10-21T08:00:00Z' },
        {
          sha: HEAD,
          message: 'feat: NOT reviewed\n\nac_verified: 1',
          parents: 1,
          committedAt: '2026-10-21T09:00:00Z', // backdated to before the comment
        },
      ],
      compares: [uiCmp(OLD, [UI])],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
  // And the reason is the absent statement, not a date comparison.
  assert.match(failureFor(r, 'QA'), /no `Commit: <sha>` line/)
})

// --- CR-M-4: what the date-read guard actually covers, said plainly ----------------------------

test('no BARE date read in the gate or the workflow (a lexical tripwire, not a proof)', () => {
  // SEC-1 was freshness keyed on a committer date, which the committer sets. This scans for the
  // shapes that regression would most likely take and NOTHING MORE: it is defeated by
  // `c['committer']['date']`, by destructuring, and by any timestamp field not named below. It is
  // a tripwire on the obvious path, and the property it guards is argued in `referenceSha`.
  const here = dirname(fileURLToPath(import.meta.url))
  const DATE_RE = /committedAt|committer\.date|author\.date|pushedAt|\.date\b/
  const src = readFileSync(join(here, 'flow-gate.mjs'), 'utf8')
    .split('\n')
    .filter((l) => DATE_RE.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
  assert.deepEqual(src, [], `flow-gate.mjs reads a commit date again:\n${src.join('\n')}`)
  // The workflow is scanned too: it is where the field would be re-introduced into the input, and
  // CR-M-4 noted the first edition of this test never looked outside the .mjs.
  for (const f of ['../../.github/workflows/flow-gate.yml', 'flow-gate-compare.jq']) {
    const lines = readFileSync(join(here, f), 'utf8')
      .split('\n')
      .filter((l) => DATE_RE.test(l) && !/^\s*#/.test(l))
    assert.deepEqual(lines, [], `${f} carries a commit date again:\n${lines.join('\n')}`)
  }
})

// --- the compare filter: the workflow's jq, under test ----------------------------------------
//
// It lived only in YAML, where both of the round-2 security findings sat and where the single
// `previous_filename` term that keeps the rename bypass closed would have regressed in silence.

const JQ_FILTER = join(dirname(fileURLToPath(import.meta.url)), 'flow-gate-compare.jq')

/** Run the real filter the workflow runs, on crafted compare responses. */
const runFilter = (drift, owned, base = '1'.repeat(40)) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-gate-jq-'))
  const d = join(dir, 'drift.json')
  const o = join(dir, 'owned.json')
  writeFileSync(d, JSON.stringify(drift))
  writeFileSync(o, JSON.stringify(owned))
  const res = spawnSync(
    'jq',
    [
      '-n',
      '--arg',
      'base',
      base,
      '--slurpfile',
      'drift',
      d,
      '--slurpfile',
      'owned',
      o,
      '-f',
      JQ_FILTER,
    ],
    { encoding: 'utf8' },
  )
  // A missing jq must fail this test, not skip it: a filter nobody ran is the defect one level up.
  assert.equal(res.status, 0, `jq exited ${res.status}: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

const fileList = (...names) => ({ files: names.map((filename) => ({ filename })) })

test('the compare filter: both names of a rename reach `paths` (the docs-exemption bypass)', () => {
  // Approve `apps/api/src/finance/x.ts`, then rename it to `docs/x.md`: without the rename SOURCE
  // the drift would list only the `.md` name and the docs exemption would carry the verdict.
  const out = runFilter(
    {
      files: [
        {
          filename: 'docs/x.md',
          previous_filename: 'apps/api/src/finance/x.ts',
          status: 'renamed',
        },
      ],
    },
    fileList('apps/api/src/finance/x.ts'),
  )
  assert.deepEqual(out.paths.sort(), ['apps/api/src/finance/x.ts', 'docs/x.md'])
  assert.deepEqual(out.ownedAt, ['apps/api/src/finance/x.ts'])
  assert.equal(out.truncated, false)
  assert.equal(out.unavailable, undefined)
  // End to end: the renamed-away critical file is in both sets, so the verdict goes stale.
  const r = ev(
    good({
      files: [
        'docs/x.md',
        { filename: 'docs/x.md', previous_filename: 'apps/api/src/finance/x.ts' },
      ],
      reviews: [
        rv('Verdict: APPROVE', { commit_id: OLD }),
        rv('Security Review: APPROVE', { commit_id: OLD }),
        rv('Spec Review: PASS'),
      ],
      commits: twoCommits(),
      compares: [{ base: OLD, truncated: false, ...out }],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
})

test('the compare filter: a response that succeeded with NO file list is unavailable', () => {
  for (const [drift, owned, label] of [
    [{}, fileList('a.ts'), 'drift has no files key'],
    [fileList('a.ts'), {}, 'owned has no files key'],
    [{ files: null }, fileList('a.ts'), 'drift files is null'],
    [fileList('a.ts'), { files: 'nope' }, 'owned files is not an array'],
    [{}, {}, 'neither has files'],
  ]) {
    const out = runFilter(drift, owned)
    assert.equal(out.unavailable, true, label)
    assert.equal(out.paths, undefined, label)
  }
})

test('the compare filter: an honestly empty file list is a measurement, not unavailable', () => {
  const out = runFilter({ files: [] }, fileList('a.ts'))
  assert.equal(out.unavailable, undefined)
  assert.deepEqual(out.paths, [])
  assert.deepEqual(out.ownedAt, ['a.ts'])
})

test('the compare filter: a list at the cap is truncated, on either side', () => {
  const many = (n) => ({ files: Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts` })) })
  assert.equal(runFilter(many(MAX_COMPARE_FILES), fileList('a.ts')).truncated, true)
  assert.equal(runFilter(fileList('a.ts'), many(MAX_COMPARE_FILES)).truncated, true)
  assert.equal(runFilter(many(MAX_COMPARE_FILES - 1), fileList('a.ts')).truncated, false)
})

test('the compare filter and the gate agree on the cap', () => {
  // Code lines only: the header's prose mentions a jq version with a `>=` in it, and a number in a
  // comment is not a cap. (It caught that comment when it was first written, which is the test
  // working — but the assertion is about the filter, so the scope is the filter.)
  const jq = readFileSync(JQ_FILTER, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  const caps = [...jq.matchAll(/>=\s*(\d+)/g)].map((m) => Number(m[1]))
  assert.ok(caps.length > 0, 'the filter states no cap')
  for (const c of caps) assert.equal(c, MAX_COMPARE_FILES)
})

test('the workflow runs the filter from its file, not a copy inline', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const wf = readFileSync(join(here, '..', '..', '.github', 'workflows', 'flow-gate.yml'), 'utf8')
  assert.match(wf, /-f scripts\/architect\/flow-gate-compare\.jq/)
  assert.doesNotMatch(wf, /def paths:/, 'the filter is inline again — the tested file is bypassed')
})

// --- CR-M-9: an allowlist whose anchors are untested is a prefix list that matches anywhere -----

test('CR-M-9: the inert allowlist is ANCHORED — a prefixed or nested path is not inert', () => {
  // These are the three shapes the truth table above cannot reach, and each one is a real mutation
  // that survived: dropping the `^`, matching `docs/business/` with `includes`, and letting the
  // dated-ADR pattern span a subdirectory. All three would put agent-read territory inside the
  // allowlist — the same defect as the `!p.includes('/')` edition, one level deeper.
  for (const p of [
    // `docs/business/` reached by substring rather than prefix
    '.claude/skills/x/docs/business/y.md',
    'apps/api/docs/business/notes.md',
    // the dated-ADR pattern reached without the `^` anchor
    '.claude/skills/x/docs/architecture/2026-01-01-y.md',
    'vendor/docs/architecture/2026-01-01-y.md',
    // a dated name that is really a directory: `[^/]+` must not become `.+`
    'docs/architecture/2026-01-01-sub/y.md',
    'docs/architecture/2026-01-01-a/b/c.md',
    // and the root README is the root one only
    'vendor/README.md',
  ])
    assert.equal(isInertDoc(p), false, p)
  // The happy cases still hold, so the anchoring did not simply disable the allowlist.
  assert.equal(isInertDoc('docs/architecture/2026-01-01-y.md'), true)
  assert.equal(isInertDoc('docs/business/y.md'), true)
  assert.equal(isInertDoc('README.md'), true)
})

// --- CR-M-8: the join between a verdict's sha and its own drift measurement ---------------------

test('CR-M-8: each verdict is judged by ITS OWN drift measurement, matched by sha', () => {
  // Every other `compares:` fixture holds one entry, so `find(c => c.base === ref.sha)` could be
  // replaced by `compares[0]` and nothing noticed. The join key is the core of the rule: with two
  // reviewed shas, the wrong measurement judging a verdict is a small drift excusing an older
  // review — the failure this PR exists to prevent, reintroduced by fixture shape.
  const SPEC_SHA = '3'.repeat(40)
  const r = ev(
    good({
      files: [API, API_SPEC, 'README.md'],
      reviews: [
        // reviewed OLD; code changed since → must be STALE
        rv('Verdict: APPROVE', { commit_id: OLD }),
        // reviewed SPEC_SHA; only the root README changed since → must stay fresh
        rv('Spec Review: PASS', { commit_id: SPEC_SHA }),
      ],
      commits: [
        commit('wip: a', { sha: OLD }),
        commit('wip: b', { sha: SPEC_SHA }),
        commit('feat: c\n\nac_verified: 1', { sha: HEAD }),
      ],
      compares: [
        // Deliberately FIRST, and deliberately harmless: `compares[0]` would excuse the Review.
        cmp(SPEC_SHA, ['README.md'], { ownedAt: [API, API_SPEC, 'README.md'] }),
        cmp(OLD, [API], { ownedAt: [API, API_SPEC] }),
      ],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.ok(failureFor(r, 'Review').includes(API), failureFor(r, 'Review'))
  assert.equal(status(r, 'Spec-Review'), 'satisfied')
})

test('CR-M-8: the sha join is EQUALITY — an entry whose base is a prefix does not match', () => {
  // `ref.sha === c.base` must not weaken to `ref.sha.startsWith(c.base)`: an abbreviated or
  // truncated base would then capture a verdict and answer for a measurement that is not its own.
  const r = ev(
    good({
      files: [API, API_SPEC, 'README.md'],
      reviews: [rv('Verdict: APPROVE', { commit_id: OLD }), rv('Spec Review: PASS')],
      commits: twoCommits(),
      compares: [
        // base is a strict PREFIX of the reviewed sha, and harmless; it must be ignored.
        cmp(OLD.slice(0, 7), ['README.md'], { ownedAt: [API, API_SPEC, 'README.md'] }),
        cmp(OLD, [API], { ownedAt: [API, API_SPEC] }),
      ],
    }),
  )
  assert.equal(status(r, 'Review'), 'stale')
  assert.ok(failureFor(r, 'Review').includes(API), failureFor(r, 'Review'))
})

// --- CR-M-10: `statedCommit` selection and shape, as documented --------------------------------

test('CR-M-10: the FIRST `Commit:` line of a comment is the statement', () => {
  // The docstring says first-match, and the round-1 attack list rested on it: appending a line to
  // an existing verdict comment must not be able to re-point it.
  assert.equal(statedCommit(`Commit: ${OLD}\nCommit: ${HEAD}`), OLD)
  assert.equal(statedCommit(`QA Verdict: PASS\nCommit: ${OLD}\n\nlater: Commit: ${HEAD}`), OLD)
  // End to end: the appended second line cannot make a stale verdict read fresh.
  const r = ev(
    uiPr({
      comments: [cm(`QA Verdict: PASS\nCommit: ${OLD}\nCommit: ${HEAD}`)],
      compares: [uiCmp(OLD, [UI])],
    }),
  )
  assert.equal(status(r, 'QA'), 'stale')
})

test('CR-M-10: a `Commit:` reference mid-sentence is not a statement', () => {
  // Dropping the `^` anchor would let prose about an earlier commit count as the claim; dropping
  // the `\\b` would let a 41st hex character be silently truncated into a valid-looking sha.
  assert.equal(statedCommit(`the earlier Commit: ${OLD} was superseded`), null)
  assert.equal(statedCommit(`see Commit: ${HEAD}`), null)
  assert.equal(statedCommit(`Commit: ${'a'.repeat(41)}`), null)
  assert.equal(statedCommit(`Commit: ${OLD}x`), null)
  // A legitimate statement still reads, including an abbreviation and trailing prose.
  assert.equal(statedCommit('Commit: abc1234 (the head when I looked)'), 'abc1234')
})
