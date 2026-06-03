import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { TosController } from './tos.controller'
import { TosService } from './tos.service'

/**
 * Onboarding Phase 6A — ToS module.
 *
 * Exports `TosService` so `OnboardingModule` can resolve user's acceptance
 * status without importing this module's controller.
 */
@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule)],
  controllers: [TosController],
  providers: [TosService],
  exports: [TosService],
})
export class TosModule {}
