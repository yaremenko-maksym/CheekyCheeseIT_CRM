import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  createInterviewSchema,
  moveInterviewSchema,
  type SessionUser,
  updateInterviewSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { InterviewsService } from './interviews.service'

@Controller('interviews')
@UseGuards(JwtAuthGuard)
export class InterviewsController {
  constructor(private readonly interviewsService: InterviewsService) {}

  @Get()
  findBySenior(
    @Query('seniorId') seniorId: string | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    if (seniorId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seniorId)) {
      throw new BadRequestException('seniorId must be a valid UUID')
    }
    // For SENIOR role, service will override seniorId with currentUser.id
    return this.interviewsService.findBySenior(seniorId, user)
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = createInterviewSchema.parse(body)
    return this.interviewsService.create(data, user)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const data = updateInterviewSchema.parse(body)
    return this.interviewsService.update(id, data, user)
  }

  @Patch(':id/move')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const data = moveInterviewSchema.parse(body)
    return this.interviewsService.move(id, data, user)
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.interviewsService.remove(id, user)
  }
}
