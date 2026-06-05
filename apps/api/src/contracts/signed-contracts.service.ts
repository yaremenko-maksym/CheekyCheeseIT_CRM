import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import { randomBytes } from 'crypto'
import { desc, eq } from 'drizzle-orm'
import type { InterpolatableVariableKey, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { signedContracts, type User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { GenerateContractPdfParams } from './contract-pdf.service'
import { renderContractTemplate, type ContractRenderUserContext } from './contract-rendering'
import { EmployeeContractsService } from './employee-contracts.service'

/**
 * A3-1 — sign mechanism + immutable audit trail.
 *
 * `sign` is the only write path. It:
 *   1. Refuses for ADMIN (DB CHECK + service guard).
 *   2. Fetches user's READY_TO_SIGN employee_contract via EmployeeContractsService.
 *      None → 409 CONTRACT_NOT_READY (thrown by getReadyForSigning).
 *   3. Loads user row, resolves `{{vars}}` via `interpolateVariables`.
 *   4. Inserts the signed_contract inside a tx.
 *   5. Calls `employeeContracts.markSigned(userId, insertedId)` → READY_TO_SIGN → SIGNED.
 *   6. `contract_number` shape: `CHK-<6 uppercase hex>` (e.g. `CHK-7F3A9C`). T4.
 *
 * Idempotency: once markSigned() is called, the employee_contract transitions to
 * SIGNED; subsequent sign() calls reach getReadyForSigning() which throws 409 —
 * preventing double-signing of the same contract.
 *
 * `findById` enforces RBAC: ADMIN, ACCOUNTANT, or the owner of the row.
 * `findMine` returns the caller's own signed contracts.
 */
@Injectable()
export class SignedContractsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly employeeContracts: EmployeeContractsService,
  ) {}

  /**
   * Backward-compatible static wrapper around `renderContractTemplate`.
   *
   * Kept as a static method so existing unit tests that reference
   * `SignedContractsService.interpolateVariables(...)` continue to work
   * without changes. Internally delegates to the shared helper in
   * `contract-rendering.ts` (single source of truth for substitution logic).
   */
  static interpolateVariables(
    bodyMarkdown: string,
    user: ContractRenderUserContext,
    signedAt: Date,
  ): { body: string; variables: Record<InterpolatableVariableKey, string> } {
    return renderContractTemplate(bodyMarkdown, user, signedAt)
  }

  async sign({
    userId,
    userRole,
    typedName: _typedName,
    ip,
    userAgent,
  }: {
    userId: string
    userRole: SessionUser['role']
    /** @deprecated Ignored — resolved server-side from legalFullName (spec §4.3 Option A). */
    typedName: string | undefined
    ip: string | null
    userAgent: string | null
  }) {
    if (userRole === 'ADMIN') {
      throw new BadRequestException('ADMIN_DOES_NOT_SIGN_CONTRACTS')
    }

    return this.db.db.transaction(async (tx: DrizzleTx) => {
      // MED#3: read the READY_TO_SIGN snapshot INSIDE the transaction so that
      // the body snapshot, INSERT into signed_contracts, and markSigned all
      // share one consistent DB snapshot. Throws 409 CONTRACT_NOT_READY if
      // no READY_TO_SIGN contract exists at this point in time.
      const employeeContract = await this.employeeContracts.getReadyForSigning(userId)

      // Resolve user row inside tx for fresh legalFullName + requisites.
      const user = (await tx.query.users.findFirst({
        where: (tbl, { eq }) => eq(tbl.id, userId),
      })) as User | undefined
      if (!user) throw new NotFoundException('User not found')

      // PD-4 guard (spec §6.1): legalFullName MUST be set by ADMIN before
      // signing. Signing with a platform displayName would produce a
      // legally-invalid contract (non-Cyrillic name). Frontend disables the
      // button on the same condition, but we guard on the server as well.
      if (!user.legalFullName?.trim()) {
        throw new BadRequestException('LEGAL_NAME_REQUIRED')
      }

      const signedAt = new Date()
      // A3-1: use employee_contract.bodyMarkdown (ADMIN-authored, already
      // customised per-employee) as the snapshot source — not the raw template.
      const { body, variables } = SignedContractsService.interpolateVariables(
        employeeContract.bodyMarkdown,
        user,
        signedAt,
      )

      // T4: generate CHK-<6 uppercase hex> (e.g. CHK-7F3A9C).
      // 3 random bytes → 6 hex chars → 16^6 = 16 777 216 possible values;
      // collision probability at 1 000 signed contracts ≈ 0.003% (birthday bound).
      // The UNIQUE constraint on signed_contracts.contract_number is the source
      // of truth — retry up to 5 times on a duplicate-key violation so we never
      // surface a transient collision as a 500 to the caller.
      const contractNumber = await generateUniqueContractNumber(async (candidate) => {
        const existing = await tx.query.signedContracts.findFirst({
          where: (tbl, { eq: eqOp }) => eqOp(tbl.contractNumber, candidate),
        })
        return existing === undefined
      })

      // Option A (spec §4.3): resolve signedTypedName server-side from legal name.
      // The audit trail stores the name that was in the profile at signing time.
      // typedName from the client body is ignored (kept optional in signContractSchema).
      const resolvedTypedName = user.legalFullName?.trim() || user.displayName || ''

      const [inserted] = await tx
        .insert(signedContracts)
        .values({
          userId,
          // A3-1: templateId traces back to the source template for audit.
          templateId: employeeContract.sourceTemplateId,
          bodyMarkdownSnapshot: body,
          variablesFilled: variables,
          signedTypedName: resolvedTypedName,
          signedIp: ip,
          signedUserAgent: userAgent,
          signedAt,
          contractNumber,
        })
        .returning()

      if (!inserted) throw new Error('Failed to insert signed contract')

      // A3-1: transition employee_contract READY_TO_SIGN → SIGNED.
      // Pass `tx` so the UPDATE shares the same connection as the INSERT above —
      // required for the FK constraint on signed_contract_id to resolve the
      // uncommitted signed_contracts row within the same transaction (MED#3).
      await this.employeeContracts.markSigned(userId, inserted.id, tx)

      return inserted
    })
  }

  async findById(id: string, requester: SessionUser) {
    const row = await this.db.db.query.signedContracts.findFirst({
      where: (tbl, { eq }) => eq(tbl.id, id),
    })
    if (!row) throw new NotFoundException('Signed contract not found')

    if (requester.role === 'ADMIN' || requester.role === 'ACCOUNTANT') return row
    if (row.userId === requester.id) return row
    throw new ForbiddenException()
  }

  async findMine(userId: string) {
    return this.db.db.query.signedContracts.findMany({
      where: eq(signedContracts.userId, userId),
      orderBy: desc(signedContracts.signedAt),
    })
  }

  /**
   * Resolve the data needed to render a signed contract PDF.
   *
   * Reuses `findById` for the RBAC check (owner | ADMIN | ACCOUNTANT) — a
   * non-authorised caller gets the same Forbidden/NotFound as the JSON read.
   * Only the trailing IP segment is exposed (privacy: full IP stays in the DB).
   */
  async getPdfData(id: string, requester: SessionUser): Promise<GenerateContractPdfParams> {
    const row = await this.findById(id, requester)
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'

    return {
      contractNumber: row.contractNumber,
      bodyMarkdown: row.bodyMarkdownSnapshot,
      signedTypedName: row.signedTypedName,
      signedAt: new Date(row.signedAt),
      signedIpLastOctet: row.signedIp ? ipTrailingSegment(row.signedIp) : null,
      verifyUrl: `${frontendUrl}/contract/v/${row.id}`,
    }
  }
}

