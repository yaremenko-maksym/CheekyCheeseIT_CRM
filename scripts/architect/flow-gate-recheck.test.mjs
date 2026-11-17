// Unit tests for scripts/architect/flow-gate-recheck.mjs.
// Run: node --test 'scripts/architect/*.test.mjs'   (CI: .github/workflows/architect-scripts.yml)

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import {
  pickRun,
  rerunOutcome,
  recheck,
  attemptIsFresh,
  escapeCommand,
  errorLine,
  FALLBACK,
  WAIT_LIMIT_MS,
} from './flow-gate-recheck.mjs'

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
  assert.equal(rerunOutcome(409, 'The workflow run is already running'), 'already-running')
  assert.equal(rerunOutcome(409, 'Conflict'), 'error')
  assert.equal(rerunOutcome(200, 'already running'), 'rerun')
  assert.equal(rerunOutcome(500, 'already running'), 'error', 'status narrows before text')
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
    [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD, 'in_progress')] } },
    [`GET repos/${REPO}/actions/runs/4`]: { status: 200, body: run(4, HEAD, 'in_progress') },
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

test('attemptIsFresh: only a parsable attempt start later than the script start skips', () => {
  const at = Date.parse('2026-11-17T10:00:00Z')
  assert.equal(attemptIsFresh({ run_started_at: '2026-11-17T10:00:05Z' }, at), true)
  assert.equal(attemptIsFresh({ run_started_at: '2026-11-17T09:59:00Z' }, at), false)
  assert.equal(attemptIsFresh({ run_started_at: '2026-11-17T10:00:00Z' }, at), false)
  assert.equal(attemptIsFresh({ run_started_at: 'garbage' }, at), false)
  assert.equal(attemptIsFresh({}, at), false)
  assert.equal(attemptIsFresh({ run_started_at: '2026-11-17T10:00:05Z' }, NaN), false)
})

// A stateful fake gate run: a POST re-run restarts it (queued, new attempt start at 10:00:10);
// the next poll sees it completed. Each recheck below starts at a fixed fake `now`.
function sharedGate() {
  let gate = { ...run(4, HEAD), run_started_at: '2026-11-17T09:00:00Z' }
  const calls = []
  const api = async (method, path) => {
    calls.push(`${method} ${path}`)
    if (path === `repos/${REPO}/pulls/12`) return openPr
    if (path.startsWith(`repos/${REPO}/actions/workflows/`))
      return { status: 200, body: { workflow_runs: [gate] } }
    if (method === 'GET' && path === `repos/${REPO}/actions/runs/4`) {
      gate = { ...gate, status: 'completed' }
      return { status: 200, body: gate }
    }
    if (method === 'POST' && path === `repos/${REPO}/actions/runs/4/rerun`) {
      gate = { ...gate, status: 'queued', run_started_at: '2026-11-17T10:00:10Z' }
      return { status: 201, body: {} }
    }
    return { status: 404, body: { message: 'Not Found' } }
  }
  const at = (iso) => ({ api, repo: REPO, prNumber: 12, ...quiet, now: () => Date.parse(iso) })
  return { at, calls }
}
const posts = (calls) => calls.filter((c) => c.startsWith('POST')).length

test('an attempt started before the script started is re-run', async () => {
  const { at, calls } = sharedGate()
  const out = await recheck(at('2026-11-17T10:00:00Z'))
  assert.equal(out[0].outcome, 'rerun')
  assert.equal(posts(calls), 1)
})

test('burst: a second waiter started before the new attempt sees it fresh and does not re-run', async () => {
  const { at, calls } = sharedGate()
  const first = await recheck(at('2026-11-17T10:00:00Z'))
  const second = await recheck(at('2026-11-17T10:00:01Z'))
  assert.equal(first[0].outcome, 'rerun')
  assert.equal(second[0].outcome, 'fresh')
  assert.equal(posts(calls), 1)
})

test('burst: a recheck that started after the new attempt completed still re-runs', async () => {
  const { at, calls } = sharedGate()
  await recheck(at('2026-11-17T10:00:00Z'))
  await at('').api('GET', `repos/${REPO}/actions/runs/4`) // the new attempt completes
  const late = await recheck(at('2026-11-17T10:00:20Z'))
  assert.equal(late[0].outcome, 'rerun')
  assert.equal(posts(calls), 2)
})

test('escapeCommand: PR text cannot end a workflow command or inject one', () => {
  const evil = 'feat/x%y\r\n::error::pwned'
  assert.equal(escapeCommand(evil), 'feat/x%25y%0D%0A::error::pwned')
  assert.ok(!/[\r\n]/.test(escapeCommand(evil)))
  assert.equal(escapeCommand('a:b,c%', true), 'a%3Ab%2Cc%25')
  assert.equal(escapeCommand(undefined), '')
})

test('errorLine: one line, carries the cause and the manual fallback', () => {
  const line = errorLine('gate run 4 did not complete\n::warning::x')
  assert.ok(line.startsWith('::error title=Flow Gate recheck::gate run 4 did not complete%0A'))
  assert.ok(!line.includes('\n'))
  assert.ok(line.includes(FALLBACK))
  assert.match(FALLBACK, /edit the PR body or toggle a label/)
  assert.match(FALLBACK, /30 days/)
})

