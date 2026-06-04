import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { auditAllQuerySchema } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import type { SessionUser } from '@crm/shared'
import { AuditService } from './audit.service'

/**
 * Phase 6 polish PR3 — compliance audit trail endpoints.
 *
 * RBAC:
 *   GET /api/me/audit-trail  — any authenticated user (self data only)
 *   GET /api/audit/all       — ACCOUNTANT + ADMIN only, with filters + pagination
 *
 * Auth enforced by global JwtAuthGuard (AppModule APP_GUARD).
 *
 * IP addresses in responses are sensitive — both endpoints require JWT.
 * Rate limits are intentionally lenient: audit-trail exports are occasional
 * compliance actions, not high-frequency polling.
 */
@Controller()
export class AuditController {
  constructor(private readonly service: AuditService) {}

  /**
   * Self-service compliance export: returns caller's own signed contracts
   * and ToS acceptances for personal records / GDPR data portability.
   * Capped at last 50 records per type.
   */
  @Get('me/audit-trail')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async getMyAuditTrail(@CurrentUser() user: SessionUser) {
    return this.service.getUserAudit(user.id)
  }

  /**
   * Admin / accountant view of all compliance events across all users.
   * Supports filters: userId, from, to, type (contract|tos).
   * Paginated: limit (default 50, max 200) + offset.
   */
  @Get('audit/all')
  @UseGuards(RolesGuard)
  @Roles('ACCOUNTANT', 'ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async getAllAudit(@Query() rawQuery: unknown) {
    const query = auditAllQuerySchema.parse(rawQuery)
    return this.service.getAllAudit(query)
  }
}
