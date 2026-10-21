#!/usr/bin/env node
// Review Gate — decides whether a pull request carries the reviews the merge path requires.
//
// Why. On 2026-10-21 an audit found that every PR merged by a second (write-role) collaborator
// reached `main` with zero reviews, although each one touched a critical-path zone. Branch
// protection had no review requirement, and the review step existed only as procedure inside the
// owner's own orchestration pipeline, which a collaborator using another harness never runs.
// Native "required reviews" do not fit: the owner authors most PRs and GitHub forbids approving
// your own. This gate makes the review step a required status check instead.
//
// The decision is a pure function (`evaluate`) over data the workflow fetches; the CLI below only
// reads that data from a JSON file and prints the verdict. Nothing here talks to the network.
// Tests: scripts/architect/review-gate.test.mjs (node:test).
//
// Wiring: .github/workflows/review-gate.yml (check name `Review Gate`). Contract documentation:
// .claude/agents/contracts.md §4.1.
//
// Usage:
//   node scripts/architect/review-gate.mjs --input <pr-data.json> [--summary <file>]
// Exit codes: 0 PASS, 1 FAIL (missing items printed as ::error:: lines), 2 malformed input.

import { readFileSync, appendFileSync } from 'node:fs'

// Critical-path zones. Derived from `.claude/agents/contracts.md` §2.1 ("Critical-path trigger
// zones") — that table is the canonical source; when it changes, change this list.
//
// Every glob below was checked against the tree on 2026-10-21 rather than guessed. What the
// measurement changed relative to the first draft of the list:
//   - there is no `transactions/`, `wallet*/`, `company-account/` or `rbac/` DIRECTORY in the API:
//     transactions and the company account live inside `finance/` as files named
//     `transaction*` / `company-account*`, and RBAC lives in `common/guards/roles.guard.ts`,
//     `common/decorators/roles.decorator.ts`, `*-visibility.util.ts`, `*rbac*.util.ts` and
//     `users/role-guards.util.ts`. So those zones are matched by FILE-name globs, which also keep
//     matching if a directory of that name is ever created;
//   - migrations are `apps/api/drizzle/**` (hand-written SQL in `drizzle/manual*`); there is no
//     `migrations/` directory anywhere in the product, so `**/migrations/**` was dropped — the only
//     match was a vendored skill document;
//   - the Drizzle schema is `apps/api/src/database/schema.ts` plus the `schema/` directory beside it;
//   - DB roles and privileges (`database/privileges/**`) are RBAC at the database layer;
//   - shared finance schemas and role/permission types in `packages/shared` are part of the same
//     contract the API enforces;
//   - webhooks are files named `*webhook*` (meeting-recorder integration);
//   - the gate's own logic is included: a change to what the gate accepts is a security change.
//
// Glob semantics (see `globToRegExp`): `*` matches within one path segment, `**/` matches zero or
// more whole segments, a trailing `/**` matches everything below.
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
  'apps/api/src/**/*wallet*/**',
  'apps/api/src/**/*company-account*',
  'apps/api/src/**/*company-account*/**',
  // RBAC / role visibility / data masking
  'apps/api/src/**/*rbac*',
  'apps/api/src/**/*rbac*/**',
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
  // CI/CD pipeline and this gate itself
  '.github/workflows/**',
  'scripts/architect/review-gate*',
])

export const MERGE_LABEL = 'merge-approved'

/** Translate one glob into an anchored RegExp (no dependency on minimatch). */
export function globToRegExp(glob) {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?' // `**/` — zero or more whole segments
        i += 3
      } else {
        re += '.*' // `**` (trailing, after a `/`) — everything below
        i += 2
      }
    } else if (c === '*') {
      re += '[^/]*'
      i += 1
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

const CRITICAL_RES = CRITICAL_PATH_GLOBS.map((g) => [g, globToRegExp(g)])

/** The changed paths that fall in a critical-path zone, each with the first glob that matched. */
export function criticalPaths(files, entries = CRITICAL_RES) {
  const hits = []
  for (const f of files) {
    const hit = entries.find(([, re]) => re.test(f))
    if (hit) hits.push({ path: f, glob: hit[0] })
  }
  return hits
}

// A review states its verdict on its own line — by contract on the first line
// (`code-review-discipline` §1, `contracts.md` §4). Markdown decoration around the marker
// (`**Verdict: APPROVE**`, `## Verdict: APPROVE`, `> ...`) is tolerated. The FIRST marker line of
// each kind is the verdict: a body that later quotes an earlier verdict ("the previous
// Verdict: APPROVE was ...") cannot flip it, and a phrase in the middle of a sentence is not a
// marker at all.
const MARKERS = {
  code: /^Verdict:\s*(APPROVE|BLOCK)\b/,
  security: /^Security Review:\s*(APPROVE|BLOCK)\b/,
}

export function parseVerdicts(body) {
  const out = { code: null, security: null }
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*_`-]+/, '').replace(/[*_`]+/g, '')
    for (const kind of Object.keys(MARKERS)) {
      if (out[kind]) continue
      const m = MARKERS[kind].exec(line)
      if (m) out[kind] = m[1]
    }
  }
  return out
}