test('relay warning escapes the head branch', async () => {
  const logs = []
  const branch = 'x\n::error::y'
  const { api } = fakeApi({
    [`GET repos/${REPO}/pulls?state=open&base=main&head=${encodeURIComponent(`a:${branch}`)}&per_page=10`]:
      { status: 200, body: [] },
  })
  await recheck({
    api,
    repo: REPO,
    headOwner: 'a',
    headBranch: branch,
    ...quiet,
    log: (l) => logs.push(l),
  })
  assert.equal(logs.length, 1)
  assert.ok(!logs[0].includes('\n'))
  assert.ok(logs[0].includes('x%0A::error::y'))
})

// The wait must outlast a whole gate attempt, and the job must outlast the wait.
test('timing: gate timeout < WAIT_LIMIT_MS < recheck job timeout', () => {
  const minutes = (file) => {
    const m = readFileSync(
      new URL(`../../.github/workflows/${file}`, import.meta.url),
      'utf8',
    ).match(/timeout-minutes:\s*(\d+)/)
    assert.ok(m, `${file} declares timeout-minutes`)
    return Number(m[1]) * 60 * 1000
  }
  const gate = minutes('flow-gate.yml')
  const job = minutes('flow-gate-recheck.yml')
  assert.ok(
    WAIT_LIMIT_MS >= gate + 2 * 60 * 1000,
    'wait limit exceeds the gate timeout with margin',
  )
  assert.ok(job >= WAIT_LIMIT_MS + 2 * 60 * 1000, 'job timeout exceeds the wait limit plus setup')
})

// Freshness is decided BEFORE any wait: an attempt that has not started, or started after this
// script, reads (or read) the PR after our event.
for (const status of ['queued', 'waiting', 'pending', 'requested']) {
  test(`a ${status} gate run is fresh at once: no wait, no POST`, async () => {
    let slept = 0
    const { api, calls } = fakeApi({
      [`GET repos/${REPO}/pulls/12`]: openPr,
      [runsPath]: { status: 200, body: { workflow_runs: [run(4, HEAD, status)] } },
    })
    const out = await recheck({
      api,
      repo: REPO,
      prNumber: 12,
      log: () => {},
      sleep: async () => slept++,
    })
    assert.deepEqual(out, [{ pr: 12, run: 4, outcome: 'fresh' }])
    assert.equal(slept, 0)
    assert.ok(!calls.some((c) => c.startsWith('POST')))
  })
}

test('an in_progress attempt started after the script start is fresh: no wait, no POST', async () => {
  let slept = 0
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: {
      status: 200,
      body: {
        workflow_runs: [{ ...run(4, HEAD, 'in_progress'), run_started_at: '2026-11-17T10:00:05Z' }],
      },
    },
  })
  const out = await recheck({
    api,
    repo: REPO,
    prNumber: 12,
    log: () => {},
    now: () => Date.parse('2026-11-17T10:00:00Z'),
    sleep: async () => slept++,
  })
  assert.equal(out[0].outcome, 'fresh')
  assert.equal(slept, 0)
  assert.ok(!calls.some((c) => c.startsWith('POST')))
})

test('an old attempt that another recheck re-runs during our wait ends our wait as fresh', async () => {
  const { api, calls } = fakeApi({
    [`GET repos/${REPO}/pulls/12`]: openPr,
    [runsPath]: {
      status: 200,
      body: {
        workflow_runs: [{ ...run(4, HEAD, 'in_progress'), run_started_at: '2026-11-17T09:59:00Z' }],
      },
    },
    [`GET repos/${REPO}/actions/runs/4`]: {
      status: 200,
      body: { ...run(4, HEAD, 'queued'), run_started_at: '2026-11-17T10:00:30Z' },
    },
  })
  const out = await recheck({
    api,
    repo: REPO,
    prNumber: 12,
    ...quiet,
    now: () => Date.parse('2026-11-17T10:00:00Z'),
  })
  assert.equal(out[0].outcome, 'fresh')
  assert.ok(!calls.some((c) => c.startsWith('POST')))
})

test('FALLBACK names the 50-re-run cap', () => {
  assert.match(FALLBACK, /re-run 50 times/)
})

// SR-M-3: the concurrency group carries the job's trust condition, so an untrusted event never
// shares a group with a real recheck. The two copies of the condition must stay identical.
test('recheck workflow: concurrency group repeats the job if: condition exactly', () => {
  const wf = readFileSync(
    new URL('../../.github/workflows/flow-gate-recheck.yml', import.meta.url),
    'utf8',
  )
  const norm = (t) => t.replace(/\s+/g, ' ').trim()
  const cond = wf.match(/\n {4}if: >-\n([\s\S]*?)\n {4}concurrency:/)
  const group = wf.match(/\n {6}group: >-\n([\s\S]*?)\n {6}cancel-in-progress:/)
  assert.ok(cond && group, 'both blocks found')
  const g = norm(group[1])
  assert.ok(g.includes(`(${norm(cond[1])}) && 'trusted' || github.run_id }}`), g)
})
