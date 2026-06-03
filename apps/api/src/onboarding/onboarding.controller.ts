import { Controller, Get, UseGuards } from '@nestjs/common'
import { onboardingStatusSchema, type SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { OnboardingService } from './onboarding.service'

/**
 * `GET /api/onboarding/status` — single read endpoint used by the frontend
 * gate (`/crm/route.tsx`) + soft-notify banner. Lives in the OnboardingGuard
 * bypass list so that mid-onboarding users can read it.
 *
 * Response shape is `OnboardingStatusDto` from `@crm/shared`.
 */
@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  @Get('status')
  async status(@CurrentUser() user: SessionUser) {
    const status = await this.service.getStatus(user.id, user.role)
    // Parse to enforce contract at the wire boundary and to coerce Date → string.
    return onboardingStatusSchema.parse(status)
  }
}
