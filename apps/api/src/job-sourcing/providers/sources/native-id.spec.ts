import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { sourceFixture } from '../../../test/source-fixtures'
import { arbeitnowProvider, arbeitnowSpec } from './arbeitnow.provider'
import { himalayasBrowseSpec, himalayasProvider, himalayasSearchSpec } from './himalayas.provider'
import { hnHiringProvider, hnSpec } from './hn-hiring.provider'
import { jobgetherProvider, jobgetherSpec } from './jobgether.provider'
import { jobicyProvider, jobicySpec } from './jobicy.provider'
import { remoteokProvider, remoteokSpec } from './remoteok.provider'
import { remotiveProvider, remotiveSpec } from './remotive.provider'

/**
 * `nativeIdOf` is the provider's own id for an item, and the loop's AC5 collision check compares
 * it across items that landed on one identity key. The base documents that `mapItem`'s native id
 * and `nativeIdOf` must be the SAME field; only a check at the spec object can see that, because
 * the collision check is reachable only for URL-keyed identity. One table, so tasks 3.2-3.4 repeat
 * the row, not the reasoning.
 *
 * Expected ids are literals read from the captures.
 */

interface Row {
  name: string
  spec: {
    itemSchema: ZodType<unknown>
    nativeIdOf: (item: never, config: never) => string | null
    mapItem: (item: never, config: never) => { nativeId?: string | null }
  }
  config: unknown
  rawItem: unknown
  expected: string
}

const first = (provider: string, name: string, key: string): unknown => {
  const doc = sourceFixture(provider, name)
  const list = Array.isArray(doc) ? doc.slice(1) : (doc as Record<string, unknown[]>)[key]
  return list?.[0]
}

const rows: Row[] = [
  {
    name: 'remoteok',
    spec: remoteokSpec as Row['spec'],
    config: remoteokProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('remoteok', 'feed', ''),
    expected: '1137557',
  },
  {
    name: 'remotive',
    spec: remotiveSpec as Row['spec'],
    config: remotiveProvider.parseConfig({ configVersion: 1, category: 'devops' }),
    rawItem: first('remotive', 'software-dev', 'jobs'),
    expected: '2091158',
  },
  {
    name: 'himalayas (browse)',
    spec: himalayasBrowseSpec as Row['spec'],
    config: himalayasProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('himalayas', 'browse-page1', 'jobs'),
    expected:
      'https://himalayas.app/companies/bright-vision-technologies/jobs/data-platform-architect-1149275416',
  },
  {
    name: 'himalayas (search)',
    spec: himalayasSearchSpec as Row['spec'],
    config: himalayasProvider.parseConfig({ configVersion: 1, endpoint: 'search' }),
    rawItem: first('himalayas', 'search-page1', 'jobs'),
    expected:
      'https://himalayas.app/companies/micro1/jobs/mechanical-engineering-expert-msc-or-phd',
  },
  {
    name: 'jobicy',
    spec: jobicySpec as Row['spec'],
    config: jobicyProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('jobicy', 'seeded-page1', 'jobs'),
    expected: '156602',
  },
  {
    name: 'arbeitnow',
    spec: arbeitnowSpec as Row['spec'],
    config: arbeitnowProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('arbeitnow', 'page-1', 'data'),
    expected: 'inside-solutions-engineer-454685',
  },
  {
    name: 'jobgether',
    spec: jobgetherSpec as Row['spec'],
    config: jobgetherProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('jobgether', 'page-1', 'jobs'),
    expected: '6adc0a6822c2644c03e6a821',
  },
  {
    name: 'hn-hiring (thread step)',
    spec: hnSpec(new Date('2026-10-24T03:00:00Z'), 45) as Row['spec'],
    config: hnHiringProvider.parseConfig({ configVersion: 1 }),
    rawItem: first('hn-hiring', 'thread-2026-10', 'children'),
    expected: '49922584',
  },
]

describe('nativeIdOf is the provider id, and the same field mapItem keys identity on', () => {
  it.each(rows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const item = row.spec.itemSchema.parse(row.rawItem) as never
    expect(row.spec.nativeIdOf(item, row.config as never)).toBe(row.expected)
    expect(row.spec.mapItem(item, row.config as never).nativeId).toBe(row.expected)
  })

  it('two different items give two different ids (the id is not a constant)', () => {
    const a = remotiveSpec.itemSchema.parse(first('remotive', 'software-dev', 'jobs'))
    const doc = sourceFixture('remotive', 'software-dev') as { jobs: unknown[] }
    const b = remotiveSpec.itemSchema.parse(doc.jobs[1])
    const cfg = remotiveProvider.parseConfig({ configVersion: 1, category: 'devops' })
    expect(remotiveSpec.nativeIdOf(a, cfg)).not.toBe(remotiveSpec.nativeIdOf(b, cfg))
  })
})
