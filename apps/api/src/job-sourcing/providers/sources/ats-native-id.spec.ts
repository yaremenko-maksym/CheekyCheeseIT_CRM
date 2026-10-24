import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { sourceFixture } from '../../../test/source-fixtures'
import { ashbyProvider, ashbySpec } from './ashby.provider'
import { greenhouseProvider, greenhouseSpec } from './greenhouse.provider'
import { leverProvider, leverSpec } from './lever.provider'

/**
 * `nativeIdOf` is the provider's own id for an item, and the loop's collision check compares it
 * across items that landed on one identity key. The check is reachable only for URL-keyed
 * identity, which none of these adapters uses for a normal id, so nothing but a look at the spec
 * object can see that `nativeIdOf` and the `mapItem` native id are the SAME field. Same table
 * shape as `native-id.spec.ts` (Task 3.1), kept in this task's own file. Expected ids are
 * literals read from the captures.
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

const jobs = (provider: string, name: string): unknown[] => {
  const doc = sourceFixture(provider, name)
  return Array.isArray(doc) ? doc : (doc as { jobs: unknown[] }).jobs
}

const rows: Row[] = [
  {
    name: 'greenhouse',
    spec: greenhouseSpec as Row['spec'],
    config: greenhouseProvider.parseConfig({ configVersion: 1, board: 'airbnb' }),
    rawItem: jobs('greenhouse', 'airbnb-board')[0],
    expected: '8102684',
  },
  {
    name: 'lever',
    spec: leverSpec as Row['spec'],
    config: leverProvider.parseConfig({ configVersion: 1, board: 'spotify' }),
    rawItem: jobs('lever', 'spotify-page1')[0],
    expected: 'e2c7bbb8-f873-42c7-811f-0bd45bf452ae',
  },
  {
    name: 'ashby',
    spec: ashbySpec as Row['spec'],
    config: ashbyProvider.parseConfig({ configVersion: 1, board: 'linear' }),
    rawItem: jobs('ashby', 'linear-board')[0],
    expected: 'c97e034e-19a8-4ec7-89a5-c81987451da8',
  },
]

describe('nativeIdOf is the provider id, and the same field mapItem keys identity on', () => {
  it.each(rows.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const item = row.spec.itemSchema.parse(row.rawItem) as never
    expect(row.spec.nativeIdOf(item, row.config as never)).toBe(row.expected)
    expect(row.spec.mapItem(item, row.config as never).nativeId).toBe(row.expected)
  })

  it('the next posting gives a different id (the id is not a constant)', () => {
    for (const row of rows) {
      const fixture =
        row.name === 'greenhouse'
          ? 'airbnb-board'
          : row.name === 'lever'
            ? 'spotify-page1'
            : 'linear-board'
      const second = row.spec.itemSchema.parse(jobs(row.name, fixture)[1]) as never
      expect(row.spec.nativeIdOf(second, row.config as never)).not.toBe(row.expected)
    }
  })
})
