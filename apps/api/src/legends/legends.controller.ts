import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common'
import { upsertLegendSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { LegendsService } from './legends.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD).
// RolesGuard is controller-level (needs req.user.role).
@Controller('users/:id/legend')
@UseGuards(RolesGuard)
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
