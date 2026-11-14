import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { SeniorAvailabilityService } from './senior-availability.service'

/**
 * GET / PUT `/users/:id/availability` (vacancy-queue design §5.2). `@Roles` is the coarse first
 * layer; the viewer → target rule (self SENIOR or ADMIN) lives in the service, which re-reads the
 * viewer, so a stale token role cannot pass it.
 */
@Controller('users')
@UseGuards(RolesGuard)
export class SeniorAvailabilityController {
  constructor(private readonly availability: SeniorAvailabilityService) {}

  @Get(':id/availability')
  @Roles('ADMIN', 'SENIOR')
  get(@CurrentUser() currentUser: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.availability.get(currentUser.id, id)
  }

  @Put(':id/availability')
  @Roles('ADMIN', 'SENIOR')
  set(
    @CurrentUser() currentUser: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.availability.set(currentUser.id, id, body)
  }
}
