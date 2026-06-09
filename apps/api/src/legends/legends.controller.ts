import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common'
import { upsertLegendSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { LegendsService } from './legends.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD) — authentication is covered.
// RBAC for this controller is handled entirely inside LegendsService (canViewLegend /
// canEdit checks). Adding @UseGuards(RolesGuard) without a matching @Roles() decorator
// would be a no-op guard that misleads readers into thinking role-filtering happens here.
@Controller('users/:id/legend')
export class LegendsController {
  constructor(private readonly legendsService: LegendsService) {}

  /**
   * GET /api/users/:id/legend
   *
   * Returns the legend for a SENIOR user.
   * 400 if target is not SENIOR.
   * 403 if viewer is not allowed.
   * 404 if legend not yet created.
   */
  @Get()
  getLegend(@CurrentUser() currentUser: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.legendsService.getLegend(currentUser, id)
  }

  /**
   * PUT /api/users/:id/legend
   *
   * Upsert the legend for a SENIOR user.
   * Only the SENIOR themselves or ADMIN can write.
   * 400 if target is not SENIOR.
   * 403 if viewer cannot edit.
   */
  @Put()
  upsertLegend(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = upsertLegendSchema.parse(body)
    return this.legendsService.upsertLegend(currentUser, id, dto)
  }
}
