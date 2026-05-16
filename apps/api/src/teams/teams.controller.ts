import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'

import {
  addTeamMemberSchema,
  createTeamSchema,
  type SessionUser,
  updateTeamSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { TeamsService } from './teams.service'

@Controller('teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { name, seniorId, hrIds, accountantId } = createTeamSchema.parse(body)
    return this.teamsService.create(name, seniorId, hrIds, accountantId, user)
  }

  @Get()
  findAll(@CurrentUser() user: SessionUser) {
    return this.teamsService.findAll(user)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.findOne(id, user)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { name } = updateTeamSchema.parse(body)
    return this.teamsService.update(id, name, user)
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.teamsService.remove(id, user)
  }

  @Post(':id/members')
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { userId } = addTeamMemberSchema.parse(body)
    return this.teamsService.addMember(id, userId, user)
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.teamsService.removeMember(id, userId, user)
  }
}
