#!/usr/bin/env node
// Review Gate (lite) — a PR may merge only after an intentional, recorded review decision.
//
// Why. On 2026-10-21 an audit found that every PR merged by a second, write-role collaborator
// reached `main` with zero reviews, although each touched a critical-path zone. Branch protection
// had no review requirement; the review step existed only as procedure inside the owner's own
// orchestration pipeline, which a collaborator using another harness never runs. Native GitHub
// "required reviews" do not fit (the owner authors most PRs and cannot approve his own).
//
// What this gate is: a required check that turns "nobody reviewed it" from a silent default into
// an explicit choice somebody has to write down. It applies to EVERY author, the owner included.
// What it is NOT: a defence against a malicious write-role user — any account can post a review
// whose body says `Verdict: APPROVE`, and set a label. The point is that skipping review now
// leaves a visible, attributable record instead of nothing.
//
// Decision (pure function `evaluate`; the CLI only reads a JSON file and prints the verdict):
//   PASS  docs-only diff — every changed path is `*.md` or under `.claude/` (light-track exemption);
//   PASS  a review whose verdict line is `Verdict: APPROVE`, with no `Verdict: BLOCK` review
//         submitted after it;
//   PASS  label `skip-review` AND a PR-body line `Skip-Review-Reason: <text>` (key
//         case-insensitive, reason at least 10 characters) — the reason is echoed in the summary;
//   FAIL  otherwise.
//
// Tests: scripts/architect/review-gate.test.mjs (node:test). Wiring: .github/workflows/review-gate.yml
// (check name `Review Gate`). Contract: .claude/agents/contracts.md §4.1.
//
// Usage:
//   node scripts/architect/review-gate.mjs --input <pr-data.json> [--summary <file>]
// Exit codes: 0 PASS, 1 FAIL, 2 malformed input (never 0 on input it could not read).

import { readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SKIP_LABEL = 'skip-review'
export const MIN_REASON_LENGTH = 10
export const FAIL_MESSAGE =
  'No reviewer verdict. Run code-reviewer (and security-reviewer on critical paths), or set label `skip-review` and add `Skip-Review-Reason: <why>` to the PR body.'

/** Light-track exemption: every changed path is markdown or agent meta under `.claude/`. */
export function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => f.endsWith('.md') || f.startsWith('.claude/'))
}

// A verdict is stated on its own line — by contract on the first line (`code-review-discipline`
// §1, `contracts.md` §4). Markdown decoration around the marker (`**Verdict: APPROVE**`,
// `## Verdict: APPROVE`, `> ...`) is tolerated; the FIRST marker line is the review's verdict, so a
// body that later quotes an earlier verdict cannot flip it, and a phrase in the middle of a
// sentence ("I would give Verdict: APPROVE once …") is not a marker.
const VERDICT = /^Verdict:\s*(APPROVE|BLOCK)\b/

export function parseVerdict(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#*_`-]+/, '').replace(/[*_`]+/g, '')
    const m = VERDICT.exec(line)
    if (m) return m[1]
  }
  return null
}

/** The `Skip-Review-Reason:` line of the PR body, trimmed, or null. Key is case-insensitive. */
export function parseSkipReason(prBody) {
  const m = /^[ \t]*skip-review-reason:[ \t]*(.*)$/im.exec(String(prBody ?? ''))
  return m ? m[1].trim() : null
}

const ts = (s) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/**
 * @param {object} pr
 * @param {string[]} pr.files    changed file paths (pulls/files API)
 * @param {Array<{author:string,state:string,body:string,submitted_at:string}>} pr.reviews
 * @param {string[]} pr.labels   current label names
 * @param {string} pr.body       PR description (may be empty)
 * @returns {{pass:boolean, via:'docs-only'|'verdict'|'skip-review'|null, reason:string, missing:string[]}}
 */
export function evaluate(pr) {
  const problems = validate(pr)
  if (problems.length) {
    const err = new Error(`malformed input: ${problems.join('; ')}`)
    err.code = 'MALFORMED'
    throw err
  }

  if (isDocsOnly(pr.files)) {
    return { pass: true, via: 'docs-only', reason: 'docs-only diff (light-track)', missing: [] }
  }

  // A PENDING review was never submitted. A DISMISSED approval no longer stands. A BLOCK counts in
  // any submitted state — dismissing a review must not be a way to make a block disappear.
  const submitted = pr.reviews
    .filter((r) => r.state !== 'PENDING')
    .map((r) => ({ ...r, verdict: parseVerdict(r.body), at: ts(r.submitted_at) }))
  const approves = submitted.filter((r) => r.verdict === 'APPROVE' && r.state !== 'DISMISSED')
  const latestApprove = approves.reduce((a, r) => (a && a.at >= r.at ? a : r), null)
  const notes = []
  if (latestApprove) {
    const laterBlock = submitted.find((r) => r.verdict === 'BLOCK' && r.at > latestApprove.at)
    if (!laterBlock) {
      return {
        pass: true,
        via: 'verdict',
        reason: `\`Verdict: APPROVE\` by @${latestApprove.author} (${latestApprove.submitted_at})`,
        missing: [],
      }
    }
    notes.push(
      `\`Verdict: BLOCK\` by @${laterBlock.author} (${laterBlock.submitted_at}) came after the latest \`Verdict: APPROVE\` — a newer APPROVE is needed`,
    )
  }

  const hasLabel = pr.labels.includes(SKIP_LABEL)
  const reason = parseSkipReason(pr.body)
  const reasonOk = reason !== null && reason.length >= MIN_REASON_LENGTH
  if (hasLabel && reasonOk) {
    return {
      pass: true,
      via: 'skip-review',
      reason: `review skipped on purpose: ${reason}`,
      missing: [],
    }
  }
  if (hasLabel && !reasonOk) {
    notes.push(
      reason === null
        ? 'label `skip-review` is set, but the PR body has no `Skip-Review-Reason: <why>` line'
        : `label \`skip-review\` is set, but the \`Skip-Review-Reason:\` is shorter than ${MIN_REASON_LENGTH} characters`,
    )
  }
  if (!hasLabel && reason !== null) {
    notes.push(
      'the PR body has a `Skip-Review-Reason:` line, but the label `skip-review` is not set',
    )
  }

  return { pass: false, via: null, reason: FAIL_MESSAGE, missing: [FAIL_MESSAGE, ...notes] }
}

function validate(pr) {
  if (!pr || typeof pr !== 'object') return ['input is not an object']
  const p = []
  for (const k of ['files', 'reviews', 'labels']) {
    if (!Array.isArray(pr[k])) p.push(`${k} must be an array`)
  }
  if (typeof pr.body !== 'string') p.push('body must be a string (empty when the PR has none)')
  // A PR always changes at least one file. An empty list means the fetch did not happen — and an
  // instrument that did not look must not report "docs-only".
  if (Array.isArray(pr.files) && pr.files.length === 0)
    p.push('files is empty — the changed-file fetch returned nothing')
  return p
}

// ---------------------------------------------------------------------------------------------
// CLI

function render(result, pr) {
  const lines = [`## Review Gate: ${result.pass ? 'PASS' : 'FAIL'}`, '']
  lines.push(`- changed files: ${pr.files.length} · reviews read: ${pr.reviews.length}`)
  lines.push(`- ${result.pass ? `passed via **${result.via}** — ` : ''}${result.reason}`)
  if (result.missing.length > 1) {
    lines.push('', '### Details')
    for (const m of result.missing.slice(1)) lines.push(`- ${m}`)
  }
  lines.push(
    '',
    'This check re-runs on push, label changes, PR-body edits and submitted/dismissed reviews.',
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
