import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { PdfModule } from '../common/pdf/pdf.module'
import { ContractTemplatesController } from './contract-templates.controller'
import { ContractTemplatesService } from './contract-templates.service'
import { EmployeeContractsController } from './employee-contracts.controller'
import { EmployeeContractsService } from './employee-contracts.service'
import { OnboardingContractController } from './onboarding-contract.controller'
import { SignedContractsController } from './signed-contracts.controller'
import { SignedContractsService } from './signed-contracts.service'
import { ContractPdfService } from './contract-pdf.service'

/**
 * Onboarding Phase 6A — bundles MSA template management + sign mechanism.
 * A3-1 — adds per-employee contract lifecycle (EmployeeContractsService).
 *
 * Services are exported so OnboardingModule can resolve user's MSA status
 * (sign requirement + contractReady check) without importing controllers.
 */
@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule), PdfModule],
  controllers: [
    ContractTemplatesController,
    SignedContractsController,
    EmployeeContractsController,
    OnboardingContractController,
  ],
  providers: [
    ContractTemplatesService,
    SignedContractsService,
    ContractPdfService,
    EmployeeContractsService,
  ],
  exports: [ContractTemplatesService, SignedContractsService, EmployeeContractsService],
})
export class ContractsModule {}
