/**
 * Record-and-restore for the CLUSTER-wide ACLs the privilege roles file rewrites.
 *
 * The roles file revokes PUBLIC's CONNECT and TEMPORARY on `postgres` and `template1`.
 * `pg_database` is a shared catalog, so that change outlives the integration database and
 * lands on every database the cluster serves. `db-privileges.integration.spec.ts` must
 * apply the file (part 6 of the catalog check asserts the revocation), so the side effect
 * is inherent; this puts the ACLs back instead of refusing to run.
 *
 * Why a catalog UPDATE and not `GRANT … TO PUBLIC`: NULL means "the built-in default ACL"
 * and is NOT the same state as an explicit ACL that happens to spell the default out. A
 * GRANT cannot return a column to NULL, nor reproduce an arbitrary prior ACL byte for
 * byte. Writing the recorded `aclitem[]` back (or NULL) does both. It needs a superuser,
 * which the migration role of every environment this spec runs in already is — it
 * creates roles.
 */
import { Pool } from 'pg'

/** The databases whose ACL the roles file rewrites outside the integration database. */
export const CLUSTER_DATABASES = ['postgres', 'template1'] as const

export interface ClusterAclSnapshot {
  /** The recorded `datacl::text` per database; `null` is a NULL ACL, not an absent entry. */
  readonly recorded: ReadonlyMap<string, string | null>
  /** Writes every recorded ACL back, exactly. Safe to call more than once. */
  restore(): Promise<void>
}

/** Reads the current ACLs. Opens and closes its own pool, so it works before any other. */
export async function snapshotClusterAcls(connectionString: string): Promise<ClusterAclSnapshot> {
  const pool = new Pool({ connectionString, max: 1 })
  try {
    const { rows } = await pool.query<{ datname: string; datacl: string | null }>(
      `SELECT datname, datacl::text AS datacl FROM pg_database WHERE datname = ANY($1::text[])`,
      [CLUSTER_DATABASES],
    )
    const recorded = new Map(rows.map((row) => [row.datname, row.datacl]))
    return {
      recorded,
      restore: async () => {
        const restorePool = new Pool({ connectionString, max: 1 })
        try {
          for (const [datname, datacl] of recorded) {
            await restorePool.query(
              `UPDATE pg_database SET datacl = $1::aclitem[] WHERE datname = $2`,
              [datacl, datname],
            )
          }
        } finally {
          await restorePool.end()
        }
      },
    }
  } finally {
    await pool.end()
  }
}
