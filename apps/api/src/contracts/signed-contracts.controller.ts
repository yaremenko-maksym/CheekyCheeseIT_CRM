import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

import { signContractSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { SignedContractsService } from './signed-contracts.service'

/**
 * Sign / read signed-contracts endpoints.
 *
 * RBAC:
 *   POST /api/contracts/sign       — any authenticated non-ADMIN
 *   GET  /api/contracts/me         — caller's own signed contracts
 *   GET  /api/contracts/:id        — ADMIN | ACCOUNTANT | owner
 *
 * `/sign` lives in the OnboardingGuard bypass list so users mid-onboarding
 * can submit it (they have no signed contract yet by definition).
 *
 * IP / UA captured server-side from the Fastify request (`req.ip` +
 * `req.headers['user-agent']`), never trusted from client body.
 */
@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class SignedContractsController {
  constructor(private readonly service: SignedContractsService) {}

  @Post('sign')
  sign(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() request: FastifyRequest) {
    const { typedName } = signContractSchema.parse(body)
    const ip = (request.ip as string | undefined) ?? null
    const userAgent = (request.headers['user-agent'] as string | undefined)?.slice(0, 1000) ?? null

    return this.service.sign({
      userId: user.id,
      userRole: user.role,
      typedName,
      ip,
      userAgent,
    })
  }

  @Get('me')
  findMine(@CurrentUser() user: SessionUser) {
    return this.service.findMine(user.id)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.service.findById(id, user)
  }
}
