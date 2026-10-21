import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertBackdatedJobQueueActionAsTableOwner } from './backdated-job-queue-action'

/**
 * The helper's OWN logic, pinned against a fake `pg` client — no database.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two reasons, and the second is the load-bearing one.
 *
 * First, mechanically: the helper is the one non-spec file in its PR's diff, so the
 * mutation gate mutates it — but its only real consumers are integration specs, which
 * the gate excludes from mutation. Vitest's `related` resolution therefore found no test
 * importing it, Stryker produced no report, and the gate refused the run (correctly: an
 * exit code without a report means "did not look", not "clean"). This spec imports the
 * helper DIRECTLY, which is what that warning asks for.
 *
 * Second, substantively: this helper manufactures a state the product forbids — an aged
 * audit row — by switching off `trg_job_queue_actions_created_at_now`. Its correctness is
 * therefore load-bearing in a way a fixture's usually is not. What must hold is the SHAPE
 * of the window, and nothing but a test of the statement sequence can hold it: that the
 * guard is off for exactly the one INSERT, that it comes back `ENABLE ALWAYS` and not
 * plain `ENABLE`, and that a throw anywhere inside ends in `ROLLBACK` rather than a
 * half-open window. An integration test can see the END state; only this can see that the
 * window was never wider than one statement.
 */

interface FakeOptions {
  /** Statement substring that should throw when executed. */
  failOn?: string
  /** `tgenabled` the post-commit verification read reports. */
  tgenabled?: string
  /** The verification read finds no such trigger at all — a dropped guard. */
  guardMissing?: boolean
}

function fakeClient(opts: FakeOptions = {}) {
  const log: string[] = []
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      const sql = String(text)
      log.push(sql)
      if (opts.failOn && sql.includes(opts.failOn)) {
        throw new Error(`fake pg: refused ${opts.failOn}`)
      }
      if (sql.includes('SELECT t.tgenabled')) {
        return { rows: opts.guardMissing ? [] : [{ tgenabled: opts.tgenabled ?? 'A' }] }
      }
      if (sql.includes('INSERT INTO job_queue_actions')) {
        return { rows: [{ id: 'row-id-1' }] }
      }
      return { rows: [] }
    },
    release: () => {
      log.push('RELEASE')
    },
  }
  return { client, log }
}

function fakePool(opts: FakeOptions = {}) {
  const { client, log } = fakeClient(opts)
  const pool = {
    connect: async () => client as unknown as PoolClient,
  } as unknown as Pool
  return { pool, log }
}

const ROW = {
  actorId: 'actor-1',
  opportunityId: 'opp-1',
  idempotencyKey: 'tag-1',
  age: '2 years 1 day',
}

/** The statements in order, with the parameter noise dropped. */
const shape = (log: readonly string[]) =>
  log.map((s) => {
    if (s.includes('DISABLE TRIGGER')) return 'DISABLE'
    if (s.includes('ENABLE ALWAYS TRIGGER')) return 'ENABLE ALWAYS'
    if (s.includes('ENABLE TRIGGER')) return 'ENABLE (plain — would downgrade to O)'
    if (s.includes('INSERT INTO job_queue_actions')) return 'INSERT'
    if (s.includes('SELECT t.tgenabled')) return 'VERIFY'
    return s.trim()
  })

