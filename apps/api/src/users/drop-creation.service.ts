import { HttpStatus } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { userEmails, users, type User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { TeamAuditLogService } from '../teams/team-audit-log.service'
import type { TeamsService } from '../teams/teams.service'
import type { AuditLogService } from './audit-log.service'
import { buildDropInsertValues } from './user-insert.util'

export interface CreateDropInput {
  email: string
  displayName: string
  telegram?: string | null
  phone?: string | null
  avatarUrl?: string | null
  techStack?: string[] | null
  dropSharePercent?: number
  paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP'
  walletUsdtErc20?: string | null
  walletUsdtLabel?: string | null
  bankUahRecipient?: string | null
  bankUahIban?: string | null
  bankUahRnokpp?: string | null
  bankUahBankName?: string | null
  /**
   * Legal full name (Cyrillic ФИО) for the drop's MSA contract. Required
   * at the schema/UI boundary; persisted here so it isn't lost.
   */
  legalFullName?: string | null
  /** Ukrainian registration address (ФОП) — optional; persisted when set. */
  registrationAddress?: string | null
  hrIds: string[]
  accountantId?: string | null
  telegramChannel?: string | null
}

/**
 * Email helpers SHARED with `UsersService.createUser`. They stay implemented
 * once on the facade and are passed in as bound callbacks, so both writers
 * keep using the single implementation.
 */
export interface DropCreationEmailHelpers {
  assertEmailAvailable(
    db: DatabaseService['db'] | DrizzleTx,
    email: string,
    excludeUserId?: string,
  ): Promise<void>
  writeUserEmailOrConflict<T>(write: () => Promise<T>): Promise<T>
  findByEmail(email: string): Promise<User | undefined>
}

/**
 * DROP-user creation, extracted from UsersService (behavior-preserving move).
 * WRITES `users` and `user_emails`. Reached through UsersService's lazy
 * `dropCreation` getter so prototype-built spec factories keep working; not a
 * Nest provider (its last constructor argument is a plain callback bag).
 */
export class DropCreationService {
  constructor(
    private db: DatabaseService,
    private auditLogService: AuditLogService,
    private teamAuditLogService: TeamAuditLogService,
    private teamsService: TeamsService,
    private emailHelpers: DropCreationEmailHelpers,
  ) {}

  /**
   * Create a DROP user atomically with its mandatory drop-team.
   * RBAC: ADMIN only (enforced in controller layer; defensive guard here).
   *
   * Returns the created user + the team id so the UI can navigate to it.
   */
  async createDrop(
    data: CreateDropInput,
    actor: SessionUser,
  ): Promise<{ user: User; teamId: string }> {
    if (actor.role !== 'ADMIN') {
      throw apiError('DROP_CREATE_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }
    // security-review round 2 (authz-hardening): attribute audit rows below
    // to the REAL operator under impersonation, not the impersonated
    // target — see sessionUserSchema.impersonatorId's doc for the full
    // rationale. This endpoint is @Roles('ADMIN'), so in practice
    // `impersonatorId` can only be set here if impersonation semantics
    // ever change to allow it (RolesGuard checks the TARGET's role during
    // impersonation, currently blocking this route) — kept in sync
    // defensively rather than left to silently drift.
    const effectiveActorId = actor.impersonatorId ?? actor.id
    if (data.hrIds.length < 1) {
      throw apiError('HR_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
    }
    const existing = await this.emailHelpers.findByEmail(data.email)
    if (existing) throw apiError('USER_EMAIL_EXISTS', HttpStatus.CONFLICT)
    // §4.4 — see createUser's identical check for the full rationale.
    await this.emailHelpers.assertEmailAvailable(this.db.db, data.email)

    return this.db.db.transaction(async (tx) => {
      const insertValues = buildDropInsertValues(data)

      const rows = await tx.insert(users).values(insertValues).returning()
      const created = rows[0]
      if (!created) throw new Error('Failed to create drop user')

      // §4.4 — see createUser's identical insert for the full rationale.
      // writeUserEmailOrConflict: SR-M-2 — same 23505-to-409 conversion as
      // every other user_emails write.
      await this.emailHelpers.writeUserEmailOrConflict(() =>
        tx.insert(userEmails).values({
          userId: created.id,
          email: created.email,
          kind: 'WORK',
          canLogin: true,
          verifiedAt: new Date(),
        }),
      )

      await this.auditLogService.record(
        {
          actorId: effectiveActorId,
          targetId: created.id,
          action: 'profile_created',
          changes: {
            displayName: { before: null, after: created.displayName },
            role: { before: null, after: created.role },
          },
        },
        tx,
      )

      const team = await this.teamsService.createDropTeam(
        created.id,
        data.hrIds,
        data.accountantId ?? null,
        data.telegramChannel ?? null,
        tx,
      )
      await this.teamAuditLogService.record(
        {
          actorId: effectiveActorId,
          targetId: team.id,
          action: 'team_created',
          changes: { name: { before: null, after: team.name } },
        },
        tx,
      )

      return { user: created, teamId: team.id }
    })
  }
}
