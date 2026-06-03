import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ContractsModule } from '../contracts/contracts.module'
import { DatabaseModule } from '../database/database.module'
import { TosModule } from '../tos/tos.module'
import { OnboardingController } from './onboarding.controller'
import { OnboardingService } from './onboarding.service'

/**
 * Phase 6A — composes `ContractTemplatesService` + `TosService` into a
 * single `OnboardingService` and exposes `GET /api/onboarding/status`.
 *
 * Service is exported so `OnboardingGuard` (registered globally via
 * APP_GUARD in AppModule) can call `getStatus` to enforce the gate.
 */
@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AuthModule),
    forwardRef(() => ContractsModule),
    forwardRef(() => TosModule),
  ],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
