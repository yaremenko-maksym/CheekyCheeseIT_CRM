import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import type { ContractTargetRole, InterpolatableVariableKey, SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { signedContracts, type User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { ContractTemplatesService } from './contract-templates.service'
import type { GenerateContractPdfParams } from './contract-pdf.service'

/**
 * Onboarding Phase 6A — sign mechanism + immutable audit trail.
 *
 * `sign` is the only write path. It:
 *   1. Refuses for ADMIN (DB CHECK + service guard).
 *   2. Fetches the active MSA template for `userRole`. None → 404.
 *   3. Checks for an existing signed_contract for (userId, templateId).
 *      Found → idempotent return (re-signing same template is a no-op).
 *   4. Loads user row, resolves `{{vars}}` via `interpolateVariables`.
 *   5. Inserts the row inside a tx that also `nextval('contract_number_seq')`.
 *   6. `contract_number` shape: `CHK-<seq>-<UTC year>`.
 *
 * `findById` enforces RBAC: ADMIN, ACCOUNTANT, or the owner of the row.
 * `findMine` returns the caller's own signed contracts.
 */
@Injectable()
export class SignedContractsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly templates: ContractTemplatesService,
  ) {}

  /**
   * Pure helper — substitutes `{{placeholder}}` tokens with values resolved
   * from the `users` row. Missing payment requisites collapse to the literal
   * Russian string `'не указано'`. Returns both the rendered body and the
   * variables map (snapshotted into `signed_contracts.variables_filled`).
   *
   * Translated role labels: HR / Senior / Junior / Drop / Accountant.
   *
   * Payment-method label: `'USDT (ERC-20)'` / `'ФОП (UAH)'` / `'не указано'`.
   *
   * `signedAt` is formatted as ISO date (YYYY-MM-DD, UTC).
   */
  static interpolateVariables(
    bodyMarkdown: string,
    user: Pick<
      User,
      | 'displayName'
      | 'email'
      | 'role'
      | 'walletUsdtErc20'
      | 'walletUsdtLabel'
      | 'bankUahRecipient'
      | 'bankUahIban'
      | 'bankUahRnokpp'
      | 'bankUahBankName'
      | 'paymentMethod'
    >,
    signedAt: Date,
  ) {
    const roleLabels: Record<string, string> = {
      HR: 'HR',
      SENIOR: 'Senior',
      JUNIOR: 'Junior',
      DROP: 'Drop',
      ACCOUNTANT: 'Accountant',
      ADMIN: 'Admin',
    }
    const methodLabels: Record<string, string> = {
      USDT_ERC20: 'USDT (ERC-20)',
      BANK_UAH_FOP: 'ФОП (UAH)',
    }

    const walletUsdt = user.walletUsdtErc20?.trim() || 'не указано'

    const fopParts = [
      user.bankUahRecipient,
      user.bankUahIban,
      user.bankUahRnokpp,
      user.bankUahBankName,
    ].filter((p): p is string => Boolean(p && p.trim()))
    const bankUahFop = fopParts.length > 0 ? fopParts.join(', ') : 'не указано'

    const preferredMethod = user.paymentMethod
      ? (methodLabels[user.paymentMethod] ?? user.paymentMethod)
      : 'не указано'

    const variables: Record<InterpolatableVariableKey, string> = {
      employeeName: user.displayName ?? 'не указано',
      employeeEmail: user.email ?? 'не указано',
      role: roleLabels[user.role] ?? user.role,
      onboardingDate: signedAt.toISOString().slice(0, 10),
      companyName: 'Cheeky Cheese IT',
      walletUsdt,
      bankUahFop,
      preferredMethod,
    }

    // SECURITY: substitute in a SINGLE pass via one regex so user-controlled
    // values (e.g. `displayName = '{{walletUsdt}}'`) CANNOT trigger a second
    // round of substitution. The replacer function looks up each match in
    // `variables` and emits the literal value — values containing further
    // `{{...}}` tokens stay as-is in the rendered body. Defense in depth: we
    // also reject the substitution if no key matched (keeps unknown tokens
    // visible to ADMIN auditing template authoring mistakes).
    const body = bodyMarkdown.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => {
      return Object.prototype.hasOwnProperty.call(variables, key)
        ? variables[key as InterpolatableVariableKey]!
        : match
    })

    return { body, variables }
  }

  async sign({
    userId,
    userRole,
    typedName,
    ip,
    userAgent,
  }: {
    userId: string
    userRole: SessionUser['role']
    typedName: string
    ip: string | null
    userAgent: string | null
  }) {
    if (userRole === 'ADMIN') {
      throw new BadRequestException('ADMIN_DOES_NOT_SIGN_CONTRACTS')
    }

    const template = await this.templates.getCurrentForRole(userRole as ContractTargetRole)
    if (!template) {
      throw new NotFoundException('No active contract template for role')
    }

    // Idempotency: if user already signed THIS template version, return existing.
    const existing = await this.db.db.query.signedContracts.findFirst({
      where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.templateId, template.id)),
    })
    if (existing) return existing

    return this.db.db.transaction(async (tx: DrizzleTx) => {
      // SECURITY: re-check existing inside the tx to close the race window
      // between the read-only pre-check and the INSERT. Two concurrent sign
      // requests from the same user would both observe `existing=null`
      // outside the tx; the second one re-reads here and bails out with the
      // first row instead of producing a duplicate signed_contract.
      const reCheck = await tx.query.signedContracts.findFirst({
        where: (tbl, { eq, and }) => and(eq(tbl.userId, userId), eq(tbl.templateId, template.id)),
      })
      if (reCheck) return reCheck

      // Resolve user row inside tx for fresh requisites.
      const user = (await tx.query.users.findFirst({
        where: (tbl, { eq }) => eq(tbl.id, userId),
      })) as User | undefined
      if (!user) throw new NotFoundException('User not found')

      const signedAt = new Date()
      const { body, variables } = SignedContractsService.interpolateVariables(
        template.bodyMarkdown,
        user,
        signedAt,
      )

      // Atomic `nextval` + UTC year — generated server-side for monotonic numbering.
      const seqResult = (await tx.execute(
        sql`SELECT 'CHK-' || nextval('contract_number_seq')::text || '-' || EXTRACT(YEAR FROM (NOW() AT TIME ZONE 'UTC'))::int::text AS contract_number`,
      )) as unknown
      const rowsCandidate = (seqResult as { rows?: unknown[] })?.rows ?? (seqResult as unknown[])
      const firstRow = Array.isArray(rowsCandidate)
        ? (rowsCandidate[0] as Record<string, unknown> | undefined)
        : undefined
      const contractNumber =
        typeof firstRow?.['contract_number'] === 'string'
          ? (firstRow['contract_number'] as string)
          : null
      if (!contractNumber) {
        // Defense in depth — a silent fallback like `CHK-1-${year}` would race
        // against `signed_contracts.contract_number UNIQUE` once seq has produced
        // any prior row. Surface the failure so the caller sees a 500 instead
        // of a duplicate-key INSERT.
        throw new InternalServerErrorException('Failed to allocate contract_number from sequence')
      }

      const [inserted] = await tx
        .insert(signedContracts)
        .values({
          userId,
          templateId: template.id,
          bodyMarkdownSnapshot: body,
          variablesFilled: variables,
          signedTypedName: typedName,
          signedIp: ip,
          signedUserAgent: userAgent,
          signedAt,
          contractNumber,
        })
        .returning()

      if (!inserted) throw new Error('Failed to insert signed contract')
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
