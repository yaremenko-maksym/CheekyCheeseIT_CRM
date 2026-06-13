import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { updateCredentialSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { CredentialsService } from './credentials.service'

/**
 * task-junior-ut-round2 §6 — user-scoped credentials surface.
 *
 * Lets ADMIN / HR (who shares an active team with the SENIOR of the target's
 * project) see + edit + reveal a JUNIOR's project credentials from that JUNIOR's
 * profile. This is a DIFFERENT relationship from the project-page routes:
 *   project page: viewer = project member (junior/hr/admin), keyed by projectId
 *   profile page: viewer = ADMIN/HR, target = a specific JUNIOR, keyed by userId
 *
 * SECURITY:
 *   - RBAC enforced inside CredentialsService.{listForUser,revealForUser,updateForUser}.
 *   - JwtAuthGuard runs globally — authentication covered.
 *   - List/update never expose plaintext; only :id/reveal does (throttled + no-store).
 *   - JUNIOR (incl. self), SENIOR, ACCOUNTANT, DROP, unrelated HR → 403.
 */
@Controller('users')
export class UserCredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** GET /api/users/:userId/credentials — list (NO password / ciphertext). */
  @Get(':userId/credentials')
  list(@CurrentUser() user: SessionUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.credentials.listForUser(user, userId)
  }

  /** PATCH /api/users/:userId/credentials/:id — edit (ADMIN/HR). */
  @Patch(':userId/credentials/:id')
  update(
    @CurrentUser() user: SessionUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = updateCredentialSchema.parse(body)
    return this.credentials.updateForUser(user, userId, id, dto)
  }

  /**
   * GET /api/users/:userId/credentials/:id/reveal
   * The ONLY plaintext path for this surface. Throttled (30/min) + no-store.
   */
  @Get(':userId/credentials/:id/reveal')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reveal(
    @CurrentUser() user: SessionUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credentials.revealForUser(user, userId, id)
  }
}
