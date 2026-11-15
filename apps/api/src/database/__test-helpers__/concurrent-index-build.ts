import type { Pool, PoolClient } from 'pg'

/**
 * Shared by the forward-DDL specs whose files sweep INVALID index leftovers before a
 * `CREATE INDEX CONCURRENTLY` (CR-M-3 of PR #1333: one copy instead of three).
 *
 * `parkConcurrentBuild` parks a `CREATE INDEX CONCURRENTLY` in its "waiting for old snapshots"
 * phase, which is the state where the index row EXISTS with `indisvalid = false` while a build is
 * genuinely in progress — the state the sweep has to tell apart from an abandoned leftover.
 *
 * Deterministic, and not a timing trick: a concurrent build must wait out every transaction
 * holding a snapshot older than its own, so a third session sitting in REPEATABLE READ parks it
 * for as long as that session lives, whatever the table size. Returns the handle the caller must
 * settle.
 *
 * The pool MUST connect as the same role as the session that runs the sweep (CR-M-2 of PR #1333):
 * `pg_stat_progress_create_index` hides another role's build, the sweep then returns early with
 * its "NOTHING is swept" notice, and a "spares a running build" case passes without the sweep ever
 * looking at the build.
 */
export interface ParkTarget {
  /** The scratch schema the build runs in. */
  schema: string
  /** The `search_path` of the holder and builder sessions. */
  searchPath: string
  /** The table the holder reads, so its snapshot is older than the build's. */
  table: string
  /** The index to build; its definition is read from `public`. */
  indexName: string
}

export async function parkConcurrentBuild(
  pool: Pool,
  { schema, searchPath, table, indexName }: ParkTarget,
): Promise<{ release: () => Promise<void> }> {
  const holder = await pool.connect()
  const builder = await pool.connect()
  await builder.query(`SET search_path TO ${searchPath}`)
  await holder.query(`SET search_path TO ${searchPath}`)

  // The definition is taken from the REFERENCE catalog, never written out here: an
  // approximation of it would rebuild the index with the wrong columns and leave the
  // schema silently diverged for every test that runs afterwards. (It did, once.)
  const definition = await holder.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND ic.relname = $1`,
    [indexName],
  )
  if (definition.rowCount !== 1) {
    holder.release()
    builder.release()
    throw new Error(`no reference definition for index ${indexName}`)
  }
  // Only the `ON public.<table>` qualification is rewritten — not every occurrence of the
  // string anywhere in the definition, which would also hit a predicate or an operator
  // class that happened to name the schema (CR-L-10).
  const create = String(definition.rows[0]['def'])
    .replace(
      /^CREATE (UNIQUE )?INDEX /,
      (_m, unique) => `CREATE ${unique ?? ''}INDEX CONCURRENTLY `,
    )
    .replace(/ ON public\./, ' ON ')

  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await holder.query(`SELECT count(*) FROM ${table}`)

  // Deliberately not awaited: this call does not return until the holder commits.
  const building = builder.query(create).catch((error: Error) => {
    // Surfaced by the assertions on the index's state; swallowing here keeps an
    // expected cancellation from becoming an unhandled rejection.
    return error
  })

  // Polled through the POOL, never through `holder`: the holder is sitting in a
  // REPEATABLE READ transaction, so its view of `pg_index` is frozen at a snapshot taken
  // before the build existed and it can never see the new index row. (It cost a run to
  // learn that `pg_stat_progress_create_index` is NOT frozen — it reads shared memory —
  // so the progress count moved while the catalog lookup stayed empty forever.)
  const deadline = Date.now() + 20_000
  for (;;) {
    const progress = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_progress_create_index
        WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )
    const index = await pool.query(
      `SELECT i.indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, indexName],
    )
    if (
      progress.rows[0]['n'] > 0 &&
      index.rowCount === 1 &&
      index.rows[0]['indisvalid'] === false
    ) {
      break
    }
    if (Date.now() > deadline) {
      // CR-L-9: the ROLLBACK first, so the build can finish, then AWAIT it before either
      // client goes back to the pool. Releasing a client whose query is still running
      // hands a busy connection to the next caller, and the failure surfaces somewhere
      // unrelated — which is the worst way for a timeout path to fail.
      await holder.query('ROLLBACK').catch(() => undefined)
      await building
      holder.release()
      builder.release()
      throw new Error(`build of ${indexName} did not park within 20s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return {
    release: async () => {
      await holder.query('COMMIT').catch(() => undefined)
      await building
      holder.release()
      builder.release()
    },
  }
}

/** Collects the server's NOTICEs for the duration of one call. */
export async function withNotices<T>(
  client: PoolClient,
  run: () => Promise<T>,
): Promise<{ result: T; notices: string[] }> {
  const notices: string[] = []
  const listener = (message: { message?: string | undefined }): void => {
    if (message.message) notices.push(message.message)
  }
  client.on('notice', listener)
  try {
    const result = await run()
    return { result, notices }
  } finally {
    client.off('notice', listener)
  }
}
