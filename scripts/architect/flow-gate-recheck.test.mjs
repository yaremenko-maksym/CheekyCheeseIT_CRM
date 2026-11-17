// Unit tests for scripts/architect/flow-gate-recheck.mjs.
// Run: node --test 'scripts/architect/*.test.mjs'   (CI: .github/workflows/architect-scripts.yml)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickRun, rerunOutcome, recheck, WAIT_LIMIT_MS } from './flow-gate-recheck.mjs'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const REPO = 'o/r'

// A fake GitHub API: `routes` maps "METHOD path" to a response or a list of responses served in
// order (the last one repeats). Every call is recorded.
function fakeApi(routes) {
  const calls = []
  const api = async (method, path) => {
    const key = `${method} ${path}`
    calls.push(key)
    const r = routes[key]
    if (!r) return { status: 404, body: { message: 'Not Found' } }
    return Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r
  }
  return { api, calls }
}

const openPr = { status: 200, body: { state: 'open', base: { ref: 'main' }, head: { sha: HEAD } } }
const runsPath = `GET repos/${REPO}/actions/workflows/flow-gate.yml/runs?head_sha=${HEAD}&event=pull_request_target&per_page=30`
const run = (id, sha, status = 'completed', event = 'pull_request_target') => ({
  id,
  head_sha: sha,
  status,
  event,
})
const quiet = { log: () => {}, sleep: async () => {} }

test('pickRun: newest run of exactly the head, pull_request_target only', () => {
  const runs = [run(5, HEAD), run(9, OLD), run(7, HEAD), run(8, HEAD, 'completed', 'push')]
  assert.equal(pickRun(runs, HEAD).id, 7)
  assert.equal(pickRun(runs, 'c'.repeat(40)), null)
  assert.equal(pickRun(undefined, HEAD), null)
})

test('rerunOutcome: 201 re-runs, "already running" is not an error, anything else is', () => {
  assert.equal(rerunOutcome(201, ''), 'rerun')
  assert.equal(rerunOutcome(403, 'This workflow is already running'), 'already-running')
  assert.equal(rerunOutcome(403, 'Resource not accessible by integration'), 'error')
  assert.equal(rerunOutcome(500, 'boom'), 'error')
})

test('PR comment: re-runs the newest completed gate run of the head', async () => {
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(3, HEAD), run(4, HEAD), run(6, OLD)] } },
    [`POST repos/${REPO}/actions/runs/4/rerun`]: { status: 201, body: {} },
  })
  const out = await recheck({ api, repo: REPO, prNumber: '12', ...quiet })
  assert.deepEqual(out, [{ pr: 12, run: 4, outcome: 'rerun' }])
  assert.ok(!calls.some((c) => c.includes('runs/6/rerun')), 'an older head is never re-run')
})

test('relay: resolves the PR from head owner:branch (URL-encoded), never from run output', async () => {
  const q = encodeURIComponent('alice:feat/x y')
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls?state=open&base=main&head=${q}&per_page=10`]: {
      status: 200,
      body: [{ number: 12 }],
    },
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD)] } },
    [`POST repos/${REPO}/actions/runs/4/rerun`]: { status: 201, body: {} },
  })
  const out = await recheck({
    api,
    repo: REPO,
    headOwner: 'alice',
    headBranch: 'feat/x y',
    ...quiet,
  })
  assert.equal(out[0].outcome, 'rerun')
  assert.ok(calls[0].includes(q))
})

test('relay with no open PR for the head: warns, re-runs nothing', async () => {
  const logs = []
  const { api } = fakeApi({
    [`GET repos/${REPO}/pulls?state=open&base=main&head=${encodeURIComponent('a:b')}&per_page=10`]:
      {
        status: 200,
        body: [],
      },
  })
  assert.deepEqual(
    await recheck({
      api,
      repo: REPO,
      headOwner: 'a',
      headBranch: 'b',
      log: (l) => logs.push(l),
      sleep: async () => {},
    }),
    [],
  )
  assert.ok(logs.some((l) => l.startsWith('::warning')))
})

test('closed PR or a PR into another base is not re-checked', async () => {
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: {
      status: 200,
      body: { state: 'closed', base: { ref: 'main' }, head: { sha: HEAD } },
    },
  })
  const out = await recheck({ api, repo: REPO, prNumber: 12, ...quiet })
  assert.equal(out[0].outcome, 'not-gated')
  assert.equal(calls.length, 1)
})

test('no gate run for the head: warns, does not fail, re-runs nothing', async () => {
  const logs = []
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [] } },
  })
  const out = await recheck({
    api,
    repo: REPO,
    prNumber: 12,
    log: (l) => logs.push(l),
    sleep: async () => {},
  })
  assert.equal(out[0].outcome, 'no-run')
  assert.ok(logs.some((l) => l.startsWith('::warning')))
  assert.ok(!calls.some((c) => c.startsWith('POST')))
})

test('in-flight gate run: waits for it to complete, then re-runs it', async () => {
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD, 'in_progress')] } },
    [`GET repos/${REPO}/actions/runs/4`]: [
      { status: 200, body: run(4, HEAD, 'in_progress') },
      { status: 200, body: run(4, HEAD, 'completed') },
    ],
    [`POST repos/${REPO}/actions/runs/4/rerun`]: { status: 201, body: {} },
  })
  const out = await recheck({ api, repo: REPO, prNumber: 12, ...quiet })
  assert.equal(out[0].outcome, 'rerun')
  assert.equal(calls.filter((c) => c === `GET repos/${REPO}/actions/runs/4`).length, 2)
  assert.equal(calls.at(-1), `POST repos/${REPO}/actions/runs/4/rerun`)
})

test('in-flight run that never completes: fails loudly after the wait limit', async () => {
  let t = 0
  const { api } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD, 'queued')] } },
    [`GET repos/${REPO}/actions/runs/4`]: { status: 200, body: run(4, HEAD, 'queued') },
  })
  await assert.rejects(
    recheck({
      api,
      repo: REPO,
      prNumber: 12,
      log: () => {},
      now: () => t,
      sleep: async (ms) => (t += ms),
    }),
    /did not complete within/,
  )
  assert.ok(t >= WAIT_LIMIT_MS)
})

test('burst: a re-run refused as already running counts as done', async () => {
  const { api } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD)] } },
    [`POST repos/${REPO}/actions/runs/4/rerun`]: {
      status: 403,
      body: { message: 'This workflow is already running' },
    },
  })
  const out = await recheck({ api, repo: REPO, prNumber: 12, ...quiet })
  assert.equal(out[0].outcome, 'already-running')
})

test('a re-run refused for any other reason fails the job', async () => {
  const { api } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD)] } },
    [`POST repos/${REPO}/actions/runs/4/rerun`]: {
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    },
  })
  await assert.rejects(recheck({ api, repo: REPO, prNumber: 12, ...quiet }), /refused \(HTTP 403/)
})

test('missing inputs and unreadable API responses fail, never pass silently', async () => {
  const { api } = fakeApi({})
  await assert.rejects(recheck({ api, repo: REPO, ...quiet }), /neither a PR number/)
  await assert.rejects(recheck({ api, repo: REPO, prNumber: 'abc', ...quiet }), /not a PR number/)
  await assert.rejects(
    recheck({ api, repo: REPO, prNumber: 12, ...quiet }),
    /could not read PR #12 \(HTTP 404\)/,
  )
})
