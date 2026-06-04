import { Injectable } from '@nestjs/common'
import { and, desc, gte, lte, eq } from 'drizzle-orm'
import type { AuditAllQuery, AuditTrailResponse, AuditAllResponse, AuditEvent } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { signedContracts, tosAcceptances, contractTemplates, tosVersions } from '../database/schema'

/**
 * Phase 6 polish PR3 — compliance audit trail.
 *
 * Reads two immutable audit tables:
 *   - `signed_contracts` — MSA signing records (frozen at signing time)
 *   - `tos_acceptances` — ToS acceptance records
 *
 * No writes — purely read-only service for compliance & GDPR data portability.
 *
 * SECURITY: `getUserAudit` returns only rows belonging to `userId`.
 * `getAllAudit` is gated at controller level to ACCOUNTANT + ADMIN only.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Returns the caller's own compliance audit trail.
   * Capped at last 50 records per type to keep response size bounded.
   * No pagination — user's own data is small (sign once, accept ToS few times).
   */
  async getUserAudit(userId: string): Promise<AuditTrailResponse> {
    const [contractRows, tosRows] = await Promise.all([
      this.db.db
        .select({
          id: signedContracts.id,
          contractNumber: signedContracts.contractNumber,
          signedAt: signedContracts.signedAt,
          signedTypedName: signedContracts.signedTypedName,
          signedIp: signedContracts.signedIp,
          bodyMarkdownSnapshot: signedContracts.bodyMarkdownSnapshot,
          templateRole: contractTemplates.targetRole,
          templateVersion: contractTemplates.version,
        })
        .from(signedContracts)
        .innerJoin(contractTemplates, eq(contractTemplates.id, signedContracts.templateId))
        .where(eq(signedContracts.userId, userId))
        .orderBy(desc(signedContracts.signedAt))
        .limit(50),

      this.db.db
        .select({
          id: tosAcceptances.id,
          acceptedAt: tosAcceptances.acceptedAt,
          acceptedIp: tosAcceptances.acceptedIp,
          tosVersion: tosVersions.version,
          tosBodyMarkdown: tosVersions.bodyMarkdown,
        })
        .from(tosAcceptances)
        .innerJoin(tosVersions, eq(tosVersions.id, tosAcceptances.tosVersionId))
        .where(eq(tosAcceptances.userId, userId))
        .orderBy(desc(tosAcceptances.acceptedAt))
        .limit(50),
    ])

    return {
      signedContracts: contractRows.map((r) => ({
        type: 'contract' as const,
        id: r.id,
        contractNumber: r.contractNumber,
        signedAt: r.signedAt.toISOString(),
        signedTypedName: r.signedTypedName,
        signedIp: r.signedIp ?? null,
        templateRole: r.templateRole as AuditTrailResponse['signedContracts'][number]['templateRole'],
        templateVersion: r.templateVersion,
        bodyMarkdownSnapshot: r.bodyMarkdownSnapshot,
      })),
      tosAcceptances: tosRows.map((r) => ({
        type: 'tos' as const,
        id: r.id,
        acceptedAt: r.acceptedAt.toISOString(),
        acceptedIp: r.acceptedIp ?? null,
        tosVersion: r.tosVersion,
        tosBodyMarkdown: r.tosBodyMarkdown,
      })),
    }
  }

  /**
   * Returns a paginated, filtered audit event list for ACCOUNTANT / ADMIN.
   * Merges contract + tos events into a unified timeline sorted by date DESC.
   *
   * When `type` filter is set, only fetches from the matching table.
   */
  async getAllAudit(query: AuditAllQuery): Promise<AuditAllResponse> {
    const { userId, from, to, type, limit, offset } = query

    const fromDate = from ? new Date(from) : undefined
    const toDate = to ? new Date(to) : undefined

    const fetchContracts = !type || type === 'contract'
    const fetchTos = !type || type === 'tos'

    const [contractRows, tosRows] = await Promise.all([
      fetchContracts
        ? this.db.db
            .select({
              id: signedContracts.id,
              contractNumber: signedContracts.contractNumber,
              signedAt: signedContracts.signedAt,
              signedTypedName: signedContracts.signedTypedName,
              signedIp: signedContracts.signedIp,
              bodyMarkdownSnapshot: signedContracts.bodyMarkdownSnapshot,
              templateRole: contractTemplates.targetRole,
              templateVersion: contractTemplates.version,
            })
            .from(signedContracts)
            .innerJoin(contractTemplates, eq(contractTemplates.id, signedContracts.templateId))
            .where(
              and(
                userId ? eq(signedContracts.userId, userId) : undefined,
                fromDate ? gte(signedContracts.signedAt, fromDate) : undefined,
                toDate ? lte(signedContracts.signedAt, toDate) : undefined,
              ),
            )
            .orderBy(desc(signedContracts.signedAt))
        : Promise.resolve([]),

      fetchTos
        ? this.db.db
            .select({
              id: tosAcceptances.id,
              acceptedAt: tosAcceptances.acceptedAt,
              acceptedIp: tosAcceptances.acceptedIp,
              tosVersion: tosVersions.version,
              tosBodyMarkdown: tosVersions.bodyMarkdown,
            })
            .from(tosAcceptances)
            .innerJoin(tosVersions, eq(tosVersions.id, tosAcceptances.tosVersionId))
            .where(
              and(
                userId ? eq(tosAcceptances.userId, userId) : undefined,
                fromDate ? gte(tosAcceptances.acceptedAt, fromDate) : undefined,
                toDate ? lte(tosAcceptances.acceptedAt, toDate) : undefined,
              ),
            )
            .orderBy(desc(tosAcceptances.acceptedAt))
        : Promise.resolve([]),
    ])

    // Merge and sort by date DESC in memory (volumes are small — compliance data)
    const events: AuditEvent[] = [
      ...contractRows.map((r) => ({
        type: 'contract' as const,
        id: r.id,
        contractNumber: r.contractNumber,
        signedAt: r.signedAt.toISOString(),
        signedTypedName: r.signedTypedName,
        signedIp: r.signedIp ?? null,
        templateRole: r.templateRole as Extract<AuditEvent, { type: 'contract' }>['templateRole'],
        templateVersion: r.templateVersion,
        bodyMarkdownSnapshot: r.bodyMarkdownSnapshot,
      })),
      ...tosRows.map((r) => ({
        type: 'tos' as const,
        id: r.id,
        acceptedAt: r.acceptedAt.toISOString(),
        acceptedIp: r.acceptedIp ?? null,
        tosVersion: r.tosVersion,
        tosBodyMarkdown: r.tosBodyMarkdown,
      })),
    ].sort((a, b) => {
      const dateA = a.type === 'contract' ? a.signedAt : a.acceptedAt
      const dateB = b.type === 'contract' ? b.signedAt : b.acceptedAt
      return new Date(dateB).getTime() - new Date(dateA).getTime()
    })

    const total = events.length
    const items = events.slice(offset, offset + limit)

    return { items, total }
  }
}
