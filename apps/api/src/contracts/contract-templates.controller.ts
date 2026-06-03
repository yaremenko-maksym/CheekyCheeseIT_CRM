import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { ContractTemplatesService } from './contract-templates.service'

/**
 * RBAC summary (Phase 6A):
 *
 * | Endpoint                                  | Allowed roles                |
 * | ----------------------------------------- | ---------------------------- |
 * | GET    /api/contracts/templates           | ADMIN                        |
 * | GET    /api/contracts/templates/current/:role | ADMIN or self (role match)  |
 * | POST   /api/contracts/templates           | ADMIN                        |
 * | GET    /api/contracts/templates/:id       | ADMIN                        |
 *
 * `current/:role` is the only endpoint reachable through the OnboardingGuard
 * bypass list — non-ADMIN callers MUST request their OWN role and nothing
 * else.
 */
// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard stays
// controller-level because it depends on `req.user.role`.
@Controller('contracts/templates')
@UseGuards(RolesGuard)
export class ContractTemplatesController {
  constructor(private readonly service: ContractTemplatesService) {}

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

  @Post()
  @Roles('ADMIN')
  publish(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { targetRole, bodyMarkdown } = createContractTemplateSchema.parse(body)
    return this.service.publish({ targetRole, bodyMarkdown, createdByUserId: user.id })
  }

  @Get(':id')
  @Roles('ADMIN')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id)
  }
}
