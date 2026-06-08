import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { ContractTargetRole, CustomVariable } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { contractTemplates } from '../database/schema'

/**
 * Onboarding Phase 6A — manages editable per-role MSA templates.
 *
 * Invariants:
 *   - `target_role <> 'ADMIN'` (DB CHECK constraint + service guard)
 *   - at most one row per `target_role` has `is_active = true` (DB partial
 *     unique index + atomic publish transaction)
 *
 * `publish` is the only mutation: atomically deactivates the previously
 * active row for the role (if any) and inserts a new row with
 * `version = max(version)+1` (or 1 if no prior row), `is_active = true`.
 */
@Injectable()
export class ContractTemplatesService {
  constructor(private readonly db: DatabaseService) {}

  async listAll() {
    return this.db.db.query.contractTemplates.findMany({
      orderBy: (tbl, { asc }) => [asc(tbl.targetRole), asc(tbl.version)],
    })
  }

  async getCurrentForRole(role: ContractTargetRole) {
    if ((role as string) === 'ADMIN') {
      throw new ForbiddenException('ADMIN_DOES_NOT_HAVE_CONTRACT_TEMPLATE')
    }
    const row = await this.db.db.query.contractTemplates.findFirst({
      where: (tbl, { eq, and }) => and(eq(tbl.targetRole, role), eq(tbl.isActive, true)),
    })
    return row ?? null
  }

  async getById(id: string) {
    const row = await this.db.db.query.contractTemplates.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, id),
    })
    if (!row) throw new NotFoundException('Contract template not found')
    return row
  }

  async publish({
    targetRole,
    bodyMarkdown,
    createdByUserId,
    customVariables = [],
  }: {
    targetRole: ContractTargetRole
    bodyMarkdown: string
    createdByUserId: string
    /** Admin-authored custom variable definitions for this template version. */
    customVariables?: CustomVariable[]
  }) {
    if ((targetRole as string) === 'ADMIN') {
      throw new ForbiddenException('CANNOT_PUBLISH_ADMIN_CONTRACT_TEMPLATE')
    }

    return this.db.db.transaction(async (tx) => {
      // Resolve next version atomically (within the same tx as the deactivate+insert).
      const rows = (await tx
        .select({ max: sql<number | null>`MAX(${contractTemplates.version})` })
        .from(contractTemplates)
        .where(eq(contractTemplates.targetRole, targetRole))
        .execute()) as Array<{ max: number | null }>
      const nextVersion = (rows[0]?.max ?? 0) + 1

      // Deactivate the previous active row for this role (no-op if none).
      await tx
        .update(contractTemplates)
        .set({ isActive: false })
        .where(
          and(eq(contractTemplates.targetRole, targetRole), eq(contractTemplates.isActive, true)),
        )

      const [inserted] = await tx
        .insert(contractTemplates)
        .values({
          targetRole,
          version: nextVersion,
          bodyMarkdown,
          isActive: true,
          createdByUserId,
          customVariables,
        })
        .returning()

      if (!inserted) throw new Error('Failed to insert contract template')
      return inserted
    })
  }
}
