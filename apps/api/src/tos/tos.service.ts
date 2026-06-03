import { Injectable, NotFoundException } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { tosAcceptances, tosVersions } from '../database/schema'
import type { DrizzleTx } from '../database/types'

/**
 * Onboarding Phase 6A — Terms of Service.
 *
 * Single active version globally (partial unique index `WHERE is_active = true`).
 * `publish` atomically deactivates the previous active row and inserts a new
 * row with `version = max + 1`, `isActive = true`.
 *
 * `accept` is idempotent: if user already has an acceptance for the active
 * version, returns it without insert (no UNIQUE-violation race).
 */
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

      const [inserted] = await tx
        .insert(tosVersions)
        .values({
          version: nextVersion,
          bodyMarkdown,
          isActive: true,
          createdByUserId,
        })
        .returning()

      if (!inserted) throw new Error('Failed to insert ToS version')
      return inserted
    })
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

    // Pre-check existing acceptance to avoid UNIQUE-violation on race & to
    // keep the flow idempotent (UI may double-tap the accept button).
    const existing = await this.db.db.query.tosAcceptances.findFirst({
      where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.tosVersionId, active.id)),
    })
    if (existing) return existing

    return this.db.db.transaction(async (tx: DrizzleTx) => {
      // Re-check inside tx (read-your-writes safety on concurrent submissions).
      const reCheck = await tx.query.tosAcceptances.findFirst({
        where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.tosVersionId, active.id)),
      })
      if (reCheck) return reCheck

      const [inserted] = await tx
        .insert(tosAcceptances)
        .values({
          userId,
          tosVersionId: active.id,
          acceptedIp: ip,
          acceptedUserAgent: userAgent,
        })
        .returning()

      if (!inserted) throw new Error('Failed to insert ToS acceptance')
      return inserted
    })
  }
}
