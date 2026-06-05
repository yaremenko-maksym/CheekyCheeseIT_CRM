import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { Throttle } from '@nestjs/throttler'
import type { SessionUser } from '@crm/shared'
import { updateEmployeeContractSchema } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import type { User } from '../database/schema'
import { ContractPdfService } from './contract-pdf.service'
import { safeContractFilename } from './contract-filename.util'
import { EmployeeContractsService } from './employee-contracts.service'
import { SignedContractsService } from './signed-contracts.service'

/**
 * A3-1 — ADMIN management of per-employee contracts.
 *
 * All endpoints require ADMIN role (enforced by @Roles + RolesGuard).
 * Controller prefix `api/users` — endpoints are scoped to a user:
 *
 *   GET    /api/users/:id/contract       — lazy-create or get active contract
 *   PATCH  /api/users/:id/contract       — update body markdown (DRAFT | READY_TO_SIGN)
 *   POST   /api/users/:id/contract/ready — DRAFT → READY_TO_SIGN
 *   POST   /api/users/:id/contract/revert — READY_TO_SIGN | SIGNED → DRAFT
 *   POST   /api/users/:id/contract/reset  — re-derive body from active template (DRAFT only)
 *   GET    /api/users/:id/contract/pdf   — render PDF from employee_contract
 */
@Controller('api/users')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class EmployeeContractsController {
  constructor(
    private readonly service: EmployeeContractsService,
    private readonly contractPdf: ContractPdfService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * GET /api/users/:id/contract
   * Lazy-create a DRAFT employee_contract if none exists, or return the active one.
   */
  @Get(':id/contract')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
    return this.service.getOrCreateForUser(id, viewer)
  }

  /**
   * PATCH /api/users/:id/contract
   * Update the body markdown. Only allowed in DRAFT (MED#2).
   * To edit in READY_TO_SIGN: first POST /revert, then PATCH.
   */
  @Patch(':id/contract')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() viewer: SessionUser,
  ) {
    const { bodyMarkdown } = updateEmployeeContractSchema.parse(body)
    return this.service.updateBody(id, bodyMarkdown, viewer)
  }

  /**
   * POST /api/users/:id/contract/ready
   * Transition DRAFT → READY_TO_SIGN.
   */
  @Post(':id/contract/ready')
  async markReady(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
    return this.service.markReady(id, viewer)
  }

  /**
   * POST /api/users/:id/contract/revert
   * Revert READY_TO_SIGN | SIGNED → DRAFT.
   * If reverting from SIGNED: also deletes tos_acceptances (forces re-onboarding).
   */
  @Post(':id/contract/revert')
  async revert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
    return this.service.revert(id, viewer)
  }

  /**
   * POST /api/users/:id/contract/reset
   * Re-derive body from the currently active template. DRAFT only.
   */
  @Post(':id/contract/reset')
  async reset(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
    return this.service.resetToTemplate(id, viewer)
  }

  /**
   * GET /api/users/:id/contract/pdf
   * Render the employee_contract as a PDF.
   * - If status=SIGNED: fetches signed_contract for real signedTypedName/date/IP/QR.
   * - Otherwise: renders unsigned preview (signedTypedName='').
   *
   * Throttle: 5 req/min (PDF generation is expensive).
   */
  @Get(':id/contract/pdf')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async getPdf(@Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply): Promise<void> {
    const contract = await this.service.getActiveForUser(id)

    const userRow = (await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, id),
    })) as User | undefined
    if (!userRow) throw new NotFoundException('User not found')

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'

    let pdfParams: Parameters<typeof this.contractPdf.generateContractPdf>[0]

    if (contract.status === 'SIGNED' && contract.signedContractId) {
      // Fetch signed_contract for real signature data
      const signed = await this.db.db.query.signedContracts.findFirst({
        where: (tbl, { eq }) => eq(tbl.id, contract.signedContractId!),
      })
      if (!signed) throw new NotFoundException('Signed contract record not found')

      const { body } = SignedContractsService.interpolateVariables(
        contract.bodyMarkdown,
        userRow,
        new Date(signed.signedAt),
      )

      pdfParams = {
        contractNumber: signed.contractNumber ?? '',
        bodyMarkdown: body,
        signedTypedName: signed.signedTypedName ?? '',
        signedAt: new Date(signed.signedAt),
        signedIpLastOctet: signed.signedIp ? (signed.signedIp.split('.').pop() ?? null) : null,
        verifyUrl: `${frontendUrl}/contract/v/${signed.id}`,
      }
    } else {
      // DRAFT or READY_TO_SIGN — unsigned preview
      const { body } = SignedContractsService.interpolateVariables(
        contract.bodyMarkdown,
        userRow,
        new Date(),
      )

      pdfParams = {
        contractNumber: '',
        bodyMarkdown: body,
        signedTypedName: '',
        signedAt: null,
        signedIpLastOctet: null,
        verifyUrl: '',
      }
    }

    const { pdfBuffer } = await this.contractPdf.generateContractPdf(pdfParams)

    const { contentDisposition } = safeContractFilename(userRow.displayName, contract.status)

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', contentDisposition)
      .send(pdfBuffer)
  }
}
