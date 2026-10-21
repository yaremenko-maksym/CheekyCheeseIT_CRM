#!/usr/bin/env node
// Flow Gate — the project's development flow is the default for every PR; skipping a step is a
// deliberate, recorded act.
//
// Why. On 2026-10-21 an audit found that every PR merged by a second collaborator reached `main`
// with zero reviews, although each touched a critical-path zone. The flow (task → plan → tests →
// review → security/spec/copy review → QA/design → AC) existed only as procedure inside the
// owner's Master pipeline, which another harness (Codex, a person at a keyboard) never runs. The
// owner's decision: the flow is the default for EVERYONE — owner, collaborator, any harness — and
// a step may be skipped only by a named line in the PR body that says why.
//
// What this is NOT: a defence against a malicious write-role user. Anyone with write access can
// post a review that says `Verdict: APPROVE`, or write a `Skip-<Step>:` line. The point is that
// every skipped step leaves a visible, attributable record instead of silence. Three cheap guards
// are kept because they cost nothing to the honest flow: verdicts count only from accounts with
// a repository association (OWNER / MEMBER / COLLABORATOR — the repo is public, and any GitHub
// user can comment), both names of a renamed file are classified, and a PR the API could not list
// in full fails instead of being judged on the part that was read.
//
// Each step is either satisfied by EVIDENCE or skipped by a PR-body line `Skip-<Step>: <reason>`
// (key case-insensitive, reason at least MIN_REASON_LENGTH characters). One exemption: a docs-only
// diff (every changed path, and every rename source, ends in `.md`) passes outright — the
// light-track rule. Non-markdown files under `.claude/` (hooks, settings, scripts) are executable
// process config, not documentation: they go through the steps, and hooks/settings are critical.
// The step table is STEPS below; the contract is `.claude/agents/contracts.md` §4.1.
//
// The decision is a pure function (`evaluate`); the CLI only reads a JSON file and prints.
// Tests: scripts/architect/flow-gate.test.mjs. Wiring: .github/workflows/flow-gate.yml.
//
// Usage:  node scripts/architect/flow-gate.mjs --input <pr-data.json> [--summary <file>]
// Exit:   0 PASS · 1 FAIL · 2 malformed input (never 0 on input it could not read)

import { readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MIN_REASON_LENGTH = 10

// ---------------------------------------------------------------------------------------------
// Path classes

// Glob → anchored RegExp. `*` stays within one segment; a double star followed by a slash spans
// zero or more whole segments; a trailing double star matches everything below.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

const matcher = (globs) => {
  const res = globs.map(globToRegExp)
  return (path) => res.some((re) => re.test(path))
}

// Critical-path zones — derived from `.claude/agents/contracts.md` §2.1 (the canonical table; when
// it changes, change this list). Every glob was checked against the tree on 2026-10-21 rather
// than guessed: there is no `transactions/`, `wallet*/`, `company-account/` or `rbac/` DIRECTORY in
// the API — transactions and the company account are files inside `finance/`, RBAC lives in
// `common/guards/roles.guard.ts`, `*-visibility.util.ts`, `*rbac*.util.ts`, `users/role-guards.util.ts`
// — so those zones are matched by file-name globs, which keep matching if such a directory appears.
// Migrations are `apps/api/drizzle/**` (there is no `migrations/` directory in the product).
export const CRITICAL_PATH_GLOBS = Object.freeze([
  // auth / sessions / JWT / OAuth
  'apps/api/src/**/auth/**',
  '**/*.guard.ts',
  // finance / calculation logic / split math / rates
  'apps/api/src/**/finance/**',
  'packages/shared/src/**/finance/**',
  // wallets / transactions / company-account (USDT)
  'apps/api/src/**/*transaction*',
  'apps/api/src/**/*transaction*/**',
  'apps/api/src/**/*wallet*',
  'apps/api/src/**/*company-account*',
  // RBAC / role visibility / data masking
  'apps/api/src/**/*rbac*',
  'apps/api/src/**/*visibility*',
  'apps/api/src/**/*role*',
  'apps/api/src/database/privileges/**',
  'apps/api/src/database/*privilege*',
  'packages/shared/src/schemas/view-permissions.ts',
  'packages/shared/src/types/roles.ts',
  // Drizzle migrations / new tables
  'apps/api/drizzle/**',
  'apps/api/drizzle.config.ts',
  '**/schema.ts',
  'apps/api/src/database/schema/**',
  // webhooks (signature verification is an auth surface)
  '**/*webhook*',
  // CI/CD pipeline, the agent-process hooks and their registration, and this gate itself — each
  // of them gates the whole process
  '.github/workflows/**',
  '.claude/hooks/**',
  '.claude/settings*.json',
  'scripts/architect/flow-gate*',
])

// User-visible text catalogs (measured): the Lingui catalogs and the landing's own dictionaries.
export const COPY_GLOBS = Object.freeze([
  'packages/shared/src/i18n/locales/**',
  'apps/landing/app/i18n/dictionaries/**',
])

export const isCritical = matcher(CRITICAL_PATH_GLOBS)
export const isCopy = matcher(COPY_GLOBS)
/** Documentation is markdown — nothing else, wherever it lives. */
export const isDoc = (p) => p.endsWith('.md')
export const isTestFile = (p) =>
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) || p.includes('/__tests__/') || p.startsWith('apps/e2e/')
/** Non-test product code: under apps/ or packages/, not a test file, not markdown. */
export const isProductCode = (p) =>
  (p.startsWith('apps/') || p.startsWith('packages/')) && !isTestFile(p) && !p.endsWith('.md')
