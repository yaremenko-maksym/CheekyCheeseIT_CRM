import { afterEach, describe, expect, it, vi } from 'vitest'

// Counts every URL parse the resolver asks for. The real implementation still runs.
const urlParses = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./ats-job-key', async (importActual) => {
  const actual = await importActual<typeof import('./ats-job-key')>()
  return {
    ...actual,
    atsJobKey: (raw: string | null | undefined) => {
      urlParses.calls += 1
      return actual.atsJobKey(raw)
    },
  }
})

import { canAttach, clusterRecords, type ResolverRecord } from './resolver'

function rec(i: number, over: Partial<ResolverRecord> = {}): ResolverRecord {
  return {
    id: `r${String(i).padStart(4, '0')}`,
    provider: 'REMOTEOK',
    namespace: 'remoteok.com',
    nativeId: `n${i}`,
    company: 'Acme',
    title: 'Senior Backend Engineer',
    location: 'Berlin',
    department: 'Platform',
    postingUrl: 'https://boards.greenhouse.io/acme/jobs/100',
    applicationUrl: 'https://boards.greenhouse.io/acme/jobs/100',
    applicationUrlVerified: true,
    ...over,
  }
}

/** Counts String#normalize calls (the first step of every string normalisation) during `run`. */
function countNormalizations(run: () => void): number {
  const original = String.prototype.normalize
  let calls = 0
  String.prototype.normalize = function (this: string, form?: string) {
    calls += 1
    return original.call(this, form)
  }
  try {
    run()
  } finally {
    String.prototype.normalize = original
  }
  return calls
}

afterEach(() => {
  urlParses.calls = 0
})

const identical = (n: number) => Array.from({ length: n }, (_, i) => rec(i))
const distinct = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    rec(i, {
      company: `Company ${i}`,
      title: `Title ${i}`,
      postingUrl: `https://boards.greenhouse.io/acme${i}/jobs/${i}`,
      applicationUrl: `https://boards.greenhouse.io/acme${i}/jobs/${i}`,
    }),
  )

describe('each record is parsed and normalised once, whatever the number of pairs', () => {
  it('URL parses: exactly two per record (posting + application) for 10, 40 and 120 records', () => {
    for (const make of [identical, distinct]) {
      for (const n of [10, 40, 120]) {
        urlParses.calls = 0
        const r = clusterRecords(make(n))
        expect(r.ok).toBe(true)
        expect(urlParses.calls, `${make.name} ${n}`).toBe(2 * n)
      }
    }
  })

  it('string normalisations per record are constant, not proportional to the pair count', () => {
    for (const make of [identical, distinct]) {
      const perRecord = [10, 40, 120].map(
        (n) => countNormalizations(() => void clusterRecords(make(n))) / n,
      )
      expect(perRecord[1], make.name).toBe(perRecord[0])
      expect(perRecord[2], make.name).toBe(perRecord[0])
      expect(perRecord[0], make.name).toBeGreaterThan(0)
    }
  })

  it('canAttach prepares the cluster and the candidate once each', () => {
    const cluster = identical(30)
    urlParses.calls = 0
    canAttach(cluster, rec(99))
    expect(urlParses.calls).toBe(2 * 31)
  })
})

describe('early exit', () => {
  /** A candidate whose nativeId is read once per pairwise assessment; `reads()` says how many. */
  function countedStranger() {
    let reads = 0
    const base = rec(99, { company: 'Globex', title: 'Data Analyst' })
    const stranger = Object.defineProperty({ ...base }, 'nativeId', {
      get: () => {
        reads += 1
        return 'zz'
      },
      enumerable: true,
    }) as ResolverRecord
    return { stranger, reads: () => reads }
  }
  const members = () => Array.from({ length: 50 }, (_, i) => rec(i))

  it('clusterRecords stops at the first non-associated member: one assessment, not 50', () => {
    const { stranger, reads } = countedStranger()
    const out = clusterRecords([...members(), stranger])
    expect(out.ok && out.clusters.map((c) => c.memberIds.length)).toEqual([50, 1])
    expect(reads()).toBe(1)
  })

  it('canAttach still assesses and lists every blocker', () => {
    const { stranger, reads } = countedStranger()
    const res = canAttach(members(), stranger)
    expect(res.attach ? [] : res.blockedBy).toHaveLength(50)
    expect(reads()).toBe(50)
  })
})
