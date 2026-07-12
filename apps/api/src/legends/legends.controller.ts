import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common'
import { addLegendEntrySchema, upsertLegendSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { LegendsService } from './legends.service'

// JwtAuthGuard runs globally (AppModule APP_GUARD) — authentication is covered.
// RBAC for this controller is handled entirely inside LegendsService (canAccess
// checks). Adding @UseGuards(RolesGuard) without a matching @Roles() decorator
// would be a no-op guard that misleads readers into thinking role-filtering
// happens here. Legend access is relationship-based (project membership), not
// flat role-based.

@Controller('projects')
export class LegendsController {
  constructor(private readonly legendsService: LegendsService) {}

  /**
   * GET /api/projects/:projectId/legend
   *
   * Returns the legend for a project, or null if no legend exists yet.
   * 403 if viewer lacks access (subject excluded; ACCOUNTANT etc).
   * 404 if project not found.
   * 200 with null body if project is accessible but legend not yet created.
   */
  @Get(':projectId/legend')
  getLegend(
    @CurrentUser() currentUser: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.legendsService.getLegend(currentUser, projectId)
  }

  /**
   * PUT /api/projects/:projectId/legend
   *
   * Upsert (create or update) the legend for a project.
   * Edit access == view access (canAccess check in service).
   * Subject (seniorId / dropId) is explicitly excluded.
   * 403 if viewer lacks access; 404 if project not found.
   */
  @Put(':projectId/legend')
  upsertLegend(
    @CurrentUser() currentUser: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ) {
    const dto = upsertLegendSchema.parse(body)
    return this.legendsService.upsertLegend(currentUser, projectId, dto)
  }

  /**
   * POST /api/projects/:projectId/legend/entries
   *
   * Add a journal entry to the project legend.
   * 403 if viewer lacks access; 404 if project/legend not found.
   * Returns updated Legend (with all entries).
   */
  @Post(':projectId/legend/entries')
  addEntry(
    @CurrentUser() currentUser: SessionUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: unknown,
  ) {
    const dto = addLegendEntrySchema.parse(body)
    return this.legendsService.addEntry(currentUser, projectId, dto)
  }
}