export const isUiCode = (p) =>
  (p.startsWith('apps/web/') || p.startsWith('apps/landing/')) &&
  !isTestFile(p) &&
  !p.endsWith('.md')

export function isDocsOnly(paths) {
  return paths.length > 0 && paths.every(isDoc)
}

// Repository associations whose verdicts count. The repo is public: any GitHub user can post a
// comment or a COMMENT review, so `NONE` / `CONTRIBUTOR` / `FIRST_TIMER` etc. are ignored — both
// their positive and their negative verdicts. The PR author is NOT excluded: the owner's review
// agents post under the owner's account, and the owner authors his own PRs.
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR'])
const trusted = (it) => TRUSTED_ASSOCIATIONS.includes(it.association)

// The REST lists cap out: pulls/files at 3000 entries, pulls/commits at 250.
export const MAX_LISTED_FILES = 3000
export const MAX_LISTED_COMMITS = 250

/** Normalise the pulls/files list: entries + every path to classify (current AND rename source). */
export function normalizeFiles(files) {
  const entries = files.map((f) =>
    typeof f === 'string' ? { filename: f, previous_filename: null, status: 'modified' } : f,
  )
  const paths = []
  for (const e of entries) {
    paths.push(e.filename)
    // A rename moves a file OUT of somewhere: the source path must be judged too, or renaming
    // `apps/api/src/auth/x.ts` to `notes/x.md` would read as docs-only and non-critical.
    if (e.previous_filename) paths.push(e.previous_filename)
  }
  return { entries, paths }
}

/** Fail-closed completeness: did the fetch list the whole PR? Returns a problem or null. */
export function completenessProblem(pr, entries) {
  const want = pr.counts ?? {}
  const issues = []
  if (typeof want.changedFiles !== 'number' || typeof want.commits !== 'number') {
    issues.push("the PR's own file/commit counts were not provided")
  } else {
    if (want.changedFiles >= MAX_LISTED_FILES)
      issues.push(
        `the PR changes ${want.changedFiles} files — the API lists at most ${MAX_LISTED_FILES}`,
      )
    else if (entries.length !== want.changedFiles)
      issues.push(`listed ${entries.length} changed files, the PR reports ${want.changedFiles}`)
    if (want.commits >= MAX_LISTED_COMMITS)
      issues.push(
        `the PR has ${want.commits} commits — the API lists at most ${MAX_LISTED_COMMITS}`,
      )
    else if (pr.commits.length !== want.commits)
      issues.push(`listed ${pr.commits.length} commits, the PR reports ${want.commits}`)
  }
  return issues.length
    ? `Completeness — could not read the whole PR (${issues.join('; ')}). Split the PR, or re-run the check (push, body edit or label); a skip line cannot cover a PR that was not read.`
    : null
}

// ---------------------------------------------------------------------------------------------
// PR-body lines

