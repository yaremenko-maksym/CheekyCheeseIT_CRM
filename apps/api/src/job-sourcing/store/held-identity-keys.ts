import type { JobSourceType } from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../scheduling/host-state'

export interface HeldIdentityKeysInput {
  readonly sourceType: JobSourceType
  readonly namespace: string
  readonly keys: readonly string[]
}

/**
 * Which of `keys` the source already holds as a record (sources-12). A delta source that lists
 * every posting id but must fetch each detail separately (Next Level Jobs: a sitemap of URLs) asks
 * this before spending a request, and fetches only the rest.
 *
 * Read-only. It matches on the record's unique `(source_type, namespace, identity_key)` triple, so
 * the answer is exact and there is no LIMIT that could quietly cut it. The keys travel as ONE
 * jsonb parameter, never interpolated, so a key holding quotes or commas is not an injection
 * surface.
 */
export async function heldIdentityKeys(
  db: SqlExecutor,
  input: HeldIdentityKeysInput,
): Promise<ReadonlySet<string>> {
  if (input.keys.length === 0) return new Set()
  const { rows } = await db.execute(
    sql`SELECT identity_key FROM job_source_records
         WHERE source_type = ${input.sourceType}::job_source_type
           AND namespace = ${input.namespace}
           AND identity_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.keys)}::jsonb))`,
  )
  return new Set(rows.map((r) => String(r['identity_key'])))
}
