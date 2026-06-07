import { Controller, Get, Header, NotFoundException, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { Throttle } from '@nestjs/throttler'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import type { User } from '../database/schema'
import { ContractPdfService } from './contract-pdf.service'
import { safeContractFilename } from './contract-filename.util'
import { EmployeeContractsService } from './employee-contracts.service'
import { SignedContractsService } from './signed-contracts.service'

/**
 * A3-1 — Self-service onboarding contract endpoints.
 *
 * These endpoints are bypass-listed in OnboardingGuard so un-onboarded users
 * can view their contract before signing it.
 *
 * RBAC: any authenticated non-ADMIN user (self-access only).
 *
 * Controller prefix `onboarding` (global prefix `api` set in main.ts) — real paths:
 *   GET /api/onboarding/contract       — return own READY_TO_SIGN contract
 *   GET /api/onboarding/contract/pdf   — render READY_TO_SIGN contract as PDF
 *
 * Note: signing itself remains at POST /api/contracts/sign (unchanged, A1).
 */
@Controller('onboarding')
export class OnboardingContractController {
  constructor(
    private readonly service: EmployeeContractsService,
    private readonly contractPdf: ContractPdfService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * GET /api/onboarding/contract
   * Returns the caller's READY_TO_SIGN employee_contract.
   * 409 CONTRACT_NOT_READY if none is in READY_TO_SIGN state.
   */
  @Get('contract')
  async getForSigning(@CurrentUser() user: SessionUser) {
    return this.service.getReadyForSigning(user.id)
  }

  /**
   * GET /api/onboarding/contract/pdf
   * Renders the caller's READY_TO_SIGN employee_contract as an unsigned PDF
   * preview (signature block shows "Требуется подпись участника").
   *
   * Throttle: 5 req/min (PDF generation is expensive).
   * Returns: application/pdf stream.
   */
  @Get('contract/pdf')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async getOwnPdf(@CurrentUser() user: SessionUser, @Res() reply: FastifyReply): Promise<void> {
    const contract = await this.service.getReadyForSigning(user.id)

    const userRow = (await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, user.id),
    })) as User | undefined
    if (!userRow) throw new NotFoundException('User not found')

    const { body } = SignedContractsService.interpolateVariables(
      contract.bodyMarkdown,
      userRow,
      new Date(),
    )

    const { pdfBuffer } = await this.contractPdf.generateContractPdf({
      contractNumber: '',
      bodyMarkdown: body,
      signedTypedName: '',
      signedAt: null,
      verifyUrl: '',
    })

    const { contentDisposition } = safeContractFilename(userRow.displayName, 'READY_TO_SIGN')

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', contentDisposition)
      .send(pdfBuffer)
  }
}
