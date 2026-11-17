#!/usr/bin/env node
// Re-runs the latest `Flow Gate` run of an open PR's head commit, so the required check
// re-evaluates after PR activity that cannot start it directly (a review, a review comment, a PR
// comment). Called by .github/workflows/flow-gate-recheck.yml; unit tests in
// flow-gate-recheck.test.mjs.
//
// WHY A RE-RUN and not a fresh evaluation: a job started by `issue_comment` or `workflow_run`
// attaches its check run to the default branch's commit, never to the PR head, so it can never be
// the `Flow Gate` context branch protection reads. A re-run of the `pull_request_target` run adds
// a new attempt to the SAME check suite on the PR head, and the gate fetches the PR's reviews,
// comments, labels and body live from the API, so the new attempt judges the current state.
//
// Every input that reaches an API path is either a number from the event payload or a
// URL-encoded query value. Nothing from the PR is executed.

import { pathToFileURL } from 'node:url'

export const GATE_WORKFLOW = 'flow-gate.yml'
export const WAIT_LIMIT_MS = 4 * 60 * 1000
export const POLL_MS = 10 * 1000

// The newest gate run for exactly this head. A re-run of an older head's run would put a fresh
// conclusion on a commit that is no longer the head and leave the head's own check untouched.
export function pickRun(runs, headSha) {
  const own = (runs || []).filter(
    (r) => r && r.head_sha === headSha && r.event === 'pull_request_target',
  )
  own.sort((a, b) => b.id - a.id)
  return own[0] || null
}

// A rejected re-run means the run is running again; anyone who restarted it did so after our
// event, and the gate reads PR state when it starts, so that attempt already sees our event.
export function rerunOutcome(status, message) {
  if (status >= 200 && status < 300) return 'rerun'
  if (
    (status === 403 || status === 409) &&
    /already running|in progress|not completed/i.test(message || '')
  )
    return 'already-running'
  return 'error'
}

export async function recheck({ api, repo, prNumber, headOwner, headBranch, sleep, log, now }) {
  sleep ||= (ms) => new Promise((r) => setTimeout(r, ms))
  log ||= console.log
  now ||= Date.now
  let numbers = []
  if (prNumber) numbers = [Number(prNumber)]
  else if (headOwner && headBranch) {
    const q = encodeURIComponent(`${headOwner}:${headBranch}`)
    const res = await api('GET', `repos/${repo}/pulls?state=open&base=main&head=${q}&per_page=10`)
    if (res.status !== 200) throw new Error(`could not list PRs for the head (HTTP ${res.status})`)
    numbers = res.body.map((p) => p.number)
  } else throw new Error('neither a PR number nor a head owner/branch was given')
  if (!numbers.length) {
    log('no open PR into main for this head — nothing to re-check')
    return []
  }
  const results = []
  for (const n of numbers) results.push(await recheckOne({ api, repo, n, sleep, log, now }))
  return results
}

async function recheckOne({ api, repo, n, sleep, log, now }) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`not a PR number: ${n}`)
  const pr = await api('GET', `repos/${repo}/pulls/${n}`)
  if (pr.status !== 200) throw new Error(`could not read PR #${n} (HTTP ${pr.status})`)
  if (pr.body.state !== 'open' || pr.body.base?.ref !== 'main') {
    log(`PR #${n} is ${pr.body.state} into ${pr.body.base?.ref} — the gate does not judge it`)
    return { pr: n, outcome: 'not-gated' }
  }
  const head = pr.body.head.sha
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`PR #${n} head is not a sha`)
  const list = await api(
    'GET',
    `repos/${repo}/actions/workflows/${GATE_WORKFLOW}/runs?head_sha=${head}&event=pull_request_target&per_page=30`,
  )
  if (list.status !== 200) throw new Error(`could not list gate runs (HTTP ${list.status})`)
  let run = pickRun(list.body.workflow_runs, head)
  if (!run) {
    // A head pushed by GITHUB_TOKEN starts no run; the required check is then missing, which
    // blocks the merge on its own. Loud, but not a failure of this job.
    log(
      `::warning title=Flow Gate recheck::PR #${n} head ${head} has no Flow Gate run to re-run — push a commit as a person, or close and reopen the PR`,
    )
    return { pr: n, outcome: 'no-run' }
  }
  const deadline = now() + WAIT_LIMIT_MS
  while (run.status !== 'completed') {
    // A run already in flight may have read the PR before our event; re-run it once it ends.
    if (now() >= deadline)
      throw new Error(`gate run ${run.id} did not complete within ${WAIT_LIMIT_MS / 1000}s`)
    log(`gate run ${run.id} is ${run.status}; waiting`)
    await sleep(POLL_MS)
    const r = await api('GET', `repos/${repo}/actions/runs/${run.id}`)
    if (r.status !== 200) throw new Error(`could not read gate run ${run.id} (HTTP ${r.status})`)
    run = r.body
  }
  const res = await api('POST', `repos/${repo}/actions/runs/${run.id}/rerun`)
  const outcome = rerunOutcome(res.status, res.body?.message)
  if (outcome === 'error')
    throw new Error(
      `re-run of gate run ${run.id} refused (HTTP ${res.status}: ${res.body?.message})`,
    )
  log(`PR #${n} head ${head}: gate run ${run.id} — ${outcome}`)
  return { pr: n, run: run.id, outcome }
}

function ghApi(token) {
  return async (method, path) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { message: text }
    }
    return { status: res.status, body }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env
  recheck({
    api: ghApi(e.GH_TOKEN),
    repo: e.REPO,
    prNumber: e.PR_NUMBER,
    headOwner: e.HEAD_OWNER,
    headBranch: e.HEAD_BRANCH,
  }).then(
    () => {},
    (err) => {
      console.log(`::error title=Flow Gate recheck::${err.message}`)
      process.exitCode = 1
    },
  )
}
