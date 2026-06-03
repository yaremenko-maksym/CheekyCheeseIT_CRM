import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { ContractTemplatesController } from './contract-templates.controller'
import { ContractTemplatesService } from './contract-templates.service'
import { SignedContractsController } from './signed-contracts.controller'
import { SignedContractsService } from './signed-contracts.service'

/**
 * Onboarding Phase 6A — bundles MSA template management + sign mechanism.
 *
 * Services are exported so OnboardingModule can resolve user's MSA status
 * (sign requirement) without importing this module's controllers.
 */
@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule)],
  controllers: [ContractTemplatesController, SignedContractsController],
  providers: [ContractTemplatesService, SignedContractsService],
  exports: [ContractTemplatesService, SignedContractsService],
})
export class ContractsModule {}
