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
import { pathToFileURL } from 'node:url'

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
 * @param {number} [pr.changedFiles] the PR's own `changed_files` count (detects a truncated list)
 * @param {Array<{author:string,state:string,body:string,commit_id:string,submitted_at:string}>} pr.reviews
 * @param {string[]} pr.labels      current label names
 * @param {Array<{actor:string,created_at:string}>} pr.labelEvents  `labeled` events for MERGE_LABEL
 * @param {Array<{sha:string,author:string|null,committer:string|null}>} pr.commits  PR commits with
 *        their GitHub-attributed logins (null = the email is linked to no account)
 * @param {number} [pr.commitCount] the PR's own `commits` count (detects a truncated list)
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
  // The pull-request files API lists at most 3000 files. If the PR reports more changed files
  // than were listed, the unlisted ones were never looked at — so the PR is treated as touching
  // a critical path (fail-closed) instead of being judged on the part that was read.
  if (typeof pr.changedFiles === 'number' && pr.changedFiles > files.length) {
    critical.push({
      path: `(${pr.changedFiles - files.length} changed files not listed by the API)`,
      glob: 'unlisted',
    })
  }

  // The label check runs for EVERY PR, owner-authored included: `merge-approved` is the owner's
  // merge decision, and a collaborator applying it to an owner's PR is the same act as applying it
  // to his own.
  const labelProblems = checkMergeLabel({ labels, labelEvents, owner })

  // Owner-authored PRs do not need reviews here (they are reviewed in the Master pipeline), but
  // authorship alone is not enough: a write-role collaborator can push onto the owner's branch and
  // then merge by hand. So every commit must be attributed to the owner. See `checkCommitIdentity`
  // for why this is a best-effort signal and what the hard layer is.
  if (sameLogin(author, owner)) {
    const missing = [
      ...labelProblems,
      ...checkCommitIdentity({ commits: pr.commits, commitCount: pr.commitCount, owner }),
    ]
    return {
      pass: missing.length === 0,
      reason:
        missing.length === 0
          ? `author @${author} is the repository owner and every commit is attributed to the owner — owner PRs are reviewed in the Master pipeline`
          : 'owner-authored PR, but it carries a non-owner commit or label',
      missing,
      critical,
    }
  }

  const missing = []
  const ownerReviews = reviews
    .filter((r) => sameLogin(r.author, owner) && r.state !== 'PENDING')
    .map((r) => ({ ...r, verdict: parseVerdicts(r.body), at: ts(r.submitted_at) }))

  const ignoredSelf = reviews.filter(
    (r) =>
      !sameLogin(r.author, owner) && (parseVerdicts(r.body).code || parseVerdicts(r.body).security),
  )

  // One verdict kind: the latest counting APPROVE on the head sha, then no BLOCK after it.
  const judge = (kind, label) => {
    const approvals = ownerReviews.filter(
      (r) =>
        r.verdict[kind] === 'APPROVE' && APPROVE_STATES.has(r.state) && r.commit_id === headSha,
    )
    const latestApprove = approvals.reduce((a, r) => (a && a.at >= r.at ? a : r), null)
    const blocks = ownerReviews.filter((r) => r.verdict[kind] === 'BLOCK')
    if (!latestApprove) {
      const stale = ownerReviews.filter(
        (r) => r.verdict[kind] === 'APPROVE' && r.commit_id !== headSha,
      )
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
      (r) =>
        r.verdict.security === 'APPROVE' && APPROVE_STATES.has(r.state) && r.commit_id === headSha,
    )
    const lastBlock = secBlocks.reduce((a, r) => (a && a.at >= r.at ? a : r), null)
    if (lastBlock && !secApproves.some((r) => r.at > lastBlock.at)) {
      missing.push(
        `security review: @${owner} posted \`Security Review: BLOCK\` (${lastBlock.submitted_at}) and no later \`Security Review: APPROVE\` on head supersedes it`,
      )
    }
  }

  missing.push(...labelProblems)

  if (ignoredSelf.length && missing.length) {
    const who = [...new Set(ignoredSelf.map((r) => `@${r.author}`))].join(', ')
    missing.push(
      `note: verdict lines in reviews by ${who} do not count — only reviews by the owner account @${owner} do`,
    )
  }

  return {
    pass: missing.length === 0,
    reason:
      missing.length === 0
        ? `reviews by @${owner} cover head ${short(headSha)}`
        : 'required reviews are missing',
    missing,
    critical,
  }
}