const lineRe = (key) =>
  new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${key.replace(/-/g, '\\-')}:[ \\t]*(.*)$`, 'im')

/** The value of a `Key: value` line in the PR body (trimmed), or null when there is no such line. */
export function bodyLine(body, key) {
  const m = lineRe(key).exec(String(body ?? ''))
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------------------------------------
// Verdict markers

// A verdict is stated on its own line — by contract the first line of the review
// (`code-review-discipline` §1, `contracts.md` §4). Markdown decoration (`**…**`, `## …`, `> …`)
// is tolerated; for each marker kind the FIRST matching line of a body is its verdict, so a body
// that later quotes an earlier verdict cannot flip it, and a verdict mid-sentence is no marker.
export const MARKERS = Object.freeze({
  review: { prefix: 'Verdict', pos: ['APPROVE'], neg: ['BLOCK'] },
  security: { prefix: 'Security Review', pos: ['APPROVE'], neg: ['BLOCK'] },
  spec: { prefix: 'Spec Review', pos: ['PASS'], neg: ['ISSUES', 'BLOCK'] },
  copy: { prefix: 'Copy Review', pos: ['PASS'], neg: ['ISSUES', 'BLOCK'] },
  qa: { prefix: 'QA Verdict', pos: ['PASS'], neg: ['FAIL'] },
  // ui-ux-designer.md posts `Design Review: PASS | POLISH-REQUESTED | BLOCK`; APPROVE is accepted
  // as a synonym because the first draft of this contract used it.
  design: { prefix: 'Design Review', pos: ['PASS', 'APPROVE'], neg: ['POLISH-REQUESTED', 'BLOCK'] },
})

export function parseMarker(body, kind) {
  const { prefix, pos, neg } = MARKERS[kind]
  const values = [...pos, ...neg].sort((a, b) => b.length - a.length)
  const re = new RegExp(`^${prefix}:\\s*(${values.join('|')})(?![A-Z-])`)
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*_`-]+/, '').replace(/[*_`]+/g, '')
    const m = re.exec(line)
    if (m) return pos.includes(m[1]) ? 'pos' : 'neg'
  }
  return null
}

const ts = (s) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The standing verdict of one kind: the LATEST counting marker decides. Only items from a trusted
 * repository association count (TRUSTED_ASSOCIATIONS), positive and negative alike. A PENDING item was never
 * submitted; a DISMISSED positive no longer stands; a negative counts in any submitted state —
 * dismissing must not be a way to make a block disappear.
 * @returns {{state:'pos'|'neg'|null, item:object|null}}
 */
export function standingVerdict(items, kind) {
  let latest = null
  for (const it of items) {
    if (it.state === 'PENDING' || !trusted(it)) continue
    const v = parseMarker(it.body, kind)
    if (!v || (v === 'pos' && it.state === 'DISMISSED')) continue
    if (!latest || ts(it.at) >= ts(latest.item.at)) latest = { state: v, item: it }
  }
  return latest ?? { state: null, item: null }
}

// ---------------------------------------------------------------------------------------------
// The flow

const verdictStep = (key, kind, sources, agent, required, whenText) => ({
  key,
  whenText,
  required,
  evidenceText: `a ${sources === 'reviews' ? 'review' : 'review or PR comment'} whose verdict line is \`${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}\`, with no negative verdict after it`,
  check: (ctx) => {
    const items = sources === 'reviews' ? ctx.reviews : [...ctx.reviews, ...ctx.comments]
    const v = standingVerdict(items, kind)
    if (v.state === 'pos')
      return { ok: true, evidence: `\`${MARKERS[kind].prefix}\` positive by @${v.item.author}` }
    if (v.state === 'neg')
      return {
        ok: false,
        why: `the latest \`${MARKERS[kind].prefix}:\` verdict (by @${v.item.author}, ${v.item.at}) is negative`,
        fix: `Address it and get a new \`${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}\``,
      }
    return {
      ok: false,
      why: `no "${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}" ${sources === 'reviews' ? 'review' : 'review or comment'}`,
      fix: `Run ${agent}`,
    }
  },
})