const sameLogin = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
const ts = (s) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

// Review states whose APPROVE may count. A DISMISSED approval no longer counts; a PENDING review
// was never submitted. BLOCK verdicts are counted in ANY state — fail-closed: a write-role
// collaborator can dismiss an approval/changes-requested review, and dismissing must never be a
// way to make an owner's BLOCK disappear.
const APPROVE_STATES = new Set(['COMMENTED', 'APPROVED'])

/**
 * Evaluate the gate. Pure.
 *
 * @param {object} pr
 * @param {string} pr.author        PR author login
 * @param {string} pr.owner         repository owner login (from `github.repository_owner`)
 * @param {string} pr.headSha       PR head commit sha
 * @param {string[]} pr.files       changed file paths
 * @param {Array<{author:string,state:string,body:string,commit_id:string,submitted_at:string}>} pr.reviews
 * @param {string[]} pr.labels      current label names
 * @param {Array<{actor:string,created_at:string}>} pr.labelEvents  `labeled` events for MERGE_LABEL
 * @returns {{pass:boolean, reason:string, missing:string[], critical:Array<{path:string,glob:string}>}}
 */
export function evaluate(pr) {
  const problems = validate(pr)
  if (problems.length) {
    const err = new Error(`malformed input: ${problems.join('; ')}`)
    err.code = 'MALFORMED'
    throw err
  }

  const { author, owner, headSha, files, reviews, labels, labelEvents } = pr
  const critical = criticalPaths(files)

  if (sameLogin(author, owner)) {
    return {
      pass: true,
      reason: `author @${author} is the repository owner — owner PRs are reviewed in the Master pipeline`,
      missing: [],
      critical,
    }
  }

  const missing = []
  const ownerReviews = reviews
    .filter((r) => sameLogin(r.author, owner) && r.state !== 'PENDING')
    .map((r) => ({ ...r, verdict: parseVerdicts(r.body), at: ts(r.submitted_at) }))

  const ignoredSelf = reviews.filter(
    (r) => !sameLogin(r.author, owner) && (parseVerdicts(r.body).code || parseVerdicts(r.body).security),
  )

  // One verdict kind: the latest counting APPROVE on the head sha, then no BLOCK after it.
  const judge = (kind, label) => {
    const approvals = ownerReviews.filter(
      (r) => r.verdict[kind] === 'APPROVE' && APPROVE_STATES.has(r.state) && r.commit_id === headSha,
    )
    const latestApprove = approvals.reduce((a, r) => (a && a.at >= r.at ? a : r), null)
    const blocks = ownerReviews.filter((r) => r.verdict[kind] === 'BLOCK')
    if (!latestApprove) {
      const stale = ownerReviews.filter((r) => r.verdict[kind] === 'APPROVE' && r.commit_id !== headSha)
      missing.push(
        stale.length
          ? `${label}: the owner's \`${kind === 'code' ? 'Verdict' : 'Security Review'}: APPROVE\` is on an older commit (${short(stale[stale.length - 1].commit_id)}), not on head ${short(headSha)} — re-review the head commit`
          : `${label}: no review by @${owner} with \`${kind === 'code' ? 'Verdict' : 'Security Review'}: APPROVE\` on head ${short(headSha)}`,
      )
      return
    }
    const laterBlock = blocks.find((b) => b.at > latestApprove.at)
    if (laterBlock) {
      missing.push(
        `${label}: @${owner} posted \`${kind === 'code' ? 'Verdict' : 'Security Review'}: BLOCK\` (${laterBlock.submitted_at}) after the latest APPROVE — a newer APPROVE on head is required`,
      )
    }
  }

  judge('code', 'code review')

  if (critical.length) {
    judge('security', 'security review (critical-path files changed)')
  } else {
    // Not required here — but a security BLOCK that was never superseded still blocks.
    const secBlocks = ownerReviews.filter((r) => r.verdict.security === 'BLOCK')
    const secApproves = ownerReviews.filter(
      (r) => r.verdict.security === 'APPROVE' && APPROVE_STATES.has(r.state) && r.commit_id === headSha,
    )
    const lastBlock = secBlocks.reduce((a, r) => (a && a.at >= r.at ? a : r), null)
    if (lastBlock && !secApproves.some((r) => r.at > lastBlock.at)) {
      missing.push(
        `security review: @${owner} posted \`Security Review: BLOCK\` (${lastBlock.submitted_at}) and no later \`Security Review: APPROVE\` on head supersedes it`,
      )
    }
  }

  if (labels.includes(MERGE_LABEL)) {
    const latest = labelEvents.reduce((a, e) => (a && ts(a.created_at) >= ts(e.created_at) ? a : e), null)
    if (!latest) {
      missing.push(`label: \`${MERGE_LABEL}\` is present but no labeled event names who applied it — refusing to assume the owner did`)
    } else if (!sameLogin(latest.actor, owner)) {
      missing.push(
        `label: \`${MERGE_LABEL}\` was applied by @${latest.actor}, not by the repository owner @${owner} — only the owner may approve a merge`,
      )
    }
  }

  if (ignoredSelf.length && missing.length) {
    const who = [...new Set(ignoredSelf.map((r) => `@${r.author}`))].join(', ')
    missing.push(`note: verdict lines in reviews by ${who} do not count — only reviews by the owner account @${owner} do`)
  }

  return {
    pass: missing.length === 0,
    reason: missing.length === 0 ? `reviews by @${owner} cover head ${short(headSha)}` : 'required reviews are missing',
    missing,
    critical,
  }
}