describe('insertBackdatedJobQueueActionAsTableOwner', () => {
  it('opens the window for exactly one INSERT and closes it inside the same transaction', async () => {
    const { pool, log } = fakePool()

    const id = await insertBackdatedJobQueueActionAsTableOwner(pool, ROW)

    expect(id).toBe('row-id-1')
    // The whole point of the helper, as a sequence: nothing but the INSERT happens while
    // the guard is down, and the re-enable precedes the COMMIT, so the window is bounded
    // by the transaction and not by this function's control flow.
    expect(shape(log)).toEqual([
      'BEGIN',
      'DISABLE',
      'INSERT',
      'ENABLE ALWAYS',
      'COMMIT',
      'VERIFY',
      'RELEASE',
    ])
  })

  it('disables only the created_at guard and leaves the append-only ones alone', async () => {
    const { pool, log } = fakePool()

    await insertBackdatedJobQueueActionAsTableOwner(pool, ROW)

    const disables = log.filter((s) => s.includes('DISABLE TRIGGER'))
    expect(disables).toHaveLength(1)
    expect(disables[0]).toContain('trg_job_queue_actions_created_at_now')
    // The guards whose absence would make the aged row prove nothing about an append-only
    // table — never touched.
    expect(log.join('\n')).not.toContain('trg_job_queue_actions_append_only')
    expect(log.join('\n')).not.toContain('trg_job_queue_actions_no_truncate')
  })

  it('restores the guard with ENABLE ALWAYS, not the plain form that downgrades it to O', async () => {
    const { pool, log } = fakePool()

    await insertBackdatedJobQueueActionAsTableOwner(pool, ROW)

    // A plain `ENABLE TRIGGER` sets tgenabled to 'O', which is skipped under
    // `session_replication_role = replica` — the exact bypass the DDL file exists to
    // close. Restoring the guard in the weaker mode would re-open it permanently.
    expect(log.some((s) => s.includes('ENABLE ALWAYS TRIGGER'))).toBe(true)
    expect(shape(log)).not.toContain('ENABLE (plain — would downgrade to O)')
  })

  it('rolls back and rethrows when the INSERT itself fails, leaving no half-open window', async () => {
    const { pool, log } = fakePool({ failOn: 'INSERT INTO job_queue_actions' })

    await expect(insertBackdatedJobQueueActionAsTableOwner(pool, ROW)).rejects.toThrow(
      /refused INSERT INTO job_queue_actions/,
    )

    // The failure path reaches ROLLBACK, which reverts the catalog change too: the
    // restoration does not depend on an `ENABLE ALWAYS` statement we never got to run.
    expect(shape(log)).toEqual(['BEGIN', 'DISABLE', 'INSERT', 'ROLLBACK', 'RELEASE'])
    expect(log.some((s) => s.includes('COMMIT'))).toBe(false)
  })

  it('rolls back when the re-enable fails, rather than committing a disabled guard', async () => {
    const { pool, log } = fakePool({ failOn: 'ENABLE ALWAYS TRIGGER' })

    await expect(insertBackdatedJobQueueActionAsTableOwner(pool, ROW)).rejects.toThrow(
      /refused ENABLE ALWAYS TRIGGER/,
    )

    // The dangerous shape this rules out: committing the transaction with the guard still
    // down, which would leave the table permanently unguarded.
    expect(log.some((s) => s.includes('COMMIT'))).toBe(false)
    expect(shape(log)).toContain('ROLLBACK')
  })

  it('releases the client even when the transaction fails', async () => {
    const { pool, log } = fakePool({ failOn: 'BEGIN' })

    await expect(insertBackdatedJobQueueActionAsTableOwner(pool, ROW)).rejects.toThrow(
      /refused BEGIN/,
    )

    // A leaked client exhausts the pool and makes a LATER spec fail for a reason that has
    // nothing to do with it.
    expect(log[log.length - 1]).toBe('RELEASE')
  })

  it('throws when the guard is left disabled after the commit, instead of returning the id', async () => {
    // The post-commit read is not decoration: if the window were somehow left open, the
    // next suite would run against an unguarded table and never know. 'O' is the plain
    // ENABLE state, the realistic way this goes wrong.
    const { pool } = fakePool({ tgenabled: 'O' })

    await expect(insertBackdatedJobQueueActionAsTableOwner(pool, ROW)).rejects.toThrow(
      /trg_job_queue_actions_created_at_now is 'O' after ageing a row, expected 'A'/,
    )
  })

  it('throws when the guard has vanished from the catalog entirely', async () => {
    // No row at all — a DROPPED guard, not merely a disabled one. The optional chain on
    // `state[0]` is what makes this a thrown error rather than a TypeError, and this is
    // the only input that distinguishes the two.
    const { pool } = fakePool({ guardMissing: true })

    await expect(insertBackdatedJobQueueActionAsTableOwner(pool, ROW)).rejects.toThrow(
      /is 'undefined' after ageing a row, expected 'A' \(ENABLE ALWAYS\)/,
    )
  })

  it('passes the age through as an interval and the reason through verbatim', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const client = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ sql: String(text), params })
        if (String(text).includes('SELECT t.tgenabled')) return { rows: [{ tgenabled: 'A' }] }
        return { rows: [{ id: 'row-id-1' }] }
      },
      release: () => undefined,
    }
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool

    await insertBackdatedJobQueueActionAsTableOwner(pool, { ...ROW, reason: 'because' })

    const insert = calls.find((c) => c.sql.includes('INSERT INTO job_queue_actions'))
    // `now() - $5::interval` — the age is the database's arithmetic, not a JS date, so a
    // test asking for '2 years 1 day' gets PostgreSQL's calendar answer and not a 730-day
    // approximation of it.
    expect(insert?.sql).toContain(`now() - $5::interval`)
    expect(insert?.params).toEqual(['opp-1', 'actor-1', 'tag-1', 'because', '2 years 1 day'])
  })

  it('distinguishes an omitted reason (NULL) from an explicitly null one', async () => {
    const params = async (reason: string | null | undefined) => {
      const calls: unknown[][] = []
      const client = {
        query: async (text: string, p?: unknown[]) => {
          if (p) calls.push(p)
          if (String(text).includes('SELECT t.tgenabled')) return { rows: [{ tgenabled: 'A' }] }
          return { rows: [{ id: 'row-id-1' }] }
        },
        release: () => undefined,
      }
      const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool
      await insertBackdatedJobQueueActionAsTableOwner(
        pool,
        reason === undefined ? ROW : { ...ROW, reason },
      )
      return calls.find((c) => c.length === 5)
    }

    // Both become SQL NULL: the suites that need a non-null reason supply one, and the
    // redaction tests need `null` to be reachable. The branch exists so that `undefined`
    // cannot arrive at `pg` as a parameter it would reject.
    expect((await params(undefined))?.[3]).toBeNull()
    expect((await params(null))?.[3]).toBeNull()
    expect((await params('kept'))?.[3]).toBe('kept')
  })
})
