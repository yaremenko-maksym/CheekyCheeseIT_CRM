import { Injectable } from '@nestjs/common'
import type {
  ContractTargetRole,
  ContractTemplateDto,
  OnboardingStatusDto,
  SessionUser,
  TosVersionDto,
} from '@crm/shared'
import { ContractTemplatesService } from '../contracts/contract-templates.service'
import { EmployeeContractsService } from '../contracts/employee-contracts.service'
import { DatabaseService } from '../database/database.service'
import { TosService } from '../tos/tos.service'

/**
 * Onboarding Phase 6A — resolves the user's onboarding state.
 *
 * Drives:
 *   - frontend `/crm/route.tsx` redirect gate
 *   - soft-notify banner (ToS update available)
 *   - onboarding wizard payload (current template + ToS)
 *
 * ADMIN bypasses entirely.
 *
 * Soft-notify semantics (`tosUpdateAvailable`):
 *   - `true` when user has at least one acceptance row for an older version
 *     AND the current active ToS has a higher `version` integer than any of
 *     their acceptances
 *   - independent of `requiresTos` — UI typically renders the banner only
 *     when `requiresTos=false` (otherwise gate is the higher-priority CTA)
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly templates: ContractTemplatesService,
    private readonly tos: TosService,
    private readonly employeeContracts: EmployeeContractsService,
  ) {}

  async getStatus(userId: string, userRole: SessionUser['role']): Promise<OnboardingStatusDto> {
    if (userRole === 'ADMIN') {
      return {
        requiresContract: false,
        requiresTos: false,
        contractReady: false,
        contractTemplate: null,
        tosVersion: null,
        tosUpdateAvailable: false,
        latestTosVersion: null,
      }
    }

    const contractTargetRole = userRole as ContractTargetRole
    const [activeTemplate, activeTos] = await Promise.all([
      this.templates.getCurrentForRole(contractTargetRole),
      this.tos.getCurrent(),
    ])

    // --- contract status (A3-4) -----------------------------------------------
    // requiresContract is now driven by the personal employee_contract's SIGNED
    // state, not by the role template. The user must complete the contract step
    // until their personal contract is SIGNED. contractReady (READY_TO_SIGN)
    // distinguishes "ready to sign" from "still being prepared by ADMIN" (wait
    // screen). This replaces the legacy signed_contracts template-row check.
    const [hasSigned, contractReady] = await Promise.all([
      this.employeeContracts.hasSignedContract(userId),
      this.employeeContracts.hasReadyContract(userId),
    ])
    const requiresContract = !hasSigned

    // contractTemplate is kept in the DTO for backward compatibility with ToS /
    // template admin surfaces. It is no longer used by the personal contract
    // sign step (which previews via /onboarding/contract/pdf instead).
    // Follow-up: remove contractTemplate from OnboardingStatusDto when all
    // callers have been updated.
    const contractTemplate =
      requiresContract && activeTemplate
        ? (this.serializeTemplate(activeTemplate) satisfies ContractTemplateDto)
        : null

    // --- tos status ---------------------------------------------------------
    let requiresTos = false
    let tosUpdateAvailable = false
    let tosVersionPayload: TosVersionDto | null = null
    const latestTosVersion: TosVersionDto | null = activeTos ? this.serializeTos(activeTos) : null

    if (activeTos) {
      const acceptanceForCurrent = await this.db.db.query.tosAcceptances.findFirst({
        where: (tbl, { eq, and }) =>
          and(eq(tbl.userId, userId), eq(tbl.tosVersionId, activeTos.id)),
      })

      requiresTos = !acceptanceForCurrent
      tosVersionPayload = requiresTos ? this.serializeTos(activeTos) : null

      // Soft-notify: user previously accepted SOME version, but not the
      // current active one. If they have any acceptance row at all, then by
      // definition (active is uniquely active, no double-actives) it was for
      // an older version → update available.
      if (requiresTos) {
        const anyAcceptance = await this.db.db.query.tosAcceptances.findFirst({
          where: (tbl, { eq }) => eq(tbl.userId, userId),
        })
        tosUpdateAvailable = Boolean(anyAcceptance)
      }
    }

    return {
      requiresContract,
      requiresTos,
      contractReady,
      contractTemplate,
      tosVersion: tosVersionPayload,
      tosUpdateAvailable,
      latestTosVersion,
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers — Drizzle row → DTO. Dates stringified for the wire.
  // ---------------------------------------------------------------------------

  private serializeTemplate(row: {
    id: string
    targetRole: string
    version: number
    bodyMarkdown: string
    isActive: boolean
    createdByUserId: string
    createdAt: Date | string
  }): ContractTemplateDto {
    return {
      id: row.id,
      targetRole: row.targetRole as ContractTargetRole,
      version: row.version,
      bodyMarkdown: row.bodyMarkdown,
      isActive: row.isActive,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    }
  }

  private serializeTos(row: {
    id: string
    version: number
    bodyMarkdown: string
    isActive: boolean
    createdByUserId: string
    createdAt: Date | string
  }): TosVersionDto {
    return {
      id: row.id,
      version: row.version,
      bodyMarkdown: row.bodyMarkdown,
      isActive: row.isActive,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    }
  }
}
