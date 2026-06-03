import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import {
  createInterviewSchema,
  moveInterviewSchema,
  type SessionUser,
  updateInterviewSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { InterviewsService } from './interviews.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
@Controller('interviews')
export class InterviewsController {
  constructor(private readonly interviewsService: InterviewsService) {}

  /**
   * Drop role - phase 1 (AC2, security): DROP must not have any access to
   * the interviews module — sidebar hides the link, route guard redirects,
   * and the API rejects every endpoint at the controller boundary with 403.
   * Defense-in-depth: even if a future refactor wires the route back into
   * the DROP sidebar, the backend still rejects the request.
   */
  private assertNotDrop(user: SessionUser): void {
    if (user.role === 'DROP') {
      throw new ForbiddenException('Дроп не имеет доступа к собеседованиям')
    }
  }

  @Get()
  findBySenior(@Query('seniorId') seniorId: string | undefined, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    if (
      seniorId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seniorId)
    ) {
      throw new BadRequestException('seniorId must be a valid UUID')
    }
    // For SENIOR role, service will override seniorId with currentUser.id
    return this.interviewsService.findBySenior(seniorId, user)
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    const data = createInterviewSchema.parse(body)
    return this.interviewsService.create(data, user)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertNotDrop(user)
    const data = updateInterviewSchema.parse(body)
    return this.interviewsService.update(id, data, user)
  }

  @Patch(':id/move')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertNotDrop(user)
    const data = moveInterviewSchema.parse(body)
    return this.interviewsService.move(id, data, user)
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    return this.interviewsService.remove(id, user)
  }
}
