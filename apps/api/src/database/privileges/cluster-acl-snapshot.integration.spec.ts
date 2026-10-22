/**
 * `cluster-acl-snapshot.ts`, pinned on its own (CR-M-13): snapshot, alter, restore, compare.
 *
 * The property that matters is "it can only write back what it recorded" — and the case
 * that is easiest to get wrong is a NULL ACL, which means "the built-in default" and is NOT
 * the same state as an explicit ACL spelling the default out.
 *
 * It never touches `postgres` or `template1`. `db-privileges.integration.spec.ts` snapshots
 * those at its start and writes them back at its end, and vitest runs spec files in
 * parallel: altering them here would put a foreign state into that snapshot. So this file
 * creates two databases of its own and passes their names to the helper.
 */
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertNotLiveDb } from '../../test/assert-not-live-db'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { CLUSTER_DATABASES, cleanupThenRestore, snapshotClusterAcls } from './cluster-acl-snapshot'

describe.skipIf(!hasDatabaseUrl())('cluster-acl-snapshot', () => {
  const url = process.env['DATABASE_URL'] as string
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  /** A fresh database: `datacl` is NULL. */
  const nullDb = `aclprobe_null_${suffix}`
  /** A database with an explicit, non-default ACL. */
  const setDb = `aclprobe_set_${suffix}`
  const probes = [nullDb, setDb] as const
  let admin: Pool

  async function aclOf(datname: string): Promise<string | null> {
    const { rows } = await admin.query<{ datacl: string | null }>(
      `SELECT datacl::text AS datacl FROM pg_database WHERE datname = $1`,
      [datname],
    )
    if (rows.length !== 1) throw new Error(`[cluster-acl-snapshot] no database ${datname}`)
    return rows[0]?.datacl ?? null
  }

  beforeAll(async () => {
    assertNotLiveDb(url, 'cluster-acl-snapshot')
    admin = new Pool({ connectionString: url, max: 1 })
    await admin.query(`CREATE DATABASE ${nullDb}`)
    await admin.query(`CREATE DATABASE ${setDb}`)
    await admin.query(`REVOKE TEMPORARY ON DATABASE ${setDb} FROM PUBLIC`)
  }, 60_000)

  afterAll(async () => {
    try {
      for (const db of probes) {
        await admin?.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => undefined)
      }
    } finally {
      await admin?.end()
    }
  })

  it('starts from the two states it must tell apart', async () => {
    // Without this the NULL tests below could pass on a database that was never NULL.
    expect(await aclOf(nullDb)).toBeNull()
    expect(await aclOf(setDb)).toMatch(/^\{.+\}$/)
  })

  it('records a NULL ACL as null — present, not absent', async () => {
    const snapshot = await snapshotClusterAcls(url, probes)
    expect([...snapshot.recorded.keys()].sort()).toEqual([nullDb, setDb].sort())
    expect(snapshot.recorded.has(nullDb)).toBe(true)
    expect(snapshot.recorded.get(nullDb)).toBeNull()
    expect(snapshot.recorded.get(setDb)).toBe(await aclOf(setDb))
  })

  it('puts a NULL ACL back to NULL, not to the default spelled out', async () => {
    const snapshot = await snapshotClusterAcls(url, probes)
    // A REVOKE turns NULL into an explicit array; a GRANT cannot turn it back.
    await admin.query(`REVOKE CONNECT ON DATABASE ${nullDb} FROM PUBLIC`)
    expect(await aclOf(nullDb)).not.toBeNull()
    await snapshot.restore()
    expect(await aclOf(nullDb)).toBeNull()
  })

  it('puts an explicit ACL back exactly', async () => {
    const before = await aclOf(setDb)
    const snapshot = await snapshotClusterAcls(url, probes)
    await admin.query(`GRANT ALL ON DATABASE ${setDb} TO PUBLIC`)
    expect(await aclOf(setDb)).not.toBe(before)
    await snapshot.restore()
    expect(await aclOf(setDb)).toBe(before)
  })

  it('is safe to restore more than once', async () => {
    const before = await aclOf(setDb)
    const snapshot = await snapshotClusterAcls(url, probes)
    await admin.query(`REVOKE CONNECT ON DATABASE ${nullDb} FROM PUBLIC`)
    await snapshot.restore()
    await snapshot.restore()
    expect(await aclOf(nullDb)).toBeNull()
    expect(await aclOf(setDb)).toBe(before)
  })

  it('writes back only what it recorded — a database it did not record keeps its change', async () => {
    const snapshot = await snapshotClusterAcls(url, [nullDb])
    await admin.query(`REVOKE CONNECT ON DATABASE ${nullDb} FROM PUBLIC`)
    await admin.query(`GRANT ALL ON DATABASE ${setDb} TO PUBLIC`)
    const changed = await aclOf(setDb)
    try {
      await snapshot.restore()
      expect(await aclOf(nullDb)).toBeNull()
      expect(await aclOf(setDb)).toBe(changed)
    } finally {
      await admin.query(`REVOKE ALL ON DATABASE ${setDb} FROM PUBLIC`)
      await admin.query(`GRANT CONNECT ON DATABASE ${setDb} TO PUBLIC`)
    }
  })

  it('defaults to the two cluster databases the roles file rewrites', async () => {
    // Read-only: it records them and restores nothing.
    expect(CLUSTER_DATABASES).toEqual(['postgres', 'template1'])
    const snapshot = await snapshotClusterAcls(url)
    expect([...snapshot.recorded.keys()].sort()).toEqual(['postgres', 'template1'])
  })

  it('CR-M-11: restores even when a cleanup STATEMENT throws, and still reports that error', async () => {
    // The path the review found: the restore sat after unprotected awaits in `afterAll`,
    // so the first failing cleanup statement left PUBLIC's CONNECT revoked. The cleanup
    // here throws from the server, exactly as a failing `DROP` does.
    const snapshot = await snapshotClusterAcls(url, probes)
    await admin.query(`REVOKE CONNECT ON DATABASE ${nullDb} FROM PUBLIC`)
    await expect(
      cleanupThenRestore(async () => {
        await admin.query(`DROP TABLE aclprobe_missing_table_${suffix}`)
      }, snapshot),
    ).rejects.toThrow(/does not exist/)
    expect(await aclOf(nullDb)).toBeNull()
  })

  it('CR-M-11: with no snapshot (beforeAll failed first), still runs the cleanup', async () => {
    let ran = false
    await cleanupThenRestore(async () => {
      ran = true
    }, undefined)
    expect(ran).toBe(true)
  })
})
