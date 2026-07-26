import { Injectable, Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { CspDisposition } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { cspReports } from '../database/schema'
import { sanitizeNullable, sanitizeText } from '../telemetry/sanitize'
import { normalizeBlockedUri, normalizeDocumentPath, resolveDirective } from './normalize'

/** Truncation cap for the stored User-Agent header — mirrors telemetry's `meta.ua` cap (500) but tighter (300). */
export const USER_AGENT_MAX_LENGTH = 300

export interface RecordCspViolationInput {
  effectiveDirective?: string | undefined
  violatedDirective?: string | undefined
  blockedUri?: string | undefined
  documentUri?: string | undefined
  disposition?: CspDisposition | undefined
  userAgent?: string | null | undefined
}

/**
 * CspReportsService — task-csp-reports-and-flip §Часть A. The ONE place that
 * writes to `csp_reports`. Storage is AGGREGATED, not a raw event stream
 * (task §3: "недоверенный публичный ввод — хранение агрегированное") — every
 * write is an upsert keyed on (effectiveDirective, blockedUri, documentPath):
 * a repeat bumps count/lastSeen instead of inserting a new row.
 *
 * Sanitization (secret-pattern redaction, reused from telemetry/sanitize.ts —
 * "те же паттерны, что в telemetry") happens BEFORE normalization, same order
 * as TelemetryErrorsService.recordError, so a secret straddling a later
 * truncation boundary is still caught.
 */
@Injectable()
export class CspReportsService {
  private readonly logger = new Logger(CspReportsService.name)

  constructor(private readonly db: DatabaseService) {}

  async recordViolation(input: RecordCspViolationInput): Promise<void> {
    const directive = resolveDirective(input.effectiveDirective, input.violatedDirective)
    if (!directive) {
      this.logger.debug(
        'csp report dropped — no usable directive (effective-directive AND violated-directive both empty)',
      )
      return
    }

    const blockedUri = normalizeBlockedUri(sanitizeNullable(input.blockedUri))
    const documentPath = normalizeDocumentPath(sanitizeNullable(input.documentUri))
    const disposition: CspDisposition = input.disposition ?? 'report'
    const userAgent = input.userAgent
      ? sanitizeText(input.userAgent).slice(0, USER_AGENT_MAX_LENGTH)
      : null
    const now = new Date()

    await this.db.db
      .insert(cspReports)
      .values({
        effectiveDirective: directive,
        blockedUri,
        documentPath,
        disposition,
        userAgent,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [cspReports.effectiveDirective, cspReports.blockedUri, cspReports.documentPath],
        set: {
          count: sql`${cspReports.count} + 1`,
          lastSeen: now,
          disposition,
          userAgent,
        },
      })

    this.logger.debug(`csp report recorded (directive=${directive})`)
  }
}
