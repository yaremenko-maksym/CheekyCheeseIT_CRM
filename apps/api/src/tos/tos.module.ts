import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { PdfModule } from '../common/pdf/pdf.module'
import { TosController } from './tos.controller'
import { TosService } from './tos.service'
import { TosPdfService } from './tos-pdf.service'

/**
 * Onboarding Phase 6A — ToS module.
 *
 * Exports `TosService` so `OnboardingModule` can resolve user's acceptance
 * status without importing this module's controller.
 *
 * Imports `PdfModule` to provide `PdfGenerationService` for `TosPdfService`.
 */
@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule), PdfModule],
  controllers: [TosController],
  providers: [TosService, TosPdfService],
  exports: [TosService],
})
export class TosModule {}
