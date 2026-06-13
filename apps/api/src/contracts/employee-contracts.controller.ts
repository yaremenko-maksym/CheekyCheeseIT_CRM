import {
  Body,
  Controller,
  ForbiddenException,
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
import { updateCustomValuesSchema, updateEmployeeContractSchema } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import type { User } from '../database/schema'
import { ContractPdfService } from './contract-pdf.service'
import { safeContractFilename } from './contract-filename.util'
import { renderContractTemplate } from './contract-rendering'
import { EmployeeContractsService } from './employee-contracts.service'
import { SignedContractsService } from './signed-contracts.service'

/**
 * A3-1 — ADMIN management of per-employee contracts.
 *
 * All endpoints require ADMIN role (enforced by @Roles + RolesGuard).
 * Controller prefix `users` (global prefix `api` set in main.ts) — real paths:
 *
 *   GET    /api/users/:id/contract       — lazy-create or get active contract
 *   PATCH  /api/users/:id/contract       — update body markdown (DRAFT | READY_TO_SIGN)
 *   POST   /api/users/:id/contract/ready — DRAFT → READY_TO_SIGN
 *   POST   /api/users/:id/contract/revert — READY_TO_SIGN | SIGNED → DRAFT
 *   POST   /api/users/:id/contract/reset  — re-derive body from active template (DRAFT only)
 *   GET    /api/users/:id/contract/pdf   — render PDF from employee_contract
 */
@Controller('users')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class EmployeeContractsController {
  constructor(
    private readonly service: EmployeeContractsService,
    private readonly contractPdf: ContractPdfService,
    private readonly db: DatabaseService,
    private readonly signedContracts: SignedContractsService,
  ) {}

  /**
   * GET /api/users/:id/contract
   * - ADMIN: lazy-create a DRAFT if none exists, or return the active one.
   * - Owner self (e.g. DROP viewing their own contract): read-only — returns the
   *   active contract without lazy-create. 404 if no active contract yet.
   *
   * @Roles() — override class ADMIN-only — owner-or-ADMIN enforced in handler.
   * This mirrors the pattern used by GET :id/contract/pdf.
   */
  @Get(':id/contract')
  @Roles() // override class ADMIN-only — owner-or-ADMIN enforced below
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() viewer: SessionUser) {
    if (viewer.role !== 'ADMIN' && viewer.id !== id) {
      throw new ForbiddenException('Можна переглянути лише власний контракт')
    }
    // ADMIN: lazy-create DRAFT if needed (original behaviour).
    if (viewer.role === 'ADMIN') {
      return this.service.getOrCreateForUser(id, viewer)
    }
    // Owner self: read-only access — no lazy-create (ADMIN must create contracts).
    return this.service.getActiveForUser(id)
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
   * PATCH /api/users/:id/contract/custom-values
   * Save admin-supplied values for custom template variables (Screen 2).
   * DRAFT only — 409 CONTRACT_NOT_EDITABLE otherwise.
   */
  @Patch(':id/contract/custom-values')
  async updateCustomValues(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() viewer: SessionUser,
  ) {
    const { customValues } = updateCustomValuesSchema.parse(body)
    return this.service.updateCustomValues(id, customValues, viewer)
  }

  /**
   * GET /api/users/:id/contract/variables
   * Resolve all {{token}} occurrences in the contract body with metadata.
   * Used by the Screen 2 "fill variables" form before marking ready-to-sign.
   */
  @Get(':id/contract/variables')
  async getVariables(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getContractVariables(id)
  }

  /**
   * GET /api/users/:id/contract/pdf
   * Render the employee_contract as a PDF.
   * - If status=SIGNED: fetches signed_contract for real signedTypedName/date/QR.
   * - Otherwise: renders unsigned preview (signedTypedName='').
   *
   * Access: ADMIN (any user) OR the contract owner themselves.
   * @Roles() — override class ADMIN-only — owner-or-ADMIN enforced in handler below.
   *
   * Cache: private, max-age=60 — lets reloads reuse the browser cache instead
   * of re-rendering the (expensive) PDF, preventing the 429 that rapid reloads
   * hit under no-store. `private` keeps it per-browser; 60s bounds staleness.
   * Throttle: 20 req/min (covers hard-refreshes that bypass the browser cache).
   */
  @Get(':id/contract/pdf')
  @Roles() // override class ADMIN-only — owner-or-ADMIN enforced in handler below
  @Header('Cache-Control', 'private, max-age=60')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async getPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: SessionUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (requester.role !== 'ADMIN' && requester.id !== id) {
      throw new ForbiddenException('Можно открыть только свой контракт')
    }

    const contract = await this.service.getActiveForUser(id)

    const userRow = (await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, id),
    })) as User | undefined
    if (!userRow) throw new NotFoundException('User not found')

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'

    let pdfParams: Parameters<typeof this.contractPdf.generateContractPdf>[0]
    // task-junior-ut-round2 §7: when this is a SIGNED contract, remember its
    // signed_contract id so we can lazily persist the real PDF size below.
    let signedContractIdForSize: string | null = null

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
        verifyUrl: `${frontendUrl}/contract/v/${signed.id}`,
      }
      signedContractIdForSize = signed.id
    } else {
      // DRAFT or READY_TO_SIGN — unsigned preview.
      // Pass customValues so the PDF preview reflects admin-filled variables.
      const customValues = (contract.customValues as Record<string, string> | null) ?? {}
      const { body } = renderContractTemplate(
        contract.bodyMarkdown,
        userRow,
        new Date(),
        customValues,
      )

      pdfParams = {
        contractNumber: '',
        bodyMarkdown: body,
        signedTypedName: '',
        signedAt: null,
        verifyUrl: '',
      }
    }

    const { pdfBuffer } = await this.contractPdf.generateContractPdf(pdfParams)

    // task-junior-ut-round2 §7: lazily persist the real PDF size for SIGNED
    // contracts so the documents list shows it instead of 0 B. Best-effort.
    if (signedContractIdForSize) {
      void this.signedContracts
        .recordPdfSizeIfAbsent(signedContractIdForSize, pdfBuffer.length)
        .catch(() => {})
    }

    const { contentDisposition } = safeContractFilename(userRow.displayName, contract.status)

    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', contentDisposition)
      .send(pdfBuffer)
  }
}