/** The step table. Order = the order of the flow. */
export const STEPS = Object.freeze([
  {
    key: 'Task',
    whenText: 'always',
    required: () => true,
    evidenceText:
      'a PR-body line `Task: <path or issue link>` (declared, not verified — task files are gitignored)',
    check: (ctx) =>
      ctx.task
        ? { ok: true, evidence: `Task: ${ctx.task}` }
        : {
            ok: false,
            why: 'no "Task: <path or issue link>" line in the PR body',
            fix: 'Add "Task: <path or issue link>"',
          },
  },
  {
    key: 'Plan',
    whenText: 'always',
    required: () => true,
    evidenceText: 'a PR-body line `Plan: <where the plan is>`',
    check: (ctx) => {
      const plan = bodyLine(ctx.body, 'Plan')
      return plan
        ? { ok: true, evidence: `Plan: ${plan}` }
        : {
            ok: false,
            why: 'no "Plan: <where>" line in the PR body',
            fix: 'Add "Plan: <where the plan is>"',
          }
    },
  },
  {
    key: 'Tests',
    whenText: 'the diff changes non-test product code under `apps/` or `packages/`',
    required: (ctx) => ctx.files.some(isProductCode),
    evidenceText:
      'the diff also changes a test file (`*.spec|test.*`, `__tests__/`, `apps/e2e/**`)',
    check: (ctx) => {
      const t = ctx.files.filter(isTestFile)
      return t.length
        ? { ok: true, evidence: `${t.length} test file(s) changed` }
        : {
            ok: false,
            why: 'product code changed but no test file did',
            fix: 'Add or update a test',
          }
    },
  },
  verdictStep('Review', 'review', 'reviews', 'code-reviewer', () => true, 'always'),
  verdictStep(
    'Security-Review',
    'security',
    'reviews',
    'security-reviewer',
    (ctx) => ctx.files.some(isCritical),
    'the diff touches a critical-path zone (`contracts.md` §2.1)',
  ),
  verdictStep(
    'Spec-Review',
    'spec',
    'reviews',
    'spec-reviewer',
    (ctx) => Boolean(ctx.task),
    'a `Task:` line is declared',
  ),
  verdictStep(
    'Copy-Review',
    'copy',
    // copy-reviewer.md posts its verdict as a PR comment, not only as a review — read both.
    'both',
    'copy-reviewer',
    (ctx) => ctx.files.some(isCopy),
    'the diff touches i18n catalogs or landing dictionaries',
  ),
  verdictStep(
    'QA',
    'qa',
    'both',
    'manual-qa',
    (ctx) => ctx.files.some(isUiCode),
    'the diff touches non-test UI code (`apps/web/`, `apps/landing/`)',
  ),
  verdictStep(
    'Design-Review',
    'design',
    'both',
    'ui-ux-designer (Mode B)',
    (ctx) => ctx.files.some(isUiCode),
    'the diff touches non-test UI code (`apps/web/`, `apps/landing/`)',
  ),
  {
    key: 'AC',
    whenText: 'always',
    required: () => true,
    evidenceText: 'the last non-`wip:`, non-merge commit carries an `ac_verified:` line',
    check: (ctx) => {
      const c = lastWorkCommit(ctx.commits)
      if (!c)
        return {
          ok: false,
          why: 'every commit is `wip:` or a merge — there is no final commit',
          fix: 'Make a final commit with "ac_verified: <AC numbers>"',
        }
      return /^ac_verified:/m.test(c.message)
        ? {
            ok: true,
            evidence: `\`ac_verified:\` in ${String(c.sha ?? '').slice(0, 7) || 'the last commit'}`,
          }
        : {
            ok: false,
            why: `the last non-wip commit (${String(c.sha ?? '').slice(0, 7)} "${firstLine(c.message)}") has no \`ac_verified:\` line`,
            fix: 'Amend or add a final commit with "ac_verified: <AC numbers>"',
          }
    },
  },
])

const firstLine = (m) =>
  String(m ?? '')
    .split('\n')[0]
    .slice(0, 72)

/** Commits are in PR order (oldest first). Merge commits and `wip` commits are not final work. */
export function lastWorkCommit(commits) {
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]
    if ((c.parents ?? 1) > 1) continue
    if (/^wip\b/i.test(firstLine(c.message))) continue
    return c
  }
  return null
}

/**
 * Evaluate the gate. Pure.
 * @param {object} pr
 * @param {Array<string|{filename:string,previous_filename?:string|null,status?:string}>} pr.files
 *        changed files as the pulls/files API returns them (a bare path is accepted)
 * @param {{changedFiles:number, commits:number}} pr.counts  the PR's own counts (completeness)
 * @param {string}   pr.body      PR description ('' when empty)
 * @param {Array<{author:string,association:string,state:string,body:string,at:string}>} pr.reviews
 * @param {Array<{author:string,association:string,body:string,at:string}>} pr.comments  PR comments
 * @param {Array<{sha:string,message:string,parents?:number}>} pr.commits  oldest first
 */
