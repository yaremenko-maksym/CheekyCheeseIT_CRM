import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

import { createTosVersionSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { TosService } from './tos.service'

/**
 * Terms of Service endpoints.
 *
 * | Endpoint                  | Allowed roles  | OnboardingGuard bypass |
 * | ------------------------- | -------------- | ---------------------- |
 * | GET    /api/tos/current   | any authn'd    | YES                    |
 * | GET    /api/tos/versions  | ADMIN          | NO                     |
 * | POST   /api/tos           | ADMIN          | NO                     |
 * | POST   /api/tos/accept    | any authn'd    | YES                    |
 *
 * `current` and `accept` are in the bypass list because mid-onboarding users
 * need them to fulfill the gate.
 */
// JwtAuthGuard runs globally (AppModule APP_GUARD); RolesGuard stays
// controller-level because it depends on `req.user.role` populated by the
// global guard.
@Controller('tos')
@UseGuards(RolesGuard)
export class TosController {
  constructor(private readonly service: TosService) {}

  @Get('current')
  current() {
    return this.service.getCurrent()
  }

  @Get('versions')
  @Roles('ADMIN')
  list() {
    return this.service.listAll()
  }

  @Post()
  @Roles('ADMIN')
  publish(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const { bodyMarkdown } = createTosVersionSchema.parse(body)
    return this.service.publish({ bodyMarkdown, createdByUserId: user.id })
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: SessionUser, @Req() request: FastifyRequest) {
    const ip = (request.ip as string | undefined) ?? null
    const userAgent = (request.headers['user-agent'] as string | undefined)?.slice(0, 1000) ?? null
    return this.service.accept({ userId: user.id, ip, userAgent })
  }
}