/** `merge-approved`, if present, must have been applied last by the owner. */
export function checkMergeLabel({ labels, labelEvents, owner }) {
  if (!labels.includes(MERGE_LABEL)) return []
  const latest = labelEvents.reduce(
    (a, e) => (a && ts(a.created_at) >= ts(e.created_at) ? a : e),
    null,
  )
  if (!latest) {
    return [
      `label: \`${MERGE_LABEL}\` is present but no labeled event names who applied it — refusing to assume the owner did`,
    ]
  }
  if (!sameLogin(latest.actor, owner)) {
    return [
      `label: \`${MERGE_LABEL}\` was applied by @${latest.actor}, not by the repository owner @${owner} — only the owner may approve a merge`,
    ]
  }
  return []
}

// GitHub's own committer for commits made through the web UI / API (merges of main into the
// branch, suggestion commits). It never appears as an AUTHOR, so it is accepted as committer only.
export const WEB_FLOW = 'web-flow'

/**
 * Every commit on an owner-authored PR must have author login == owner and committer login ==
 * owner (or `web-flow`). A null login — the commit email is not linked to any GitHub account —
 * is UNKNOWN, and unknown is not the owner.
 *
 * Best-effort, by construction: GitHub derives these logins from the commit's email, and anyone
 * can write any email into a commit. A collaborator who sets the owner's linked email passes this
 * check. What this catches is the honest/accidental case (a collaborator's normal commits on an
 * owner branch). The hard layers are the label check (the label actor is the authenticated
 * account) and branch protection itself.
 */
export function checkCommitIdentity({ commits, commitCount, owner }) {
  const problems = []
  if (typeof commitCount === 'number' && commitCount > commits.length) {
    problems.push(
      `commits: the PR has ${commitCount} commits but only ${commits.length} were listed (the API caps the list) — the unlisted ones were never checked`,
    )
  }
  const bad = []
  for (const c of commits) {
    const authorOk = sameLogin(c.author, owner)
    const committerOk = sameLogin(c.committer, owner) || sameLogin(c.committer, WEB_FLOW)
    if (!authorOk || !committerOk) bad.push(c)
  }
  for (const c of bad.slice(0, 20)) {
    problems.push(
      `commit ${short(c.sha)}: author ${c.author ? '@' + c.author : '(email not linked to any account)'}, committer ${c.committer ? '@' + c.committer : '(email not linked to any account)'} — not attributed to the owner @${owner}`,
    )
  }
  if (bad.length > 20)
    problems.push(`… and ${bad.length - 20} more commits not attributed to the owner`)
  return problems
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
  for (const k of ['files', 'reviews', 'labels', 'labelEvents', 'commits']) {
    if (!Array.isArray(pr[k])) p.push(`${k} must be an array`)
  }
  if (Array.isArray(pr.commits) && pr.commits.length === 0)
    p.push('commits is empty — the commit fetch returned nothing (a PR always has a commit)')
  // A PR always changes at least one file. An empty list means the fetch did not happen, and an
  // instrument that did not look must not report "no critical paths".
  if (Array.isArray(pr.files) && pr.files.length === 0)
    p.push('files is empty — the changed-file fetch returned nothing')
  return p
}

// ---------------------------------------------------------------------------------------------
// CLI

function render(result, pr) {
  const lines = []
  lines.push(`## Review Gate: ${result.pass ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push(
    `- PR author: @${pr.author} · repository owner: @${pr.owner} · head: \`${short(pr.headSha)}\``,
  )
  lines.push(`- changed files: ${pr.files.length} · critical-path files: ${result.critical.length}`)
  lines.push(
    `- reviews read: ${pr.reviews.length} · \`${MERGE_LABEL}\` labeled events read: ${pr.labelEvents.length} · commits read: ${pr.commits.length}`,
  )
  lines.push(`- ${result.reason}`)
  if (result.missing.length) {
    lines.push('')
    lines.push('### Missing')
    for (const m of result.missing) lines.push(`- ${m}`)
  }
  if (result.critical.length) {
    lines.push('')
    lines.push('### Critical-path files (require `Security Review: APPROVE` from the owner)')
    for (const c of result.critical.slice(0, 50))
      lines.push(`- \`${c.path}\` (matched \`${c.glob}\`)`)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
