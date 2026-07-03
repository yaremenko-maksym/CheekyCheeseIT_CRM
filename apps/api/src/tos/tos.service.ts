import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { and, desc, eq, sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { tosAcceptances, tosVersions } from '../database/schema'
import type { DrizzleTx } from '../database/types' // still used by publish()

/**
 * Onboarding Phase 6A — Terms of Service.
 *
 * Single active version globally (partial unique index `WHERE is_active = true`).
 * `publish` atomically deactivates the previous active row and inserts a new
 * row with `version = max + 1`, `isActive = true`.
 *
 * `accept` is idempotent via `INSERT … ON CONFLICT (user_id, tos_version_id) DO NOTHING`.
 * This is race-safe: even if two concurrent requests pass the pre-check simultaneously,
 * only one INSERT wins and the other gets an empty RETURNING — we then fetch the
 * existing row. The UNIQUE constraint on (user_id, tos_version_id) is the source of truth.
 */

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE 23505). Drizzle-orm wraps query
 * failures so the original pg error lives on `.cause`; this walks the chain.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if ((cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

@Injectable()
export class TosService {
  constructor(private readonly db: DatabaseService) {}

  async getCurrent() {
    const row = await this.db.db.query.tosVersions.findFirst({
      where: (tbl, { eq }) => eq(tbl.isActive, true),
    })
    return row ?? null
  }

  async listAll() {
    return this.db.db.query.tosVersions.findMany({
      orderBy: (tbl, { desc }) => desc(tbl.version),
    })
  }

  async publish({
    bodyMarkdown,
    createdByUserId,
  }: {
    bodyMarkdown: string
    createdByUserId: string
  }) {
    return this.db.db.transaction(async (tx: DrizzleTx) => {
      const rows = (await tx
        .select({ max: sql<number | null>`MAX(${tosVersions.version})` })
        .from(tosVersions)
        .execute()) as Array<{ max: number | null }>
      const nextVersion = (rows[0]?.max ?? 0) + 1

      await tx.update(tosVersions).set({ isActive: false }).where(eq(tosVersions.isActive, true))

      let inserted: typeof tosVersions.$inferSelect | undefined
      try {
        ;[inserted] = await tx
          .insert(tosVersions)
          .values({
            version: nextVersion,
            bodyMarkdown,
            isActive: true,
            createdByUserId,
          })
          .returning()
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          // Concurrent publish already inserted an active row — surface as 409
          // instead of a raw 500. The deactivate+insert dance is atomic per tx,
          // but two simultaneous callers can still race past the deactivate step.
          throw new ConflictException('DUPLICATE_ACTIVE_TOS')
        }
        throw err
      }

      if (!inserted) throw new Error('Failed to insert ToS version')
      return inserted
    })
  }

  /**
   * Returns the latest ToS acceptance for a given user, joined with the
   * version number. Returns null if the user has never accepted any ToS.
   *
   * Used by the profile endpoint to surface tosAcceptedAt / tosVersion
   * to ADMIN viewers (PR-1 Documents redesign).
   */
  async getLatestAcceptanceForUser(
    userId: string,
  ): Promise<{ acceptedAt: Date; tosVersion: number } | null> {
    const rows = await this.db.db
      .select({
        acceptedAt: tosAcceptances.acceptedAt,
        tosVersion: tosVersions.version,
      })
      .from(tosAcceptances)
      .innerJoin(tosVersions, eq(tosAcceptances.tosVersionId, tosVersions.id))
      .where(eq(tosAcceptances.userId, userId))
      .orderBy(desc(tosAcceptances.acceptedAt))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    return { acceptedAt: row.acceptedAt, tosVersion: row.tosVersion }
  }

  async accept({
    userId,
    ip,
    userAgent,
  }: {
    userId: string
    ip: string | null
    userAgent: string | null
  }) {
    const active = await this.getCurrent()
    if (!active) throw new NotFoundException('No active ToS version')

    // Atomic idempotent upsert: INSERT … ON CONFLICT (user_id, tos_version_id) DO NOTHING.
    // Race-safe: concurrent requests compete at the DB level; the UNIQUE constraint
    // guarantees only one row is ever inserted. If RETURNING is empty, the row already
    // existed — fetch it explicitly.
    const [inserted] = await this.db.db
      .insert(tosAcceptances)
      .values({
        userId,
        tosVersionId: active.id,
        acceptedIp: ip,
        acceptedUserAgent: userAgent,
      })
      .onConflictDoNothing()
      .returning()

    if (inserted) return inserted

    // Row already existed (conflict suppressed) — return the existing acceptance.
    const existing = await this.db.db.query.tosAcceptances.findFirst({
      where: and(eq(tosAcceptances.userId, userId), eq(tosAcceptances.tosVersionId, active.id)),
    })
    if (!existing) throw new Error('Failed to resolve ToS acceptance after conflict')
    return existing
  }
}
