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
  UseGuards,
} from '@nestjs/common'
import {
  createInterviewSchema,
  hrSummarySchema,
  moveInterviewSchema,
  type SessionUser,
  updateInterviewSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { InterviewsService } from './interviews.service'

/**
 * Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
 *
 * RBAC (HR-2 hardening): the interviews module is restricted to the roles the
 * business spec allows (docs/business/modules/interviews.md → "Доступ к доскам:
 * ADMIN/HR see boards, SENIOR sees own"). `@Roles` + `RolesGuard` is a
 * defense-in-depth role-set gate that runs BEFORE the handler:
 *   - findBySenior / create / update / move → ADMIN, SENIOR, HR
 *   - remove                                → ADMIN, HR (SENIOR cannot delete)
 * It does NOT replace the per-endpoint team-scope logic in InterviewsService
 * (HR own-team only, SENIOR own-board only, IDOR guards) — that stays in the
 * service. The guard closes a previously-uncovered gap where ACCOUNTANT could
 * read any board via GET /interviews?seniorId=<uuid> (front-only gating; the
 * sidebar hid the link but the API let ACCOUNTANT/JUNIOR through with a valid
 * seniorId). `assertNotDrop` is kept as a second, message-specific DROP barrier
 * even though the guard already rejects DROP — see its docblock.
 *
 * Coverage: apps/api/src/interviews/interviews-rbac.integration.spec.ts pins
 * every cell of this matrix against a real database.
 */
@UseGuards(RolesGuard)
@Controller('interviews')
export class InterviewsController {
  constructor(private readonly interviewsService: InterviewsService) {}

  /**
   * Drop role - phase 1 (AC2, security): DROP must not have any access to
   * the interviews module — sidebar hides the link, route guard redirects,
   * and the API rejects every endpoint at the controller boundary with 403.
   * Defense-in-depth: even if a future refactor wires the route back into
   * the DROP sidebar, the backend still rejects the request.
   *
   * NOTE: the class-level @Roles set excludes DROP, so RolesGuard already
   * rejects DROP before this runs. This assertion stays as a redundant,
   * message-specific barrier (and guards against a future @Roles widening).
   */
  private assertNotDrop(user: SessionUser): void {
    if (user.role === 'DROP') {
      throw new ForbiddenException('Дроп не имеет доступа к собеседованиям')
    }
  }

  /**
   * HR dashboard / HR-хаб KPI snapshot. GET /api/interviews/hr-summary — HR +
   * ADMIN ONLY (the @Roles set + the service's own role check both reject every
   * other role with 403 BEFORE any DB access). Declared BEFORE the param routes
   * (`:id`) so the literal `hr-summary` segment is never swallowed by a
   * param-matcher — although the only param routes here are @Patch/@Delete, the
   * explicit ordering keeps it unambiguous.
   *
   * Returns `hrSummarySchema` shape ({ openInterviews, hiredThisMonth,
   * activeProjects }), parsed at the wire boundary.
   */
  @Get('hr-summary')
  @Roles('ADMIN', 'HR')
  async hrSummary(@CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    const summary = await this.interviewsService.getHrSummary(user)
    return hrSummarySchema.parse(summary)
  }

  @Get()
  @Roles('ADMIN', 'SENIOR', 'HR')
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
  @Roles('ADMIN', 'SENIOR', 'HR')
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    const data = createInterviewSchema.parse(body)
    return this.interviewsService.create(data, user)
  }

  @Patch(':id')
  @Roles('ADMIN', 'SENIOR', 'HR')
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
  @Roles('ADMIN', 'SENIOR', 'HR')
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
  @Roles('ADMIN', 'HR')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    return this.interviewsService.remove(id, user)
  }
}