function short(sha) {
  return String(sha ?? '').slice(0, 7)
}

function validate(pr) {
  const p = []
  if (!pr || typeof pr !== 'object') return ['input is not an object']
  for (const k of ['author', 'owner', 'headSha']) {
    if (typeof pr[k] !== 'string' || pr[k].trim() === '') p.push(`${k} must be a non-empty string`)
  }
  for (const k of ['files', 'reviews', 'labels', 'labelEvents']) {
    if (!Array.isArray(pr[k])) p.push(`${k} must be an array`)
  }
  // A PR always changes at least one file. An empty list means the fetch did not happen, and an
  // instrument that did not look must not report "no critical paths".
  if (Array.isArray(pr.files) && pr.files.length === 0) p.push('files is empty — the changed-file fetch returned nothing')
  return p
}

// ---------------------------------------------------------------------------------------------
// CLI

function render(result, pr) {
  const lines = []
  lines.push(`## Review Gate: ${result.pass ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push(`- PR author: @${pr.author} · repository owner: @${pr.owner} · head: \`${short(pr.headSha)}\``)
  lines.push(`- changed files: ${pr.files.length} · critical-path files: ${result.critical.length}`)
  lines.push(`- reviews read: ${pr.reviews.length} · \`${MERGE_LABEL}\` labeled events read: ${pr.labelEvents.length}`)
  lines.push(`- ${result.reason}`)
  if (result.missing.length) {
    lines.push('')
    lines.push('### Missing')
    for (const m of result.missing) lines.push(`- ${m}`)
  }
  if (result.critical.length) {
    lines.push('')
    lines.push('### Critical-path files (require `Security Review: APPROVE` from the owner)')
    for (const c of result.critical.slice(0, 50)) lines.push(`- \`${c.path}\` (matched \`${c.glob}\`)`)
    if (result.critical.length > 50) lines.push(`- … and ${result.critical.length - 50} more`)
  }
  lines.push('')
  lines.push(
    'Re-evaluation: this check re-runs on push and on every label change. After posting a review, the owner applies `merge-approved` (or re-applies it) to re-run it.',
  )
  return lines.join('\n') + '\n'
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const input = arg('--input')
  const summary = arg('--summary')
  if (!input) {
    console.error('usage: review-gate.mjs --input <pr-data.json> [--summary <file>]')
    return 2
  }
  let pr
  let result
  try {
    pr = JSON.parse(readFileSync(input, 'utf8'))
    result = evaluate(pr)
  } catch (e) {
    console.log(`::error title=Review Gate::could not evaluate — ${e.message}`)
    return 2
  }
  const text = render(result, pr)
  process.stdout.write(text)
  if (summary) appendFileSync(summary, text)
  for (const m of result.missing) console.log(`::error title=Review Gate::${m}`)
  return result.pass ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2))
}
