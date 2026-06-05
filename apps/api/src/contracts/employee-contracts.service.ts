import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { ContractTargetRole, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { employeeContracts, tosAcceptances } from '../database/schema'
import type { EmployeeContract } from '../database/schema'
import { ContractTemplatesService } from './contract-templates.service'

/**
 * A3-1 — per-employee contract lifecycle.
 *
 * Lifecycle:
 *   lazy-create DRAFT → (ADMIN edits body) → READY_TO_SIGN → (user signs) → SIGNED
 *   ADMIN can revert SIGNED | READY_TO_SIGN → DRAFT (re-opens onboarding)
 *   ADMIN can cancel (terminal CANCELLED, partial-unique allows a new active row)
 *   ADMIN can reset body to current active template (DRAFT only)
 *
 * Partial-unique index `employee_contracts_one_per_user`:
 *   ON employee_contracts (user_id) WHERE status != 'CANCELLED'
 *   — means only one non-CANCELLED row per user.
 *
 * DB trigger `employee_contracts_check_user_not_admin` prevents
 * ADMIN users from appearing as the employee (user_id field).
 * Service also guards at the application level for fast 400.
 */
@Injectable()
export class EmployeeContractsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly contractTemplatesService: ContractTemplatesService,
  ) {}

  /**
   * Get or lazy-create the active employee_contract for a user.
   *
   * - Verifies user exists and is not ADMIN.
   * - Returns existing non-CANCELLED row if found.
   * - Otherwise fetches the current active template for user's role and
   *   creates a DRAFT contract with body copied from the template.
   * - 404 if no active template for the user's role.
   * - 400 if user is ADMIN.
   */
  async getOrCreateForUser(userId: string, viewer: SessionUser): Promise<EmployeeContract> {
    const user = await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')
    if (user.role === 'ADMIN') {
      throw new BadRequestException('ADMIN users cannot have employee contracts')
    }

    const existing = await this.db.db.query.employeeContracts.findFirst({
      where: (tbl, { eq, and, ne }) => and(eq(tbl.userId, userId), ne(tbl.status, 'CANCELLED')),
    })
    if (existing) return existing

    const template = await this.contractTemplatesService.getCurrentForRole(
      user.role as ContractTargetRole,
    )
    if (!template) {
      throw new NotFoundException(`No active contract template for role ${user.role}`)
    }

    const [created] = await this.db.db
      .insert(employeeContracts)
      .values({
        userId,
        sourceTemplateId: template.id,
        bodyMarkdown: template.bodyMarkdown,
        status: 'DRAFT',
        createdByUserId: viewer.id,
      })
      .returning()

    if (!created) throw new Error('Failed to create employee contract')
    return created
  }

  /**
   * Update the body markdown of the contract.
   * Only allowed when status is DRAFT (MED#2 — editing READY_TO_SIGN requires
   * an explicit revert → DRAFT first; this makes the freeze a real server-side invariant).
   * 409 CONTRACT_NOT_EDITABLE if status is READY_TO_SIGN, SIGNED or CANCELLED.
   */
  async updateBody(userId: string, body: string, _viewer: SessionUser): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    if (contract.status !== 'DRAFT') {
      throw new ConflictException('CONTRACT_NOT_EDITABLE')
    }

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({ bodyMarkdown: body, updatedAt: new Date() })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to update employee contract body')
    return updated
  }

  /**
   * Transition contract from DRAFT → READY_TO_SIGN.
   * 409 if not in DRAFT status.
   */
  async markReady(userId: string, _viewer: SessionUser): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    if (contract.status !== 'DRAFT') {
      throw new ConflictException(
        `Cannot mark ready: contract is ${contract.status}, expected DRAFT`,
      )
    }

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({ status: 'READY_TO_SIGN', updatedAt: new Date() })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to mark contract ready')
    return updated
  }

  /**
   * Revert contract to DRAFT.
   * Allowed from READY_TO_SIGN or SIGNED.
   * 409 if already DRAFT or CANCELLED.
   *
   * If reverting from SIGNED:
   *   - Clears signedContractId (employee_contract link, not the audit row itself)
   *   - Deletes tos_acceptances for the user → requiresTos=true on next status check
   *   - signed_contracts row is immutable audit — NOT deleted
   *
   * MED#1: UPDATE employee_contracts + DELETE tos_acceptances run inside a
   * single db.transaction so a partial failure cannot leave status=DRAFT with
   * stale ToS (which would incorrectly skip re-onboarding).
   */
  async revert(userId: string, _viewer: SessionUser): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    if (contract.status === 'DRAFT' || contract.status === 'CANCELLED') {
      throw new ConflictException(`Cannot revert: contract is already ${contract.status}`)
    }

    const wasSigned = contract.status === 'SIGNED'

    return this.db.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(employeeContracts)
        .set({
          status: 'DRAFT',
          signedContractId: null,
          updatedAt: new Date(),
        })
        .where(eq(employeeContracts.id, contract.id))
        .returning()

      if (!updated) throw new Error('Failed to revert employee contract')

      if (wasSigned) {
        // Force re-acceptance of ToS — onboarding status will return
        // requiresTos=true AND requiresContract=true.
        await tx.delete(tosAcceptances).where(eq(tosAcceptances.userId, userId))
      }

      return updated
    })
  }

  /**
   * Re-derive the contract body from the currently active template.
   * Only allowed in DRAFT status.
   * 409 if not DRAFT. 404 if no active template for the role.
   */
  async resetToTemplate(userId: string, _viewer: SessionUser): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    if (contract.status !== 'DRAFT') {
      throw new ConflictException(
        `Cannot reset to template: contract is ${contract.status}, expected DRAFT`,
      )
    }

    const user = await this.db.db.query.users.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')

    const template = await this.contractTemplatesService.getCurrentForRole(
      user.role as ContractTargetRole,
    )
    if (!template) {
      throw new NotFoundException(`No active contract template for role ${user.role}`)
    }

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({
        bodyMarkdown: template.bodyMarkdown,
        sourceTemplateId: template.id,
        updatedAt: new Date(),
      })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to reset employee contract to template')
    return updated
  }

  /**
   * Cancel the contract (terminal state).
   * After cancellation, the partial-unique index allows creating a new active row.
   */
  async cancel(userId: string, _viewer: SessionUser): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to cancel employee contract')
    return updated
  }

  /**
   * Return the READY_TO_SIGN contract for a user.
   * Called by SignedContractsService.sign() to get the contract body.
   * 409 CONTRACT_NOT_READY if no READY_TO_SIGN contract exists.
   */
  async getReadyForSigning(userId: string): Promise<EmployeeContract> {
    const contract = await this.db.db.query.employeeContracts.findFirst({
      where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.status, 'READY_TO_SIGN')),
    })

    if (!contract) {
      throw new ConflictException('CONTRACT_NOT_READY')
    }

    return contract
  }

  /**
   * Boolean existence check — used by OnboardingStatusService.
   * Returns true if user has a READY_TO_SIGN employee_contract.
   */
  async hasReadyContract(userId: string): Promise<boolean> {
    const result = await this.db.db
      .select({ exists: sql<boolean>`true` })
      .from(employeeContracts)
      .where(
        and(eq(employeeContracts.userId, userId), eq(employeeContracts.status, 'READY_TO_SIGN')),
      )
      .limit(1)

    return result.length > 0
  }

  /**
   * Mark a contract as SIGNED and set the signedContractId.
   * Called by SignedContractsService after successful INSERT into signed_contracts.
   * Only transitions from READY_TO_SIGN → SIGNED.
   */
  async markSigned(userId: string, signedContractId: string): Promise<EmployeeContract> {
    const contract = await this.getReadyForSigning(userId)

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({
        status: 'SIGNED',
        signedContractId,
        updatedAt: new Date(),
      })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to mark employee contract as signed')
    return updated
  }

  /**
   * Get the active (non-CANCELLED) contract for a user.
   * Used internally by PDF render endpoints.
   * 404 if no active contract.
   */
  async getActiveForUser(userId: string): Promise<EmployeeContract> {
    return this.getActiveOrThrow(userId)
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private async getActiveOrThrow(userId: string): Promise<EmployeeContract> {
    const contract = await this.db.db.query.employeeContracts.findFirst({
      where: (tbl, { eq, and, ne }) => and(eq(tbl.userId, userId), ne(tbl.status, 'CANCELLED')),
    })

    if (!contract) {
      throw new NotFoundException('No active employee contract found for user')
    }

    return contract
  }
}
