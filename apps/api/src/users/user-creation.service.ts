import { HttpStatus } from '@nestjs/common'
import type { Locale } from '@crm/shared'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  teamMembers,
  teams,
  userEmails,
  users,
  type User,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { TeamsService } from '../teams/teams.service'
import type { AuditLogService } from './audit-log.service'
import type { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { assertSeniorTechFloor } from './role-guards.util'
import { assertTeamStaffRoles } from './team-staff.util'
import { buildCreateUserInsertValues } from './user-insert.util'

type AppRole = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

export interface CreateUserInput {
  email: string
  /** §4.4 — optional personal address, ADMIN-entered at creation only. */
  personalEmail?: string | null
  displayName: string
  role: AppRole
  telegram?: string | null
  phone?: string | null
  avatarUrl?: string | null
  techStack?: string[] | null
  seniorSharePercent?: number
  monthlySalary?: number | null
  salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
  hrIds?: string[]
  accountantId?: string | null
  projectId?: string | null
  paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP'
  walletUsdtErc20?: string | null
  walletUsdtLabel?: string | null
  bankUahRecipient?: string | null
  bankUahIban?: string | null
  bankUahRnokpp?: string | null
  bankUahBankName?: string | null
  /**
   * Legal full name (Cyrillic, order: Surname First Patronymic).
   * Used in MSA contract instead of displayName. Optional at creation time.
   */
  legalFullName?: string
  /**
   * task-i18n-stage2 (Task 3) — interface language selected in the create
   * wizard's "Данные" step. Defaults to 'uk' below when omitted (matches
   * the DB column default).
   */
  locale?: Locale
  /**
   * Drop role - phase 1: senior-only opt-in. `CREATE_NEW` (default)
   * preserves the legacy auto-team flow. `JOIN_DROP_TEAM` skips auto-team
   * and attaches the new senior to an existing drop-team.
   */
  teamMode?: 'CREATE_NEW' | 'JOIN_DROP_TEAM'
  /** Required when `teamMode='JOIN_DROP_TEAM'`. */
  dropTeamId?: string
  /**
   * MED-3 (security-review round 2, authz-hardening): identity of the
   * caller, used to scope `teamMode='JOIN_DROP_TEAM'` for an HR actor to a
   * drop-team they actually belong to (see the check below).
   *
   * LOW (security-review round 3, follow-up to #436): REQUIRED, not
   * optional. The scope check below only fires `if (data.actorRole ===
   * 'HR')` — an optional field that silently defaults to `undefined` lets
   * a *future* caller (a new controller endpoint, a script, a refactor
   * that drops the two lines) skip the check by simply forgetting to pass
   * it, with no signal anywhere that protection was lost. Making both
   * fields mandatory means a forgetful caller fails `tsc`, not authz.
   * Every current caller already supplies both (`UsersController.createUser`
   * from `CurrentUser()`; tests pass an explicit `actorRole: 'ADMIN'` stub).
   */
  actorRole: AppRole
  actorId: string
}

/**
 * Helpers SHARED with other `UsersService` writers (`createDrop`, `adminUpdateUser`) or owned by
 * sibling collaborators. They stay implemented once on the facade and are passed in as bound
 * callbacks.
 */
export interface UserCreationHelpers {
  issuePersonalEmailInviteTx(tx: DrizzleTx, userEmailId: string): Promise<string>
  assertEmailAvailable(
    db: DatabaseService['db'] | DrizzleTx,
    email: string,
    excludeUserId?: string,
  ): Promise<void>
  writeUserEmailOrConflict<T>(write: () => Promise<T>): Promise<T>
  findByEmail(email: string): Promise<User | undefined>
}

/**
 * Regular (non-DROP) user creation, extracted from UsersService (behavior-preserving move).
 * WRITES `users`, `user_emails`, `teams`, `team_members`, `project_members`. Reached through
 * UsersService's lazy `userCreation` getter so prototype-built spec factories keep working; not a
 * Nest provider (its last constructor argument is a plain callback bag).
 */
export class UserCreationService {
  constructor(
    private db: DatabaseService,
    private teamsService: TeamsService,
    private auditLogService: AuditLogService,
    private inviteMailer: PersonalEmailInviteMailerService,
    private helpers: UserCreationHelpers,
  ) {}

  async createUser(data: CreateUserInput): Promise<User> {
    // ut-12: ADMIN creation is reserved to the seed pool — block here as a
    // defense-in-depth measure even if the controller / Roles guard let it slip.
    if (data.role === 'ADMIN') {
      throw apiError('ADMIN_CREATION_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // Drop role - phase 1: DROP must be created via `createDrop` (mandatory
    // team section). Reject here defensively in case a malformed request
    // reaches the legacy endpoint.
    if (data.role === 'DROP') {
      throw apiError('DROP_CREATE_VIA_DEDICATED_ENDPOINT', HttpStatus.BAD_REQUEST)
    }
    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (data.role !== 'SENIOR') {
        throw apiError('JOIN_DROP_TEAM_SENIOR_ONLY', HttpStatus.BAD_REQUEST)
      }
      if (!data.dropTeamId) {
        throw apiError('DROP_TEAM_ID_REQUIRED', HttpStatus.BAD_REQUEST)
      }
      // MED-3 (security-review round 2): `TeamsService.addSeniorToDropTeam`
      // explicitly delegates RBAC to its caller (see that method's own
      // docblock) — without this check, an HR actor could attach the SENIOR
      // they are provisioning to ANY drop-team with a free senior slot, not
      // just their own, reaching into another team's payment routing. ADMIN
      // is exempt (full control, as everywhere else in this method).
      if (data.actorRole === 'HR') {
        // LOW (security-review round 3, follow-up to #436): `actorId` is a
        // required field now (see its docblock) — the `?? ''` fallback here
        // was dead code protecting against an `undefined` that can no
        // longer occur, and (worse) would have silently passed an empty
        // string to `isActiveMemberOfTeam` instead of failing loudly.
        const isMember = await this.teamsService.isActiveMemberOfTeam(data.dropTeamId, data.actorId)
        if (!isMember) {
          throw apiError('HR_JOIN_OWN_DROP_TEAM_ONLY', HttpStatus.FORBIDDEN)
        }
      }
    }
    assertSeniorTechFloor(data.role, data.techStack ?? null)
    // SR-M-1 (security-review #990): the CREATE_NEW team's HR/accountant members are
    // validated BEFORE anything is written, so a rejection never leaves a
    // half-created senior behind.
    if (data.role === 'SENIOR' && data.teamMode !== 'JOIN_DROP_TEAM') {
      await this.assertTeamStaff(data)
    }
    const existing = await this.helpers.findByEmail(data.email)
    if (existing) throw apiError('USER_EMAIL_EXISTS', HttpStatus.CONFLICT)
    // §4.4: `users.email` uniqueness alone cannot see a PERSONAL row on
    // another user — check the whole `user_emails` table too, for both the
    // work address AND the optional personal one, BEFORE creating anything.
    await this.helpers.assertEmailAvailable(this.db.db, data.email)
    if (data.personalEmail) {
      await this.helpers.assertEmailAvailable(this.db.db, data.personalEmail)
    }

    // Build insert payload — only include payment columns when relevant so we
    // keep "no requisites" rows clean (null in DB rather than empty string).
    // Single source for the invitee's locale: the SAME const feeds the `users.locale`
    // column and the invite mail, so they cannot diverge by construction.
    const locale: Locale = data.locale ?? 'uk'
    const insertValues = buildCreateUserInsertValues(data, locale)

    // security-review PR #623 (SR-M-1, MED): these three writes used to be
    // three separate statements with no transaction — a personalEmail long
    // enough to pass Zod's `.email()` (unbounded) but too long for the
    // column (255, same bound as `email`) died on the DB constraint AFTER
    // the `users` row already existed, leaving a half-created account an
    // admin could never attach a personal address to again (the field is
    // create-only). Wrapping in one transaction makes any write failure —
    // this one, a 23505 from `writeUserEmailOrConflict`, anything else —
    // roll back the whole creation instead of leaving a partial row.
    // task-user-emails-invite: set inside the transaction below when
    // `data.personalEmail` is present — read afterwards to send the invite
    // email OUTSIDE the transaction (a network call has no business holding
    // a DB transaction open, same reasoning `ContactService`'s send-after-
    // validate ordering already follows).
    let personalInviteToken: string | undefined

    const rows = await this.db.db.transaction(async (tx) => {
      const insertedRows = await tx.insert(users).values(insertValues).returning()
      const createdUser = insertedRows[0]
      if (!createdUser) throw new Error('Failed to create user')

      // §4.4: the WORK row is what login now actually reads (see
      // findLoginableUserByEmail) — without it this user could never sign in.
      // Already verified/loginable, mirroring the trust `users.email` carries
      // today.
      await this.helpers.writeUserEmailOrConflict(() =>
        tx.insert(userEmails).values({
          userId: createdUser.id,
          email: createdUser.email,
          kind: 'WORK',
          canLogin: true,
          verifiedAt: new Date(),
        }),
      )
      if (data.personalEmail) {
        // canLogin defaults false (column default) — a personal address is
        // NOT a login method until the invite-accept flow below issues a
        // token AND the holder actually accepts it
        // (UsersService.acceptPersonalEmailInvite).
        const personalRows = await this.helpers.writeUserEmailOrConflict(() =>
          tx
            .insert(userEmails)
            .values({ userId: createdUser.id, email: data.personalEmail!, kind: 'PERSONAL' })
            .returning(),
        )
        const personalRow = personalRows[0]
        if (personalRow) {
          personalInviteToken = await this.helpers.issuePersonalEmailInviteTx(tx, personalRow.id)
        }
      }
      return insertedRows
    })

    const created = rows[0]
    if (!created) throw new Error('Failed to create user')

    // Seed initial audit event — always has changes so record() won't skip it
    await this.auditLogService.record({
      actorId: null,
      targetId: created.id,
      action: 'profile_created',
      changes: {
        displayName: { before: null, after: created.displayName },
        role: { before: null, after: created.role },
      },
    })

    // task-user-emails-invite: best-effort, AFTER the transaction has
    // committed — see PersonalEmailInviteMailerService's doc for why a
    // delivery failure here must never fail user creation (the row + token
    // already exist; "resend invite" is the recovery path).
    if (data.personalEmail && personalInviteToken) {
      await this.inviteMailer.sendInvite({
        to: data.personalEmail,
        displayName: data.displayName,
        rawToken: personalInviteToken,
        // The INVITEE's locale — the same const as the inserted `users.locale` column; never the admin's.
        locale,
      })
    }

    if (data.role === 'SENIOR') {
      if (data.teamMode === 'JOIN_DROP_TEAM' && data.dropTeamId) {
        // Drop role - phase 1: skip auto-team creation. Attach the new
        // SENIOR to the requested drop-team. `addSeniorToDropTeam` enforces
        // type+empty-slot+other-team checks; surfaces clear 400 on conflict.
        await this.teamsService.addSeniorToDropTeam(data.dropTeamId, created.id)
      } else {
        // Default `CREATE_NEW` path — unchanged from pre-drop legacy.
        const [team] = await this.db.db
          .insert(teams)
          .values({ name: `Команда ${data.displayName}` })
          .returning()
        if (team) {
          const memberIds = [
            created.id,
            ...enrolledHrIds(data),
            ...(data.accountantId ? [data.accountantId] : []),
          ]
          for (const userId of memberIds) {
            await this.db.db.insert(teamMembers).values({ teamId: team.id, userId })
          }
        }
      }
    }

    if (data.role === 'JUNIOR' && data.projectId) {
      await this.db.db.insert(projectMembers).values({
        projectId: data.projectId,
        userId: created.id,
      })
    }

    return created
  }

  /**
   * SR-M-1: who may be enrolled into a NEW senior's team.
   * - Every enrolled HR (see `enrolledHrIds`) must be an existing user with role HR;
   *   `accountantId` (when set) an existing user with role ACCOUNTANT. Universal:
   *   ADMIN and HR alike.
   * - HR actor only: `hrIds` may contain nobody but the acting HR (403 HR_TEAM_SELF_ONLY).
   *   ADMIN keeps free choice among valid-role users.
   */
  private async assertTeamStaff(data: CreateUserInput): Promise<void> {
    if (data.actorRole === 'HR' && (data.hrIds ?? []).some((id) => id !== data.actorId)) {
      throw apiError('HR_TEAM_SELF_ONLY', HttpStatus.FORBIDDEN)
    }
    await assertTeamStaffRoles(this.db.db, enrolledHrIds(data), data.accountantId)
  }
}

/**
 * SR-M-1: the HR members a new senior's team is created with. An HR actor always
 * enrols exactly themselves (whatever `hrIds` said — `assertTeamStaff` has already
 * rejected anyone else); anyone else gets the requested list, de-duplicated.
 */
function enrolledHrIds(data: CreateUserInput): string[] {
  return data.actorRole === 'HR' ? [data.actorId] : [...new Set(data.hrIds ?? [])]
}