export function evaluate(pr) {
  const problems = validate(pr)
  if (problems.length) {
    const err = new Error(`malformed input: ${problems.join('; ')}`)
    err.code = 'MALFORMED'
    throw err
  }
  const { entries, paths } = normalizeFiles(pr.files)
  const incomplete = completenessProblem(pr, entries)
  if (incomplete) {
    return { pass: false, docsOnly: false, steps: [], failures: [incomplete], skips: [] }
  }
  if (isDocsOnly(paths)) {
    return { pass: true, docsOnly: true, steps: [], failures: [], skips: [] }
  }
  const ctx = {
    ...pr,
    files: paths,
    comments: pr.comments.map((c) => ({ ...c, state: 'COMMENTED' })),
    task: bodyLine(pr.body, 'Task') || null,
  }
  const steps = []
  for (const s of STEPS) {
    if (!s.required(ctx)) {
      steps.push({ key: s.key, status: 'not-required', detail: `required when ${s.whenText}` })
      continue
    }
    const r = s.check(ctx)
    if (r.ok) {
      steps.push({ key: s.key, status: 'satisfied', detail: r.evidence })
      continue
    }
    const skip = bodyLine(pr.body, `Skip-${s.key}`)
    if (skip !== null && skip.length >= MIN_REASON_LENGTH) {
      steps.push({ key: s.key, status: 'skipped', detail: skip })
      continue
    }
    const shortNote =
      skip !== null
        ? ` (a "Skip-${s.key}:" line is present, but its reason is shorter than ${MIN_REASON_LENGTH} characters)`
        : ''
    steps.push({
      key: s.key,
      status: 'missing',
      detail: `${s.key} — ${r.why}${shortNote}. ${r.fix}, or add "Skip-${s.key}: <why>" to the PR body.`,
    })
  }
  const failures = steps.filter((s) => s.status === 'missing').map((s) => s.detail)
  const skips = steps
    .filter((s) => s.status === 'skipped')
    .map((s) => ({ step: s.key, reason: s.detail }))
  return { pass: failures.length === 0, docsOnly: false, steps, failures, skips }
}

function validate(pr) {
  if (!pr || typeof pr !== 'object') return ['input is not an object']
  const p = []
  for (const k of ['files', 'reviews', 'comments', 'commits'])
    if (!Array.isArray(pr[k])) p.push(`${k} must be an array`)
  if (typeof pr.body !== 'string') p.push('body must be a string (empty when the PR has none)')
  // A PR always changes a file and has a commit. An empty list means the fetch did not happen —
  // and an instrument that did not look must not report "docs-only" or "nothing to check".
  if (Array.isArray(pr.files) && pr.files.length === 0)
    p.push('files is empty — the changed-file fetch returned nothing')
  if (Array.isArray(pr.commits) && pr.commits.length === 0)
    p.push('commits is empty — the commit fetch returned nothing')
  return p
}

// ---------------------------------------------------------------------------------------------
// CLI

const ICON = { satisfied: 'done', skipped: 'SKIPPED', 'not-required': 'n/a', missing: 'MISSING' }

export function render(result, pr) {
  const lines = [`## Flow Gate: ${result.pass ? 'PASS' : 'FAIL'}`, '']
  lines.push(
    `changed files: ${pr.files.length} · reviews: ${pr.reviews.length} · comments: ${pr.comments.length} · commits: ${pr.commits.length}`,
    '',
  )
  if (result.docsOnly) {
    lines.push('Docs-only diff (every path `*.md` or under `.claude/`) — exempt, light-track.')
  } else {
    lines.push('| Step | Status | Detail |', '| --- | --- | --- |')
    for (const s of result.steps)
      lines.push(`| ${s.key} | ${ICON[s.status]} | ${String(s.detail).replace(/\|/g, '\\|')} |`)
    if (result.skips.length) {
      lines.push('', '### Skipped on purpose')
      for (const s of result.skips) lines.push(`- **${s.step}** — ${s.reason}`)
    }
    if (result.failures.length) {
      lines.push('', '### Missing')
      for (const f of result.failures) lines.push(`- ${f}`)
    }
  }
  lines.push(
    '',
    'Re-runs on push, label changes and PR-body edits. After a review lands, re-run it with a body edit or a label change.',
  )
  return lines.join('\n') + '\n'
}

function main(argv) {
  const arg = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined)
  const input = arg('--input')
  if (!input) {
    console.error('usage: flow-gate.mjs --input <pr-data.json> [--summary <file>]')
    return 2
  }
  let pr, result
  try {
    pr = JSON.parse(readFileSync(input, 'utf8'))
    result = evaluate(pr)
  } catch (e) {
    console.log(`::error title=Flow Gate::could not evaluate — ${e.message}`)
    return 2
  }
  const text = render(result, pr)
  process.stdout.write(text)
  const summary = arg('--summary')
  if (summary) appendFileSync(summary, text)
  for (const f of result.failures) console.log(`::error title=Flow Gate::${f}`)
  for (const s of result.skips)
    console.log(`::notice title=Flow Gate skip::${s.step} — ${s.reason}`)
  return result.pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
