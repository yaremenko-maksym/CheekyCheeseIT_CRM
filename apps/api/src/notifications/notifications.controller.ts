/**
 * NotificationsController — HTTP surface for in-app notifications.
 *
 * Endpoints (all prefixed `/api/notifications`):
 *   GET   /                  list current user (filters: unreadOnly, limit)
 *   PATCH /:id/read          mark single notification read
 *   PATCH /read-all          mark every unread notification read
 *
 * All routes require auth (JwtAuthGuard) — there is no public notifications
 * surface. The service-level RBAC is implicit: every endpoint scopes its
 * query to `req.user.id`, so a user can only ever see / mutate their own
 * rows (the row-level ownership check on `markRead` is defense-in-depth).
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common'
import { notificationListFiltersSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { NotificationsService } from './notifications.service'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  // ---------------------------------------------------------------------------
  // GET /api/notifications
  // ---------------------------------------------------------------------------

  @Get()
  list(
    @CurrentUser() user: SessionUser,
    @Query('unreadOnly') unreadOnly: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    // Query strings arrive as strings; coerce before Zod parse so the
    // defaults (unreadOnly=false, limit=10) kick in correctly.
    const filters = notificationListFiltersSchema.parse({
      unreadOnly: unreadOnly === 'true',
      limit: limit ? Number(limit) : undefined,
    })
    return this.svc.listForUser(user.id, filters)
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/notifications/read-all  (must come before :id/read to avoid
  //                                     ParseUUIDPipe matching "read-all")
  // ---------------------------------------------------------------------------

  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: SessionUser): Promise<void> {
    await this.svc.markAllRead(user.id)
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/notifications/:id/read
  // ---------------------------------------------------------------------------

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.svc.markRead(user.id, id)
  }
}