/**
 * Generate a unique contract number of the form `CHK-XXXXXX` where X is an
 * uppercase hex digit (e.g. `CHK-7F3A9C`).
 *
 * Calls `isUnique(candidate)` — a caller-supplied async check — and retries
 * with a fresh candidate on each collision. Throws `InternalServerErrorException`
 * after `maxAttempts` failed attempts (expected to be astronomically rare in
 * production; exists only as a safety valve).
 *
 * @param isUnique   Async predicate: returns `true` if the candidate is not yet
 *                   taken (i.e. safe to insert).
 * @param maxAttempts Maximum generation attempts before giving up (default 5).
 */
export async function generateUniqueContractNumber(
  isUnique: (candidate: string) => Promise<boolean>,
  maxAttempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hex = randomBytes(3).toString('hex').toUpperCase()
    const candidate = `CHK-${hex}`
    if (await isUnique(candidate)) return candidate
  }
  throw new InternalServerErrorException(
    'Failed to allocate a unique contract_number after maximum attempts',
  )
}

/**
 * Privacy-preserving trailing segment of an IP address for display.
 *
 * IPv4 `192.168.1.42` → `42` (last octet). IPv6 `2001:db8::1` → `1`
 * (last hextet). IPv4-mapped IPv6 `::ffff:192.168.1.42` is unwrapped to its
 * IPv4 form first. Never returns the full address — `split('.')` alone would
 * leak a whole pure-IPv6 address (no dots to split on).
 */
export function ipTrailingSegment(ip: string): string {
  const unwrapped = ip.replace(/^::ffff:/i, '')
  // IPv4 (or unwrapped IPv4-mapped): split on dots.
  if (unwrapped.includes('.') && !unwrapped.includes(':')) {
    return unwrapped.split('.').pop() ?? unwrapped
  }
  // Pure IPv6: last non-empty hextet.
  return (
    unwrapped
      .split(':')
      .filter((seg) => seg.length > 0)
      .pop() ?? unwrapped
  )
}
