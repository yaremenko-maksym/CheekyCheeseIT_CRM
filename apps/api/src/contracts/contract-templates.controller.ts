import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  contractTargetRoleSchema,
  createContractTemplateSchema,
  type ContractTargetRole,
  type SessionUser,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AdminWriteThrottle } from '../config/throttle-decorators'
import { DatabaseService } from '../database/database.service'
import { ContractTemplatesService } from './contract-templates.service'
import { renderContractTemplate } from './contract-rendering'

/**
 * RBAC summary (Phase 6A):
 *
 * | Endpoint                                        | Allowed roles / guard        |
 * | ----------------------------------------------- | ---------------------------- |
 * | GET    /api/contracts/templates                 | ADMIN                        |
 * | GET    /api/contracts/templates/current/:role   | ADMIN or self (role match)   |
 * | POST   /api/contracts/templates                 | ADMIN                        |
 * | GET    /api/contracts/templates/preview-rendered/:id | any authenticated user  |
 * | GET    /api/contracts/templates/:id             | ADMIN                        |
 *
 * `current/:role` and `preview-rendered/:id` are both reachable through the
 * OnboardingGuard bypass list so pre-onboarding users can see the wizard and
 * the personalised preview before signing. `preview-rendered` resolves user
 * data from `req.user.id` (JWT) — no IDOR surface.
 */
// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard stays
// controller-level because it depends on `req.user.role`.
@Controller('contracts/templates')
@UseGuards(RolesGuard)
export class ContractTemplatesController {
  constructor(
    private readonly service: ContractTemplatesService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  @Roles('ADMIN')
  list() {
    return this.service.listAll()
  }

  @Get('current/:role')
  async current(@Param('role') role: string, @CurrentUser() user: SessionUser) {
    const parsed = contractTargetRoleSchema.safeParse(role)
    if (!parsed.success) {
      throw new BadRequestException('Invalid role')
    }
    const targetRole = parsed.data as ContractTargetRole

    // Non-ADMIN callers can only fetch their OWN role's template.
    if (user.role !== 'ADMIN' && user.role !== targetRole) {
      throw new ForbiddenException()
    }

    return this.service.getCurrentForRole(targetRole)
  }

  // Publishing a new template version is a sensitive write — limit to
  // 5 requests per minute per IP to prevent abuse.
  // Raised to global limit in non-prod when THROTTLE_RELAXED=true.
  @Post()
  @Roles('ADMIN')
  @AdminWriteThrottle()
  publish(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { targetRole, bodyMarkdown, customVariables } = createContractTemplateSchema.parse(body)
    return this.service.publish({
      targetRole,
      bodyMarkdown,
      customVariables,
      createdByUserId: user.id,
    })
  }

  /**
   * `GET /api/contracts/templates/preview-rendered/:templateId`
   *
   * Returns the template body with all `{{placeholder}}` tokens substituted
   * using the calling user's current profile data. This lets the onboarding
   * wizard show a personalised preview before the user signs.
   *
   * Auth: any authenticated user (no role restriction). ADMIN will always see
   * `onboardingDate = today` with their own profile data — they bypass the
   * gate anyway so this endpoint is for non-ADMIN previewing their own MSA.
   *
   * No throttle: read-only, cheap query, no side-effects.
   */
  @Get('preview-rendered/:templateId')
  async previewRendered(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: SessionUser,
  ): Promise<{ bodyMarkdown: string }> {
    const template = await this.service.getById(templateId)
    if (!template) {
      throw new NotFoundException('Contract template not found')
    }

    const userRow = await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, user.id),
    })
    if (!userRow) {
      throw new NotFoundException('User not found')
    }

    const { body } = renderContractTemplate(template.bodyMarkdown, userRow, new Date())
    return { bodyMarkdown: body }
  }

  @Get(':id')
  @Roles('ADMIN')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id)
  }
}
