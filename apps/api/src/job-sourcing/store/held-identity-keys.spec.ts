import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { heldIdentityKeys } from './held-identity-keys'

/**
 * Unit double for `heldIdentityKeys` (sources-12): the mutation gate cannot run the integration
 * spec beside it, so the query's shape and the row mapping are pinned here as well.
 */
const dialect = new PgDialect()

function executor(rows: Record<string, unknown>[]) {
  const seen: { sql: string; params: unknown[] }[] = []
  return {
    seen,
    db: {
      execute: async (q: SQL) => {
        seen.push(dialect.sqlToQuery(q))
        return { rows }
      },
    },
  }
}

const input = {
  sourceType: 'NEXTLEVELJOBS_HTML' as const,
  namespace: 'nextleveljobs',
  keys: ['["a"]', '["b"]'],
}

describe('heldIdentityKeys', () => {
  it('asks nothing for an empty list', async () => {
    const { db, seen } = executor([{ identity_key: 'x' }])
    expect(await heldIdentityKeys(db, { ...input, keys: [] })).toEqual(new Set())
    expect(seen).toEqual([])
  })

  it('passes type, namespace and the keys as one jsonb parameter, and maps rows to a set', async () => {
    const { db, seen } = executor([{ identity_key: '["a"]' }, { identity_key: '["a"]' }])
    expect(await heldIdentityKeys(db, input)).toEqual(new Set(['["a"]']))
    expect(seen).toHaveLength(1)
    const q = seen[0]!
    expect(q.params).toEqual(['NEXTLEVELJOBS_HTML', 'nextleveljobs', '["[\\"a\\"]","[\\"b\\"]"]'])
    expect(q.sql.replace(/\s+/g, ' ')).toBe(
      'SELECT identity_key FROM job_source_records WHERE source_type = $1::job_source_type AND namespace = $2 AND identity_key IN (SELECT jsonb_array_elements_text($3::jsonb))',
    )
  })
})
