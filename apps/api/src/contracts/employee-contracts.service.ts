import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, ne, sql } from 'drizzle-orm'
import type {
  ContractTargetRole,
  ContractVariableInfo,
  ContractVariableSource,
  ContractVariablesResponse,
  CustomVariable,
  SessionUser,
} from '@crm/shared'
import { CONTRACT_VARIABLE_DESCRIPTIONS } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { contractTemplates, employeeContracts, tosAcceptances } from '../database/schema'
import type { EmployeeContract } from '../database/schema'
import type { DrizzleTx } from '../database/types'
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

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `err` (or any error in its `.cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE 23505). Drizzle-orm wraps query
 * failures so the original pg error lives on `.cause`; this walks the chain.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if ((cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

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

    let created: typeof employeeContracts.$inferSelect | undefined
    try {
      ;[created] = await this.db.db
        .insert(employeeContracts)
        .values({
          userId,
          sourceTemplateId: template.id,
          bodyMarkdown: template.bodyMarkdown,
          status: 'DRAFT',
          createdByUserId: viewer.id,
        })
        .returning()
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // Race: another concurrent request created the contract between our
        // findFirst check and this insert. Return the now-existing row.
        const raced = await this.db.db.query.employeeContracts.findFirst({
          where: (tbl, { eq, and, ne }) => and(eq(tbl.userId, userId), ne(tbl.status, 'CANCELLED')),
        })
        if (raced) return raced
      }
      throw err
    }

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
        // SECURITY INVARIANT (A3-2): Deleting tos_acceptances is the ONLY mechanism
        // that forces re-onboarding after a SIGNED→DRAFT revert. Without this delete,
        // OnboardingGuard.getStatus() would return requiresTos=false and the employee
        // could bypass the sign-ToS wizard entirely on their next login.
        //
        // Why tos_acceptances (not just signed_contracts): signed_contracts is an
        // immutable audit log — we never delete it. tos_acceptances is the live "has
        // this user currently accepted ToS" table consulted by OnboardingService.
        // Removing the row sets requiresTos=true AND requiresContract=true on next
        // status check because the contract status is back to DRAFT (not READY_TO_SIGN).
        //
        // The UPDATE + DELETE run inside a single db.transaction (MED#1) so a partial
        // failure cannot produce status=DRAFT with stale ToS (which would skip re-onboarding).
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
   *
   * When `tx` is supplied the SELECT runs inside that transaction with a
   * `FOR UPDATE` row-level lock (blocking concurrent signers on the same row
   * until the transaction commits). This prevents double-signing: the second
   * concurrent call blocks here, then re-reads status=SIGNED → no READY_TO_SIGN
   * row found → throws 409 CONTRACT_NOT_READY (security MED#1 / MED#2).
   *
   * Without `tx` (e.g. OnboardingService reads) — plain SELECT, no lock.
   */
  async getReadyForSigning(userId: string, tx?: DrizzleTx): Promise<EmployeeContract> {
    if (tx) {
      // Locking read: SELECT ... FOR UPDATE — blocks concurrent sign() calls on
      // the same user's READY_TO_SIGN row until this transaction commits.
      // Must use select-builder (not query.findFirst) because relational API
      // does not expose .for() / locking-mode options.
      const rows = await tx
        .select()
        .from(employeeContracts)
        .where(
          and(eq(employeeContracts.userId, userId), eq(employeeContracts.status, 'READY_TO_SIGN')),
        )
        .for('update')
        .limit(1)

      if (!rows[0]) {
        throw new ConflictException('CONTRACT_NOT_READY')
      }
      return rows[0]
    }

    // No transaction — plain read (no lock needed, no side effects).
    const contract = await this.db.db.query.employeeContracts.findFirst({
      where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.status, 'READY_TO_SIGN')),
    })

    if (!contract) {
      throw new ConflictException('CONTRACT_NOT_READY')
    }

    return contract
  }

  /**
   * Boolean existence check — used by OnboardingService.requiresContract (A3-4).
   * Returns true if user has a SIGNED employee_contract.
   */
  async hasSignedContract(userId: string): Promise<boolean> {
    const result = await this.db.db
      .select({ exists: sql<boolean>`true` })
      .from(employeeContracts)
      .where(and(eq(employeeContracts.userId, userId), eq(employeeContracts.status, 'SIGNED')))
      .limit(1)

    return result.length > 0
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
   * Get the status of the active (non-CANCELLED) employee contract for the current user.
   * Self-only by construction — caller passes their own userId from JWT.
   * Returns null if no non-CANCELLED contract exists yet.
   *
   * AC1 fix: source is employee_contracts.status, not signed_contracts list.
   * signed_contracts rows lack the `status` field → contractMeDtoSchema.parse() threw.
   */
  async getMyStatus(userId: string): Promise<{ id: string; status: string } | null> {
    const result = await this.db.db
      .select({ id: employeeContracts.id, status: employeeContracts.status })
      .from(employeeContracts)
      .where(and(eq(employeeContracts.userId, userId), ne(employeeContracts.status, 'CANCELLED')))
      .limit(1)

    return result[0] ?? null
  }

  /**
   * Mark a contract as SIGNED and set the signedContractId.
   * Called by SignedContractsService after successful INSERT into signed_contracts.
   * Only transitions from READY_TO_SIGN → SIGNED.
   *
   * The optional `tx` parameter allows the caller to run this UPDATE inside an
   * existing Drizzle transaction. SignedContractsService.sign() passes its `tx`
   * so that the INSERT into signed_contracts and this UPDATE share the same
   * connection — required for the FK constraint on signed_contract_id to resolve
   * against the uncommitted INSERT within the same transaction.
   */
  async markSigned(
    userId: string,
    signedContractId: string,
    tx?: DrizzleTx,
  ): Promise<EmployeeContract> {
    const db = tx ?? this.db.db
    const contract = await this.getReadyForSigning(userId, tx)

    const [updated] = await db
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

  // ─── Screen 2: custom variable values ────────────────────────────────────

  /**
   * PATCH /api/users/:id/contract/custom-values
   * Save admin-supplied custom variable values.
   * Only allowed in DRAFT status (same gate as updateBody).
   * 409 CONTRACT_NOT_EDITABLE if status is not DRAFT.
   *
   * Security hardening: cross-validates keys against the template's declared
   * customVariables — arbitrary keys not declared in the template are rejected
   * with 400 to prevent storing unconstrained data.
   */
  async updateCustomValues(
    userId: string,
    customValues: Record<string, string>,
    _viewer: SessionUser,
  ): Promise<EmployeeContract> {
    const contract = await this.getActiveOrThrow(userId)

    if (contract.status !== 'DRAFT') {
      throw new ConflictException('CONTRACT_NOT_EDITABLE')
    }

    // Cross-validate keys against the template's declared customVariables.
    // Unknown keys are rejected to prevent storing arbitrary payloads.
    // LOW-1 fix: if sourceTemplateId is orphaned (template deleted), throw 404
    // before proceeding — a missing template means we cannot determine the
    // allowed key set, so a 400 "unknown keys" is misleading and incorrect.
    const template = await this.db.db.query.contractTemplates.findFirst({
      where: eq(contractTemplates.id, contract.sourceTemplateId),
    })
    if (!template) {
      throw new NotFoundException('CONTRACT_TEMPLATE_NOT_FOUND')
    }
    const declared = template.customVariables as CustomVariable[] | null | undefined
    const allowedKeys = new Set((declared ?? []).map((v) => v.key))
    const unknownKeys = Object.keys(customValues).filter((k) => !allowedKeys.has(k))
    if (unknownKeys.length > 0) {
      throw new BadRequestException(
        `Неизвестные ключи кастомных переменных: ${unknownKeys.join(', ')}`,
      )
    }

    const [updated] = await this.db.db
      .update(employeeContracts)
      .set({ customValues, updatedAt: new Date() })
      .where(eq(employeeContracts.id, contract.id))
      .returning()

    if (!updated) throw new Error('Failed to update contract custom values')
    return updated
  }

  /**
   * GET /api/users/:id/contract/variables
   * Resolve all {{token}} occurrences in the contract body and classify each:
   *   user      — from user profile fields
   *   company   — from CONTRACT_COMPANY constants
   *   auto      — computed server-side (onboardingDate)
   *   custom    — in template's customVariables list
   *   unknown   — found in body but not in any known source
   *
   * Returns:
   *   variables         — per-token metadata including resolved value + isEmpty flag
   *   customVariables   — raw template customVariable definitions (for input rendering)
   */
  async getContractVariables(userId: string): Promise<ContractVariablesResponse> {
    const contract = await this.getActiveOrThrow(userId)

    // Load user row for value resolution
    const user = await this.db.db.query.users.findFirst({
      where: (tbl, { eq: eqOp }) => eqOp(tbl.id, userId),
    })
    if (!user) throw new NotFoundException('User not found')

    // Load template for customVariables definition
    const [templateRow] = await this.db.db
      .select({ customVariables: contractTemplates.customVariables })
      .from(contractTemplates)
      .where(eq(contractTemplates.id, contract.sourceTemplateId))
      .limit(1)

    const templateCustomVars: CustomVariable[] =
      (templateRow?.customVariables as CustomVariable[] | null) ?? []

    // Build a set of known custom keys from the template
    const customKeySet = new Set(templateCustomVars.map((cv) => cv.key))

    // Classify each known system variable's source
    const USER_KEYS = new Set<string>([
      'employeeName',
      'employeeEmail',
      'role',
      'walletUsdt',
      'bankUahFop',
      'preferredMethod',
      'requisites',
      'salary',
      'salaryCurrency',
      'sharePercent',
      'companySharePercent',
      'rnokpp',
      'phone',
      'registrationAddress',
      'usrRecord',
    ])
    const COMPANY_KEYS = new Set<string>([
      'companyName',
      'companyLegalName',
      'companyAddress',
      'companyCountry',
      'companyRegNumber',
      'companyVat',
      'companyBank',
      'companyAuthorityBasis',
    ])
    const AUTO_KEYS = new Set<string>(['onboardingDate'])

    // Helper: determine whether a user-sourced variable value is empty
    const resolveUserFieldEmpty = (key: string): boolean => {
      switch (key) {
        case 'employeeName':
          return !(user.legalFullName?.trim() || user.displayName)
        case 'employeeEmail':
          return !user.email
        case 'role':
          return !user.role
        case 'walletUsdt':
          return !user.walletUsdtErc20?.trim()
        case 'bankUahFop':
          return !(
            user.bankUahRecipient?.trim() ||
            user.bankUahIban?.trim() ||
            user.bankUahRnokpp?.trim() ||
            user.bankUahBankName?.trim()
          )
        case 'preferredMethod':
          return !user.paymentMethod
        case 'requisites': {
          if (user.paymentMethod === 'USDT_ERC20') return !user.walletUsdtErc20?.trim()
          if (user.paymentMethod === 'BANK_UAH_FOP')
            return !(
              user.bankUahRecipient?.trim() ||
              user.bankUahIban?.trim() ||
              user.bankUahRnokpp?.trim() ||
              user.bankUahBankName?.trim()
            )
          return true
        }
        case 'salary':
          return user.monthlySalary == null || String(user.monthlySalary).trim() === ''
        case 'salaryCurrency':
          return !user.salaryCurrency
        case 'sharePercent':
        case 'companySharePercent':
          // For SENIOR/DROP: empty only when the share value is missing.
          // For other roles (HR, JUNIOR, ACCOUNTANT): sharePercent is not
          // applicable — it should never block the "mark ready" gate even if
          // the token was accidentally inserted in a template for that role.
          if (user.role === 'SENIOR') return false
          if (user.role === 'DROP') return user.dropSharePercent == null
          return false
        case 'rnokpp':
          return !user.bankUahRnokpp?.trim()
        case 'phone':
          return !user.phone?.trim()
        case 'registrationAddress':
          return !user.registrationAddress?.trim()
        case 'usrRecord':
          return !user.usrRecord?.trim()
        default:
          return false
      }
    }

    // Extract all {{token}} keys from the contract body (deduplicated, order of first appearance)
    const tokenRegex = /\{\{([a-zA-Z0-9_]+)\}\}/g
    const seenKeys = new Set<string>()
    const orderedKeys: string[] = []
    let match: RegExpExecArray | null
    while ((match = tokenRegex.exec(contract.bodyMarkdown)) !== null) {
      const k = match[1]
      if (k && !seenKeys.has(k)) {
        seenKeys.add(k)
        orderedKeys.push(k)
      }
    }

    const savedCustomValues = (contract.customValues as Record<string, string> | null) ?? {}

    const variables: ContractVariableInfo[] = orderedKeys.map((key) => {
      let source: ContractVariableSource
      if (USER_KEYS.has(key)) source = 'user'
      else if (COMPANY_KEYS.has(key)) source = 'company'
      else if (AUTO_KEYS.has(key)) source = 'auto'
      else if (customKeySet.has(key)) source = 'custom'
      else source = 'unknown'

      const label =
        key in CONTRACT_VARIABLE_DESCRIPTIONS
          ? CONTRACT_VARIABLE_DESCRIPTIONS[key as keyof typeof CONTRACT_VARIABLE_DESCRIPTIONS]
          : (templateCustomVars.find((cv) => cv.key === key)?.label ?? key)

      let value = ''
      let isEmpty = false

      if (source === 'user') {
        isEmpty = resolveUserFieldEmpty(key)
        value = isEmpty ? '' : key
      } else if (source === 'company') {
        value = key
        isEmpty = false
      } else if (source === 'auto') {
        value = new Date().toISOString().slice(0, 10)
        isEmpty = false
      } else if (source === 'custom' || source === 'unknown') {
        const saved = savedCustomValues[key] ?? ''
        value = saved
        isEmpty = !saved.trim()
      }

      return { key, label, source, value, isEmpty }
    })

    return { variables, customVariables: templateCustomVars }
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
