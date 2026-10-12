import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common'
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  lowerEmail,
  projectMembers,
  projects,
  teamMembers,
  teams,
  userAuditLog,
  userEmails,
  users,
  type User,
  type UserEmail,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { assertEmailAvailable, writeUserEmailOrConflict } from './user-emails.util'
import { loadUserById } from './user-read.util'
import { resolveArchivedFilter, withActiveProjectFlag } from './users-list.util'
import { buildCreateUserInsertValues } from './user-insert.util'
import { buildAdminUserUpdateSet } from './user-update.util'
import { updateUserRow } from './user-write.util'
import { assertAvatarDocument } from './user-avatar.util'
import { type EntitlementSnapshot } from './archived-entitlement'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TosService } from '../tos/tos.service'
import { ApprovalsService } from '../approvals/approvals.service'
import type { Locale } from '@crm/shared'
import { NotificationsService } from '../notifications/notifications.service'
import { AuditLogService } from './audit-log.service'
import {
  assertAdminTargetEditableForRoleChange,
  assertAdminTargetEditableForUpdate,
  assertAssignableRole,
  assertAssignableRoleOnChange,
} from './role-guards.util'
import { UsersAccessService } from './users-access.service'
import { UserProfileService } from './user-profile.service'
import { SeniorShareChangeService } from './senior-share-change.service'
import { UserArchiveService } from './user-archive.service'
import { TeamReconcileService } from './team-reconcile.service'
import { DropCreationService, type CreateDropInput } from './drop-creation.service'
import { PersonalEmailInviteService } from './personal-email-invite.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'

export type AppRole = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

export interface TeamMemberPreview {
  id: string
  displayName: string
  role: User['role']
  avatarUrl: string | null
  avatarDocumentId: string | null
}

// Slim list-item projection for GET /api/users. ONLY directory fields the UI
// pickers (CreateTransactionDialog, team/project dropdowns, nav, admin user
// list rows) actually consume — id / displayName / role / contacts / avatar /
// share. Sensitive PII and finance fields are deliberately EXCLUDED from the
// list payload (security data-exposure fix, ревью #222):
//   bankUahIban / bankUahRnokpp (налоговый №) / bankUahRecipient / bankUahBankName,
//   walletUsdtErc20 / walletUsdtLabel, paymentMethod, monthlySalary,
//   registrationAddress (ФОП PII), adminNote, legalFullName.
// Those remain accessible ONLY via the single-resource GET /api/users/:id
// endpoint, where buildProfileView applies RBAC masking per viewer→target.
// `UserListItem` is an explicit Pick (not Omit<User, …>) so adding a new column
// to the schema does NOT silently leak it into the list — and so `tsc` flags any
// consumer that reads a field we deliberately dropped (drives the slim contract).
export type UserListItem = Pick<
  User,
  | 'id'
  | 'email'
  | 'displayName'
  | 'role'
  | 'avatarUrl'
  | 'avatarDocumentId'
  | 'telegram'
  | 'phone'
  | 'techStack'
  | 'seniorSharePercent'
  | 'dropSharePercent'
  | 'salaryCurrency'
  | 'archivedAt'
  | 'createdAt'
  | 'updatedAt'
>
export type UserWithAvailability = UserListItem & { hasActiveProject: boolean }

/**
 * Drizzle select projection for list endpoints (GET /api/users). Mirrors
 * `UserListItem` exactly. PII / finance columns (bankUah*, wallet*,
 * paymentMethod, monthlySalary, registrationAddress, adminNote,
 * legalFullName) are intentionally absent — they are only accessible via
 * GET /api/users/:id through buildProfileView + RBAC masking.
 *
 * `salaryCurrency` / share percents are non-sensitive (no amount, just the
 * unit / split %) and pickers key UI off them, so they stay.
 */
const USER_LIST_PROJECTION = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  avatarUrl: users.avatarUrl,
  avatarDocumentId: users.avatarDocumentId,
  telegram: users.telegram,
  phone: users.phone,
  techStack: users.techStack,
  seniorSharePercent: users.seniorSharePercent,
  dropSharePercent: users.dropSharePercent,
  salaryCurrency: users.salaryCurrency,
  archivedAt: users.archivedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  // SENSITIVE — intentionally excluded from list (see UserListItem): bankUah*,
  // wallet*, paymentMethod, monthlySalary, registrationAddress,
  // adminNote, legalFullName. Available via GET /api/users/:id only.
} as const

export {
  GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE,
  INVITE_TARGET_ARCHIVED_MESSAGE,
} from './personal-email-invite.service'

@Injectable()
export class UsersService {
  constructor(
    private db: DatabaseService,
    private accessService: UsersAccessService,
    private auditLogService: AuditLogService,
    private tosService: TosService,
    @Inject(forwardRef(() => TeamAuditLogService))
    private teamAuditLogService: TeamAuditLogService,
    @Inject(forwardRef(() => ProjectAuditLogService))
    private projectAuditLogService: ProjectAuditLogService,
    @Inject(forwardRef(() => TeamsService))
    private teamsService: TeamsService,
    private inviteMailer: PersonalEmailInviteMailerService,
    private readonly approvals: ApprovalsService,
    // task-notification-types-producers (позиция 6). Производитель «ждёт
    // решения: новая доля» для БАЗОВОЙ доли — половина, симметричная
    // `ProjectsService`.
    private readonly notifications: NotificationsService,
  ) {}

  // Built lazily from the deps this service already holds, so it works for every construction
  // style (Nest DI, positional `new`, and prototype-based spec factories that skip the constructor).
  private _invites?: PersonalEmailInviteService
  private get invites(): PersonalEmailInviteService {
    return (this._invites ??= new PersonalEmailInviteService(this.db, this.auditLogService))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor.
  private _profile?: UserProfileService
  private get profile(): UserProfileService {
    return (this._profile ??= new UserProfileService(
      this.db,
      this.accessService,
      this.auditLogService,
      this.tosService,
      this.approvals,
    ))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor.
  private _seniorShare?: SeniorShareChangeService
  private get seniorShare(): SeniorShareChangeService {
    return (this._seniorShare ??= new SeniorShareChangeService(
      this.db,
      this.approvals,
      this.profile,
      this.notifications,
    ))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor.
  private _archiveSvc?: UserArchiveService
  private get archiveSvc(): UserArchiveService {
    return (this._archiveSvc ??= new UserArchiveService(
      this.db,
      this.teamAuditLogService,
      this.projectAuditLogService,
      this.auditLogService,
      this.teamsService,
    ))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor.
  private _teamReconcile?: TeamReconcileService
  private get teamReconcile(): TeamReconcileService {
    return (this._teamReconcile ??= new TeamReconcileService(this.teamAuditLogService))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor. The email helpers
  // are SHARED with `createUser`, so they stay on this facade and are passed in as bound callbacks.
  private _dropCreation?: DropCreationService
  private get dropCreation(): DropCreationService {
    return (this._dropCreation ??= new DropCreationService(
      this.db,
      this.auditLogService,
      this.teamAuditLogService,
      this.teamsService,
      {
        assertEmailAvailable: (...a) => this.assertEmailAvailable(...a),
        writeUserEmailOrConflict: (...a) => this.writeUserEmailOrConflict(...a),
        findByEmail: (...a) => this.findByEmail(...a),
      },
    ))
  }

  cancelSeniorShareChange(id: string, currentUser: SessionUser) {
    return this.seniorShare.cancelSeniorShareChange(id, currentUser)
  }

  approveSeniorShareChange(id: string, currentUser: SessionUser) {
    return this.seniorShare.approveSeniorShareChange(id, currentUser)
  }

  rejectSeniorShareChange(id: string, reason: string, currentUser: SessionUser) {
    return this.seniorShare.rejectSeniorShareChange(id, reason, currentUser)
  }

  findByEmail(email: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0])
  }

  /**
   * The ONLY email lookup the login paths should use (§5 of the
   * notifications-and-confirmations spec — AuthController.googleCallback /
   * googleOneTap / devLogin, three call sites, one file). Looks up
   * `user_emails` (NOT `users.email` directly) so a personal address that
   * exists but has not yet been activated via invite-accept behaves exactly
   * like an unrecognized email — `canLogin=false` and "not found" are the
   * same outcome for a caller trying to sign in.
   *
   * The session identity minted afterwards still comes from `findById` (the
   * canonical `users.email`, unchanged) — the ADDRESS used to sign in is not
   * the session's identity, only the key that unlocked it.
   */
  async findLoginableUserByEmail(email: string): Promise<User | undefined> {
    const row = await this.findLoginableEmailRow(email)
    if (!row) return undefined
    return this.findById(row.userId)
  }

  /**
   * Same WHERE clause `findLoginableUserByEmail` above already used
   * (extracted, not duplicated — that method now calls this one) — but
   * returns the matched `user_emails` ROW, not just the user. AuthController
   * needs the row's `kind` (WORK vs PERSONAL) to know which Google-identity
   * binding to check: WORK continues to use `users.googleId` (unchanged);
   * PERSONAL uses its OWN `googleId` column (see schema.ts's comment on
   * that column for why one shared slot cannot serve both addresses).
   */
  async findLoginableEmailRow(email: string): Promise<UserEmail | undefined> {
    return this.db.db.query.userEmails.findFirst({
      where: and(
        eq(lowerEmail(userEmails.email), email.toLowerCase()),
        eq(userEmails.canLogin, true),
      ),
    })
  }

  /**
   * SR-H-6 (security-review PR #623 round 5): looks up a SPECIFIC
   * `user_emails` row by its OWN id (not by address) — used by
   * `JwtAuthGuard.resolveCurrentUser` to re-check the exact row a session
   * was opened through. Deliberately does NOT filter on `canLogin` (unlike
   * `findLoginableEmailRow` above) — the guard needs to see a revoked row
   * (`canLogin: false`) to reject it, not have it disappear the same way a
   * login attempt against it would.
   */
  async findUserEmailById(id: string): Promise<UserEmail | undefined> {
    return this.db.db.query.userEmails.findFirst({
      where: eq(userEmails.id, id),
    })
  }

  /** Thin delegate kept for specs that reach the guard through the service instance; see `assertEmailAvailable` in `user-emails.util`. */
  private async assertEmailAvailable(
    db: DatabaseService['db'] | DrizzleTx,
    email: string,
    excludeUserId?: string,
  ): Promise<void> {
    return assertEmailAvailable(db, email, excludeUserId)
  }

  /**
   * Turns a DB-level unique_violation (23505) on `user_emails` into the
   * SAME clean ConflictException every OTHER collision in this file
   * already produces, instead of a raw 500 — SR-M-2 (security-review PR
   * #623): `assertEmailAvailable`'s `excludeUserId` exception correctly
   * lets a write through when the only existing row belongs to the SAME
   * user (e.g. re-saving an unchanged email) — but it does NOT, and must
   * not, excuse a collision with a DIFFERENT row of that SAME user (their
   * own WORK address set equal to their own PERSONAL address): the unique
   * index is on `email` globally, not scoped by kind, so that write still
   * hits the index. That collision is real, not a bug to route around —
   * this only makes it fail the way every other conflict in this table
   * does. Every caller that writes to `user_emails` (insert or update)
   * MUST go through this, or a legitimate same-user-two-kinds collision
   * surfaces as an unhandled crash instead of a 409.
   *
   * COPY-H-6 (security-review PR #623 closing round): this message was
   * still raw English (`'User with this email already exists'`) — same
   * class of bug COPY-H-5 already fixed on `assertEmailAvailable` above.
   *
   * COPY-L-4 (copy-review PR #623 closing round): the previous version of
   * this paragraph named `adminUpdateUser` as "a concrete, deterministic
   * path" reaching THIS catch and, in the same breath, claimed the admin
   * sees the message verbatim as a toast — each half was true on its OWN,
   * but false stated together: `UserDialog.tsx`'s `explainUserMutationError`
   * overwrites EVERY 409 from `adminUpdateUser`'s endpoint with a generic
   * toast, so that path never actually showed this wording. Naming both
   * reachable paths separately, and precisely:
   *   - `adminUpdateUser`: since COPY-M-15 (this file, the email-uniqueness
   *     check above the call to `assertEmailAvailable` inside that method)
   *     the SAME-user WORK-equals-PERSONAL case is caught earlier, with its
   *     own 400 message, before `assertEmailAvailable` is even reached —
   *     this catch is reachable from there only through a genuine race (a
   *     colliding row inserted between that check's SELECT and this
   *     write's UPDATE), not routine admin use, and even then
   *     `explainUserMutationError` still swallows the message.
   *   - `changePersonalEmail`: reaches this catch on a race between two
   *     concurrent writes to the SAME new address (its own
   *     `this.assertEmailAvailable(this.db.db, newEmail, userId)` call is a
   *     non-atomic pre-check, same TOCTOU gap). That mutation's `onError`
   *     (`useChangePersonalEmail`, `use-user-profile.ts`) shows `e.message`
   *     with no 409-specific override — THIS is the path where the
   *     Russian wording below is what the admin actually reads.
   * Does NOT reuse `assertEmailAvailable`'s "занят другим пользователем"
   * wording — that would misname the caller: this is a collision with the
   * SAME user's own other row, not a stranger's.
   */
  private writeUserEmailOrConflict<T>(write: () => Promise<T>): Promise<T> {
    return writeUserEmailOrConflict(write)
  }

  /**
   * Keeps a user's WORK row in `user_emails` in sync with `users.email` —
   * called at creation (insert) and whenever an admin changes a user's
   * email (update). Every writer of `users.email` MUST call this in the
   * same statement/transaction as that write, or the user silently loses
   * the ability to log in (login now reads `user_emails`, not
   * `users.email` — see `findLoginableUserByEmail`). Find-then-branch
   * rather than `onConflictDoUpdate` so the write goes through the same
   * generic insert/update surface every other writer in this service uses.
   *
   * Confirmed writers of `users.email` as of this comment: `createUser`,
   * `createDrop`, `adminUpdateUser` (all call this), and `seed.ts`'s bulk
   * `SEED_USERS` insert, which does NOT call this — seed.ts inserts its
   * own matching `user_emails` rows directly instead (see that file),
   * since it bypasses this service entirely by design (fixture data, not
   * a request path). If a future writer of `users.email` is added, it
   * must either call `upsertWorkEmail` (through this service) or its own
   * equivalent (like seed.ts) — checked by
   * `user-emails-writer-inventory.spec.ts`, which scans for `.update(users)`
   * / `.insert(users)` call sites the same way `archived-entitlement`'s own
   * inventory test already does for entitlement columns (security-review
   * PR #623, SR-H-3 — this rule was ALREADY violated by seed.ts when first
   * written; nothing enumerated the writers to catch it).
   */
  private async upsertWorkEmail(
    db: DatabaseService['db'] | DrizzleTx,
    userId: string,
    email: string,
  ): Promise<void> {
    const existing = await db.query.userEmails.findFirst({
      where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'WORK')),
    })
    if (existing) {
      const workRowUpdate = { email, updatedAt: new Date() }
      await writeUserEmailOrConflict(() =>
        db.update(userEmails).set(workRowUpdate).where(eq(userEmails.id, existing.id)),
      )
    } else {
      await writeUserEmailOrConflict(() =>
        db
          .insert(userEmails)
          .values({ userId, email, kind: 'WORK', canLogin: true, verifiedAt: new Date() }),
      )
    }
  }

  findById(id: string): Promise<User | undefined> {
    return loadUserById(this.db.db, id)
  }

  async findAll(filter: { archived?: boolean | 'all' } = {}): Promise<UserWithAvailability[]> {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived rows in one query, used by the «Все» tab on /crm/users.
    const archivedFilter = resolveArchivedFilter(filter)
    const where = archivedFilter
      ? and(ne(users.role, 'ADMIN'), archivedFilter)
      : ne(users.role, 'ADMIN')
    // USER_LIST_PROJECTION excludes legalFullName — see module-level constant.
    const allUsers = await this.db.db.select(USER_LIST_PROJECTION).from(users).where(where)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return withActiveProjectFlag(allUsers, busyJuniorIds)
  }

  async findAllIncludingAdmin(
    filter: { archived?: boolean | 'all' } = {},
  ): Promise<UserWithAvailability[]> {
    const archivedFilter = resolveArchivedFilter(filter)
    // USER_LIST_PROJECTION excludes legalFullName — see module-level constant.
    const allUsers = archivedFilter
      ? await this.db.db.select(USER_LIST_PROJECTION).from(users).where(archivedFilter)
      : await this.db.db.select(USER_LIST_PROJECTION).from(users)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return withActiveProjectFlag(allUsers, busyJuniorIds)
  }

  async getProfile(id: string): Promise<User> {
    const user = await this.findById(id)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    return user
  }

  async createUser(data: {
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
  }): Promise<User> {
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
    const existing = await this.findByEmail(data.email)
    if (existing) throw apiError('USER_EMAIL_EXISTS', HttpStatus.CONFLICT)
    // §4.4: `users.email` uniqueness alone cannot see a PERSONAL row on
    // another user — check the whole `user_emails` table too, for both the
    // work address AND the optional personal one, BEFORE creating anything.
    await assertEmailAvailable(this.db.db, data.email)
    if (data.personalEmail) {
      await assertEmailAvailable(this.db.db, data.personalEmail)
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
      await writeUserEmailOrConflict(() =>
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
        const personalRows = await writeUserEmailOrConflict(() =>
          tx
            .insert(userEmails)
            .values({ userId: createdUser.id, email: data.personalEmail!, kind: 'PERSONAL' })
            .returning(),
        )
        const personalRow = personalRows[0]
        if (personalRow) {
          personalInviteToken = await this.invites.issuePersonalEmailInviteTx(tx, personalRow.id)
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
            ...(data.hrIds ?? []),
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

  async adminUpdateUser(
    id: string,
    data: {
      email?: string
      displayName?: string
      role?: AppRole
      telegram?: string | null | undefined
      phone?: string | null | undefined
      avatarUrl?: string | null | undefined
      avatarDocumentId?: string | null | undefined
      techStack?: string[] | null | undefined
      seniorSharePercent?: number | undefined
      dropSharePercent?: number | undefined
      monthlySalary?: number | null | undefined
      salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
      paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP' | undefined
      walletUsdtErc20?: string | null | undefined
      walletUsdtLabel?: string | null | undefined
      bankUahRecipient?: string | null | undefined
      bankUahIban?: string | null | undefined
      bankUahRnokpp?: string | null | undefined
      bankUahBankName?: string | null | undefined
      hrIds?: string[] | undefined
      accountantId?: string | null | undefined
      teamTelegramChannel?: string | null | undefined
      /**
       * Legal full name (Cyrillic, order: Surname First Patronymic).
       * Used in MSA contract instead of displayName. Optional in admin update.
       */
      legalFullName?: string | undefined
      /**
       * Ukrainian registration address (ФОП).
       * Used in contract template as {{registrationAddress}}.
       */
      registrationAddress?: string | null | undefined
    },
    actorId: string | null = null,
  ): Promise<User> {
    // ut-10/11: ADMIN protection. Fetch the existing row first so we can apply
    // role-aware guards before any UPDATE statement.
    const existing = await this.findById(id)
    if (!existing) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    assertAdminTargetEditableForUpdate(existing, data.role, actorId)
    // MED (security-audit authz-hardening): mirror changeRole's privilege-
    // escalation guards here. PATCH /:id/role already forbids elevating
    // anyone to ADMIN (fixed pool) and moving a user to DROP (must go
    // through POST /users/drops, which atomically provisions the mandatory
    // drop-team). Without this, the SAME `role` field on the general
    // PATCH /:id body bypassed both invariants — this only fires on an
    // ACTUAL role change (data.role !== existing.role) so the routine
    // round-trip of resubmitting the current role (e.g. an ADMIN self-edit,
    // or editing a DROP user's other fields) is unaffected.
    assertAssignableRoleOnChange(data.role, existing.role)
    // ut-17: Telegram channel of the team is a SENIOR-only field. The pair
    // invariant SENIOR ≡ team means setting it for any other role would be a
    // contract violation — reject early with 400.
    const effectiveRole = data.role ?? existing.role
    if (data.teamTelegramChannel !== undefined && effectiveRole !== 'SENIOR') {
      throw apiError('TELEGRAM_CHANNEL_SENIOR_ONLY', HttpStatus.BAD_REQUEST)
    }
    // Email uniqueness check — only when actually changing it.
    if (data.email !== undefined && data.email !== existing.email) {
      const conflict = await this.findByEmail(data.email)
      if (conflict && conflict.id !== id) {
        throw apiError('USER_EMAIL_EXISTS', HttpStatus.CONFLICT)
      }
      // COPY-M-15 (copy-review PR #623 closing round): the routine case of
      // this SAME user's own WORK/PERSONAL swap, named and dispatched with
      // its own message BEFORE `assertEmailAvailable` below — that check's
      // `isOwnRow` pass-through deliberately lets a same-user collision
      // through (see its own doc) and leaves the DB's unique index as the
      // ONLY thing catching it, which surfaces as the generic 409
      // `writeUserEmailOrConflict` throws downstream. The frontend's
      // `explainUserMutationError` (`UserDialog.tsx`) overwrites EVERY 409
      // from this endpoint with a hardcoded "already exists" toast — an
      // admin who set the WORK address to this SAME employee's own
      // PERSONAL address would read that and go looking for a second
      // account that does not exist. 400 is not intercepted by that
      // handler (only 409 is), so this message reaches the toast verbatim.
      // Mirrors `changePersonalEmail`'s identical check from the other
      // direction (`newEmail.toLowerCase() === target.email.toLowerCase()`
      // → "Личный email должен отличаться от рабочего").
      const ownPersonalRow = await this.db.db.query.userEmails.findFirst({
        where: and(eq(userEmails.userId, id), eq(userEmails.kind, 'PERSONAL')),
      })
      if (ownPersonalRow && ownPersonalRow.email.toLowerCase() === data.email.toLowerCase()) {
        throw apiError('WORK_EMAIL_MUST_DIFFER_FROM_PERSONAL', HttpStatus.BAD_REQUEST)
      }
      // §4.4 — see createUser's identical check: users.email alone cannot
      // see a collision with someone else's PERSONAL row.
      await assertEmailAvailable(this.db.db, data.email, id)
    }

    // Pure set-builder (see user-update.util.ts). Never throws, so moving the
    // avatar assertion after it leaves the error order unchanged.
    const { set, requestedSeniorSharePercent } = buildAdminUserUpdateSet(data, effectiveRole)
    if ('avatarDocumentId' in data) {
      // The avatar document must be an AVATAR owned by the target user `id`.
      // The owner check is unconditional: there is no ADMIN/invoker bypass.
      await assertAvatarDocument(this.db.db, data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }

    // The user UPDATE + downstream SENIOR-only side effects (team composition
    // reconcile + team telegram channel propagation) are committed as one
    // transaction. Pair invariant SENIOR ≡ team means a partial commit (user
    // saved but team comms lost) would leave inconsistent state on the
    // critical comms field — atomicity matters here.
    const updated = await this.db.db.transaction(async (tx) => {
      // task-archived-user-completeness (AC2): routed through `updateUserRow`
      // so this endpoint refuses exactly what `PATCH /:id/role` refuses. Note
      // it refuses on an ACTUAL change only — an admin fixing an archived
      // employee's IBAN so their earned payout can be sent resubmits the whole
      // form, unchanged `role` and `monthlySalary` included, and must not be
      // blocked (that edit is settlement, not a new entitlement).
      const u = await this.updateUserRow(tx, id, existing, set)

      // task-pending-share (position 5): a requested base-share change opens
      // a proposal instead of writing `seniorSharePercent` directly — see
      // `requestedSeniorSharePercent`'s own comment above. Runs in the SAME
      // transaction as `updateUserRow` so an interruption between the two
      // cannot leave the rest of this PATCH applied while the share change
      // silently vanished (or vice versa).
      if (requestedSeniorSharePercent !== undefined) {
        if (!actorId) {
          throw apiError('SHARE_CHANGE_REQUESTER_REQUIRED', HttpStatus.BAD_REQUEST)
        }
        const shareChangeResult = await this.seniorShare.proposeSeniorShareChangeInTx(
          tx,
          existing,
          requestedSeniorSharePercent,
          actorId,
        )
        // `u` was already fetched (via updateUserRow's own `.returning()`)
        // BEFORE this call ran its own write, in the SAME transaction — patch
        // it here so the HTTP response reflects what the DB now actually
        // holds, not a stale pre-propose snapshot (see this method's own doc).
        // task-648-fix-round-1 (SR-H-1): `shareChangeResult` is non-null for
        // BOTH propose and cancel outcomes now — either way, its
        // `pendingSeniorSharePercent` is what the DB now holds.
        if (shareChangeResult)
          u.pendingSeniorSharePercent = shareChangeResult.pendingSeniorSharePercent
      }

      // §4.4: keep the WORK row in `user_emails` in sync — login now reads
      // THAT table (findLoginableUserByEmail), so without this an admin
      // changing a user's email would silently lock them out of the new
      // address (and leave the old one still working, which is worse).
      if (data.email !== undefined && data.email !== existing.email) {
        await this.upsertWorkEmail(tx, u.id, u.email)
      }

      // SENIOR-only: optional team composition reconcile.
      if (u.role === 'SENIOR' && (data.hrIds !== undefined || data.accountantId !== undefined)) {
        await this.teamReconcile.reconcileSeniorTeamTx(
          tx,
          u.id,
          {
            hrIds: data.hrIds,
            accountantId: data.accountantId,
          },
          actorId,
        )
      }

      // ut-17: propagate teamTelegramChannel onto the senior's team (same tx).
      if (u.role === 'SENIOR' && data.teamTelegramChannel !== undefined) {
        await this.teamReconcile.updateSeniorTeamTelegramChannelTx(
          tx,
          u.id,
          data.teamTelegramChannel,
          actorId,
        )
      }

      return u
    })

    return updated
  }

  async updateProfile(
    id: string,
    data: {
      displayName?: string
      telegram?: string | null
      phone?: string | null
      techStack?: string[] | null
      avatarDocumentId?: string | null
      /** task-i18n-stage2 (Task 3) — self-service interface language change. */
      locale?: Locale
    },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) set.displayName = data.displayName
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if ('avatarDocumentId' in data) {
      // Self-update: document must be owned by `id`.
      await assertAvatarDocument(this.db.db, data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }
    if (data.locale !== undefined) set.locale = data.locale

    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    return updated
  }

  async updateRequisites(
    id: string,
    data: {
      paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20?: string
      walletUsdtLabel?: string | null
      bankUahRecipient?: string
      bankUahIban?: string
      bankUahRnokpp?: string
      bankUahBankName?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = {
      paymentMethod: data.paymentMethod,
      updatedAt: new Date(),
    }
    if (data.paymentMethod === 'USDT_ERC20') {
      set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      set.walletUsdtLabel = data.walletUsdtLabel ?? null
      set.bankUahRecipient = null
      set.bankUahIban = null
      set.bankUahRnokpp = null
      set.bankUahBankName = null
    } else {
      set.bankUahRecipient = data.bankUahRecipient ?? null
      set.bankUahIban = data.bankUahIban ?? null
      set.bankUahRnokpp = data.bankUahRnokpp ?? null
      set.bankUahBankName = data.bankUahBankName ?? null
      set.walletUsdtErc20 = null
      set.walletUsdtLabel = null
    }
    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    return updated
  }

  /** Thin delegate over the shared writer; see `updateUserRow` in `user-write.util.ts`. */
  private updateUserRow(
    db: DatabaseService['db'] | DrizzleTx,
    id: string,
    existing: EntitlementSnapshot,
    set: Record<string, unknown>,
  ): Promise<User> {
    return updateUserRow(db, id, existing, set)
  }

  async changeRole(id: string, role: User['role'], actorId: string): Promise<User> {
    // SEC-03 (MED): privilege-escalation guards. These mirror the protections in
    // adminUpdateUser and createUser so that the lightweight PATCH /:id/role
    // endpoint cannot be used to bypass them.

    // (1)+(2) ADMIN pool fixed; DROP only via POST /users/drops.
    assertAssignableRole(role)

    const existing = await this.findById(id)
    if (!existing) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    // (3)+(4) ADMIN targets are never editable here (another ADMIN / self-demotion).
    assertAdminTargetEditableForRoleChange(existing, actorId)

    // (5) task-archived-user-completeness (AC2): an archived user's role is
    // frozen. Guards (1)–(4) are about privilege; this one is about money —
    // the role is half of what the salary cron reads to mint a new PENDING
    // salary, so flipping a dismissed employee back to JUNIOR/HR re-opens an
    // accrual they cannot earn. Enforced in `updateUserRow`, not inline, so
    // `PATCH /:id` (adminUpdateUser) cannot disagree with `PATCH /:id/role`.
    return this.updateUserRow(this.db.db, id, existing, { role, updatedAt: new Date() })
  }

  async changeSalary(
    id: string,
    data: {
      monthlySalary?: number | null
      salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
      seniorSharePercent?: number
    },
    // Optional: only consulted (and required) when `data.seniorSharePercent`
    // is actually present — every OTHER call of this method (monthlySalary /
    // salaryCurrency only) is unaffected and does not need to supply one.
    actorId?: string,
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    // task-pending-share (position 5): `seniorSharePercent` is DELIBERATELY
    // excluded from `set` — this was a second, un-gated direct-write door
    // onto the same column `adminUpdateUser` already routes through
    // proposal+confirmation (this endpoint had no role check at all, unlike
    // that one — closing it here, not widening it). See
    // `proposeSeniorShareChangeInTx`'s doc for the full reasoning.
    // task-archived-user-completeness (AC2): this method wrote blind (no read
    // of the target at all), so it could not have known the user was archived.
    // The read is what `updateUserRow` compares against — without it every
    // resubmit of an unchanged salary would look like a change and 400.
    const existing = await this.findById(id)
    if (!existing) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    // task-648-fix-round-4 (SR-L-5): the same role gate `adminUpdateUser`
    // applies to its own propose (`effectiveRole === 'SENIOR'`). This
    // endpoint carries no `role` field, so the effective role is simply the
    // target's current one. Without this line the second door onto this
    // column opened a `USER_SENIOR_SHARE` proposal against a DROP/JUNIOR
    // target — a confirmation row for a share that role does not have,
    // hanging fail-closed forever because the client never offers those
    // buttons. Nothing was exploitable; the two doors onto one column simply
    // disagreed, which is the shape every finding on this path started as.
    //
    // Ignoring the field rather than 400-ing is deliberate: it is exactly
    // what `adminUpdateUser` does with the same input (its
    // `requestedSeniorSharePercent` ternary), and a gate that answers
    // differently depending on which endpoint you knock at is the drift this
    // is closing.
    const requestedSeniorSharePercent: number | undefined =
      existing.role === 'SENIOR' ? data.seniorSharePercent : undefined
    // No share change requested — byte-for-byte the pre-existing single
    // statement, no transaction wrapper added (keeps this the SAME shape
    // every OTHER caller of this method already relies on).
    if (requestedSeniorSharePercent === undefined) {
      return this.updateUserRow(this.db.db, id, existing, set)
    }
    if (!actorId) {
      throw apiError('SHARE_CHANGE_REQUESTER_REQUIRED', HttpStatus.BAD_REQUEST)
    }
    return this.db.db.transaction(async (tx) => {
      const updated = await this.updateUserRow(tx, id, existing, set)
      const shareChangeResult = await this.seniorShare.proposeSeniorShareChangeInTx(
        tx,
        existing,
        requestedSeniorSharePercent,
        actorId,
      )
      // Same stale-response fix as adminUpdateUser — see proposeSeniorShareChangeInTx's own doc.
      // task-648-fix-round-1 (SR-H-1): non-null for BOTH propose/cancel now.
      if (shareChangeResult)
        updated.pendingSeniorSharePercent = shareChangeResult.pendingSeniorSharePercent
      return updated
    })
  }

  async setAdminNote(id: string, note: string | null): Promise<User> {
    const rows = await this.db.db
      .update(users)
      .set({ adminNote: note, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
    const updated = rows[0]
    if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    return updated
  }

  archive(id: string, actorId: string | null = null): Promise<User> {
    return this.archiveSvc.archive(id, actorId)
  }

  unarchive(id: string, actorId: string | null = null): Promise<User> {
    return this.archiveSvc.unarchive(id, actorId)
  }

  unarchivePairTx(tx: DrizzleTx, id: string, actorId: string | null = null): Promise<void> {
    return this.archiveSvc.unarchivePairTx(tx, id, actorId)
  }

  getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    return this.archiveSvc.getArchiveImpact(id, currentUser)
  }

  /**
   * Returns flat list of teammates for a given user. Combines:
   *  - team_members of teams associated with the user (HR, ACCOUNTANT, SENIOR)
   *  - JUNIORs active in projects owned by those teams' seniors
   * Excludes the user themselves.
   *
   * Mapping of "user → their team(s)":
   *  - SENIOR: teams owned by this senior (teams.senior_id = user.id is implicit via team_members)
   *  - JUNIOR: teams of seniors whose projects this junior is active in
   *  - HR / ACCOUNTANT: teams where the user is a team_member
   *  - ADMIN: no teams (returns empty)
   */
  /**
   * security-review PR #541 follow-up (HIGH): `viewerRole` is REQUIRED, not
   * optional. Before this fix the method had no notion of a viewer at all,
   * so masking JUNIOR identity from a SENIOR was structurally impossible —
   * `TeamTab.tsx` (GET /users/:id/team, this method's only caller) renders
   * the real displayName/avatar and a `/profile/$userId` link built from the
   * real id, the exact identity `ProjectsService.mapProject` and
   * `TeamsService.mapTeam` already redact for a SENIOR viewer elsewhere in
   * the CRM. This method is the data source for a SENIOR's OWN "Команда"
   * profile tab (self-view) — owner decision: RBAC rule #1 ("SENIOR must not
   * see JUNIOR identity anywhere") applies there too, self-view included.
   *
   * security-review PR #541 round 3 (single-exit hardening): the method used
   * to have FIVE exit points, and the viewerRole filter only guarded the
   * last one — the DROP branch `return`ed its own query result directly,
   * structurally bypassing the filter. Safe today only via two invariants
   * OUTSIDE this method (SENIOR can never reach a DROP target's "Команда"
   * tab per the access matrix; no JUNIOR row can exist in `team_members`),
   * neither of which this method itself enforces — widen the access matrix
   * and the bypass opens silently, with no test going red. Refactored so
   * every branch assigns into `rows` instead of returning; the viewerRole
   * filter at the bottom is now the ONLY return statement past the
   * not-found guard, so it cannot be skipped by construction.
   *
   * security-review PR #541 round 5 (mutation-gate suppression rework): the
   * round-4 patch wrapped every downstream query in an
   * `if (x.length > 0)` / `if (x.size > 0)` "skip when empty" guard, each
   * justified as an equivalence proof (`inArray(col, [])` compiles to SQL
   * `false`, so entering with an empty collection finds nothing regardless)
   * and suppressed accordingly. That was correct about the SQL, but wrong
   * about what a single `// Stryker disable next-line <mutator>` comment
   * actually silences: Stryker's `IgnoreRule` matches by (line, mutator
   * name) only, never by which replacement value, so a directive aimed at
   * "always-true is a no-op" also silenced "always-false", and for most of
   * these guards the always-false direction was real and had a real test
   * (BRANCH-SELECT-1/3) — silently swallowed, never executed by the gate.
   * Fixed by removing the guards outright instead of re-suppressing them:
   * every one of them was a pure "skip one DB round-trip" optimization with
   * no observable effect on `rows`, so deleting the condition deletes the
   * mutant along with it. The one remaining outer gate, `user.role !==
   * 'DROP'`, is NOT suppressed — unlike the guards it replaced
   * (`mayDeriveSeniorRoster`), both of its directions are genuine bugs with
   * genuine tests (see the comment at its `if` above).
   */
  async getTeamMembersForUser(userId: string, viewerRole: AppRole): Promise<TeamMemberPreview[]> {
    const user = await this.findById(userId)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    // Equivalence proof: every reachable path below (the `if` branch AND the
    // `else` branch, exhaustive on `user.role === 'DROP'`) unconditionally
    // reassigns `rows` before it is ever read — there is no path left where
    // this initial value survives to the RBAC filter at the bottom. A
    // mutated placeholder here can never be observed by any test.
    // Stryker disable next-line ArrayDeclaration: provably equivalent — see the paragraph immediately above (rows is unconditionally reassigned by every branch of the if/else below before it is ever read)
    let rows: TeamMemberPreview[] = []

    // security-review PR #541 round 5 (mutation-gate follow-up): a real
    // `if/else` here, not the two independent top-level `if`s round 4 used
    // (`if (user.role === 'DROP')` ... `if (user.role !== 'DROP')`). With two
    // independent conditions, forcing the FIRST one to always-true was a
    // no-op for every non-DROP role: the SECOND condition still evaluated
    // unmutated, Step 1-3 still ran, and its unconditional final assignment
    // silently overwrote whatever this branch produced — an equivalent
    // mutant Stryker could not be told apart from the real "force-always-false
    // skips a real DROP roster" direction (DROP-BRANCH-MASK-1/2), so it could
    // not be safely suppressed either (see the round-5 note in the method
    // docblock). Merging into one `if/else` ties both directions to this
    // SAME condition: force-always-true now means EVERY role — DROP or not —
    // takes this branch and Step 1-3 never runs at all, which BRANCH-SELECT-
    // 1/2/3 (non-DROP targets that need Step 1-3's roster) catch; force-
    // always-false means a DROP target falls through to Step 1-3 instead
    // (whose inner checks don't match 'DROP', producing `[]`), which DROP-
    // BRANCH-MASK-1/2 (non-empty DROP rosters) catch. No suppression needed.
    if (user.role === 'DROP') {
      // Drop role - phase 1: drop's "team members" are the drop-team itself
      // (HR + accountant + optional active senior). JUNIORs are not surfaced
      // (no JUNIOR row can exist in `team_members` — that table only ever
      // gets SENIOR/HR/ACCOUNTANT/DROP rows). The viewerRole filter below
      // still applies to whatever this branch produces regardless.
      //
      // security-review PR #541 round 5 (mutation-gate suppression rework):
      // no `if (dropMemberships.length > 0)` guard here on purpose — it used
      // to exist purely as a DB-round-trip optimization, never a correctness
      // requirement. Verified empirically against this repo's drizzle-orm
      // version: `inArray(teamMembers.teamId, [])` compiles to the literal
      // SQL fragment `false` (never `IN ()`, which would be a syntax error),
      // so running the query below with an empty `dropTeamIds` returns zero
      // rows anyway — identical to skipping it. The guard was removed rather
      // than suppressed because Stryker's `IgnoreRule` matches by (line,
      // mutator name) only, never by which replacement — it cannot silence
      // "always-true" without also silencing "always-false", and the
      // "always-false" direction here is real (killed by
      // DROP-BRANCH-MASK-3). Removing the condition removes the ambiguity
      // instead of trying to suppress half of it.
      const dropMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      const dropTeamIds = dropMemberships.map((m) => m.teamId)
      rows = await this.db.db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: users.role,
          avatarUrl: users.avatarUrl,
          avatarDocumentId: users.avatarDocumentId,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            inArray(teamMembers.teamId, dropTeamIds),
            isNull(teamMembers.leftAt),
            ne(users.id, userId),
          ),
        )
    } else {
      // Step 1: Resolve set of seniorIds whose teams this user belongs to.
      // Left at `[]` for ADMIN (none of the branches below match 'ADMIN'),
      // which is what makes Step 2/3 below resolve nothing for an ADMIN
      // target — DROP-BRANCH-MASK-4 pins that outcome.

      // Equivalence proof: `seniorIds` is always overwritten synchronously or
      // via a DB lookup by exactly one of the four role branches below before
      // it is ever read (SENIOR: `[user.id]`; JUNIOR: derived from active
      // projects; HR/ACCOUNTANT: derived from team_members, or left `[]` when
      // this user has no team memberships of their own). In that last case a
      // mutated placeholder value is "washed out" downstream: `seniorIds`
      // only ever feeds `inArray(...)` filters (never returned directly), and
      // an arbitrary non-matching string finds the same zero rows a
      // genuinely empty array would — the RETURNED `rows` converge to the
      // identical result either way, for any real (non-Stryker-placeholder)
      // seed data. BRANCH-SELECT-1/2/3 each exercise a role whose branch DOES
      // overwrite `seniorIds`, which is the only way this variable's value
      // is ever actually read downstream.
      // Stryker disable next-line ArrayDeclaration: provably equivalent — see the paragraph immediately above (seniorIds only ever feeds inArray(...) filters that are washed out by a non-matching placeholder, never returned directly)
      let seniorIds: string[] = []

      if (user.role === 'SENIOR') {
        seniorIds = [user.id]
      } else if (user.role === 'JUNIOR') {
        const activeProjects = await this.db.db
          .select({ seniorId: projects.seniorId })
          .from(projectMembers)
          .innerJoin(projects, eq(projectMembers.projectId, projects.id))
          .where(and(eq(projectMembers.userId, userId), isNull(projectMembers.leftAt)))
        seniorIds = Array.from(new Set(activeProjects.map((p) => p.seniorId)))
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // MED-2 (security-review round 2): `isNull(leftAt)` — a soft-removed
        // HR/ACCOUNTANT membership must not resolve a team roster anymore.
        // Mirrors the HIGH-1 fix in teams.service.ts (isHrOfTeam/assertAccess).
        //
        // security-review PR #541 round 5: no `if (memberships.length > 0)`
        // guard — same "remove, don't suppress" reasoning as the DROP branch
        // above. `inArray(teamMembers.teamId, [])` -> SQL `false`, so running
        // the query below with an empty `membershipTeamIds` finds nothing,
        // same as skipping it; the "force skip" direction is real and killed
        // by BRANCH-SELECT-3.
        const memberships = await this.db.db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
        const membershipTeamIds = memberships.map((m) => m.teamId)
        // LOW (security-review round 3, follow-up to #436): `isNull(leftAt)`
        // here too — without it a SENIOR rotated OUT of one of this HR's teams
        // (team_members.leftAt set, TeamsService.rotateSenior) still resolves
        // into `seniorIds` below, and their JUNIORs surface in this HR's
        // roster. No incremental data exposure (the same fields are visible
        // via the general user list this HR already has), but this brings the
        // check to the same "leftAt === null is the norm for every membership
        // check in this file" shape as everywhere else (see HIGH-1 above).
        const seniorsInTeams = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .innerJoin(users, eq(teamMembers.userId, users.id))
          .where(
            and(
              inArray(teamMembers.teamId, membershipTeamIds),
              eq(users.role, 'SENIOR'),
              isNull(teamMembers.leftAt),
            ),
          )
        seniorIds = Array.from(new Set(seniorsInTeams.map((s) => s.userId)))
      }

      // Step 2: Collect team_members (SENIOR + HR + ACCOUNTANT) across those seniors' teams.
      // Teams are linked to senior via team_members (the SENIOR is itself a member).
      // MED-2 (security-review round 2): `isNull(leftAt)` on BOTH queries below —
      // a detached (rotated-out) senior's team_members row must not resolve a
      // team, and a departed HR/ACCOUNTANT/SENIOR row must not surface in the
      // roster returned to the caller (stale-member leak, distinct from the
      // team-access class of bug already fixed in teams.service.ts).
      //
      // security-review PR #541 round 5: no `if (seniorIds.length > 0)` guard
      // around Step 2/3 — same "remove, don't suppress" reasoning. Every
      // `inArray(..., [])` below compiles to SQL `false`, so an empty
      // `seniorIds` flows through Step 2 and Step 3 finding nothing at each
      // stage, converging on the same `rows` as skipping the whole block
      // would. The "force skip" direction is real and killed by
      // BRANCH-SELECT-1.
      const seniorMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(
          and(
            inArray(teamMembers.userId, seniorIds),
            eq(users.role, 'SENIOR'),
            isNull(teamMembers.leftAt),
          ),
        )
      const teamIds = Array.from(new Set(seniorMemberships.map((m) => m.teamId)))

      const memberIds = new Set<string>()
      // security-review PR #541 round 5: no `if (teamIds.length > 0)` guard —
      // `inArray(teamMembers.teamId, [])` -> SQL `false`; the "force skip"
      // direction is real and killed by BRANCH-SELECT-1.
      const tmRows = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)))
      tmRows.forEach((r) => memberIds.add(r.userId))

      // Step 3: Add active JUNIORs from projects of those seniors.
      //
      // MED-3 (security-review round 3, follow-up to #436, reverted same PR):
      // an earlier round of this fix derived this list from `seniorMemberships`
      // above (i.e. required an ACTIVE team_members row) instead of the raw
      // `seniorIds` from Step 1. That silently narrowed the SENIOR self-view
      // case: rotation/archive-drop-team detaches a senior from their team
      // WITHOUT archiving their projects (`TeamsService.rotateSenior`,
      // `archiveDropTeam` — see their own docs), so a teamless senior still
      // legitimately owns active projects with active JUNIOR members during
      // that gap, and this method is also how a SENIOR views their OWN "team"
      // tab (`seniorIds = [user.id]` in Step 1's SENIOR branch, always exactly
      // themselves — never contaminated by the HR/ACCOUNTANT leak this PR
      // actually closes). Restored to raw `seniorIds`: the real vulnerability
      // (a rotated-out senior surfacing in an HR VIEWER's roster) is already
      // closed at its actual source — the `isNull(teamMembers.leftAt)` filter
      // added to Step 1's `seniorsInTeams` query above, which is the only
      // branch that ever populated `seniorIds` with someone other than the
      // viewer themselves or their own currently-active project seniors.
      const seniorProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.seniorId, seniorIds))
      const projectIds = seniorProjects.map((p) => p.id)
      // security-review PR #541 round 5: no `if (projectIds.length > 0)`
      // guard — `inArray(projectMembers.projectId, [])` -> SQL `false`; the
      // "force skip" direction is real and killed by BRANCH-SELECT-1.
      const juniorRows = await this.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
      juniorRows.forEach((r) => memberIds.add(r.userId))

      memberIds.delete(userId)
      // security-review PR #541 round 5: no `if (memberIds.size > 0)` guard —
      // `inArray(users.id, [])` -> SQL `false`; the "force skip" direction is
      // real and killed by DROP-BRANCH-MASK-3 (a non-DROP-branch empty roster
      // must leave `rows` at `[]`, not error or hang on an unbounded query).
      rows = await this.db.db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: users.role,
          avatarUrl: users.avatarUrl,
          avatarDocumentId: users.avatarDocumentId,
        })
        .from(users)
        .where(inArray(users.id, Array.from(memberIds)))
    }
    // user.role === 'ADMIN': Step 1's inner checks never match 'ADMIN', so
    // seniorIds stays [] and Step 2/3 resolve nothing — rows ends up [].

    // RBAC rule #1 (security-review PR #541 follow-up, HIGH): SENIOR viewers
    // must not see JUNIOR identity anywhere in the CRM, including their own
    // "Команда" profile tab (self-view is not exempt — owner decision).
    // Blanket-filtered rather than per-item redacted, mirroring the safer
    // shape TeamsService.mapTeam's `filteredJuniorMembers = []` and
    // ProjectsService.computeEffectiveTeam's `juniors = []` already use for
    // the same viewer role — there is no per-item boolean here a future
    // refactor could silently drop. This is the SINGLE return statement for
    // every branch above (round 3 hardening — see method docblock).
    if (viewerRole === 'SENIOR') {
      return rows.filter((r) => r.role !== 'JUNIOR')
    }
    return rows
  }

  /** Per-viewer masked profile (GET profile). Delegates to {@link UserProfileService}. */
  buildProfileView(viewer: User, targetId: string, actorImpersonatorId?: string) {
    return this.profile.buildProfileView(viewer, targetId, actorImpersonatorId)
  }

  updateGoogleId(id: string, googleId: string): Promise<void> {
    return this.db.db
      .update(users)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(users.id, id))
      .then(() => undefined)
  }

  /**
   * PERSONAL-row counterpart of `updateGoogleId` above — see
   * `userEmails.googleId`'s doc (schema.ts) for why WORK and PERSONAL
   * identity binding live on separate columns instead of sharing one slot.
   */
  updateEmailRowGoogleId(emailRowId: string, googleId: string): Promise<void> {
    return this.db.db
      .update(userEmails)
      .set({ googleId, updatedAt: new Date() })
      .where(eq(userEmails.id, emailRowId))
      .then(() => undefined)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // task-user-emails-invite (spec §5, §9 position 2, continued): invite
  // tokens for a PERSONAL user_emails row.
  // ──────────────────────────────────────────────────────────────────────────
  async resendPersonalEmailInvite(
    userId: string,
    actorId: string,
  ): Promise<{ rawToken: string; email: string; displayName: string; locale: Locale }> {
    return this.invites.resendPersonalEmailInvite(userId, actorId)
  }

  async changePersonalEmail(
    userId: string,
    newEmail: string | null,
    actorId: string,
  ): Promise<{ rawToken: string; email: string; displayName: string; locale: Locale } | null> {
    return this.invites.changePersonalEmail(userId, newEmail, actorId)
  }

  async acceptPersonalEmailInvite(
    rawToken: string,
    googleEmail: string,
    googleId: string,
  ): Promise<void> {
    return this.invites.acceptPersonalEmailInvite(rawToken, googleEmail, googleId)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Drop role - phase 1: createDrop + archiveDrop
  //
  // These methods are aditional to the existing `createUser`/`archive`
  // contract. Existing senior/HR/junior/accountant/admin flows are
  // unchanged — only new entry points are added.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create a DROP user atomically with its mandatory drop-team.
   * RBAC: ADMIN only (enforced in controller layer; defensive guard here).
   *
   * Returns the created user + the team id so the UI can navigate to it.
   */
  createDrop(data: CreateDropInput, actor: SessionUser): Promise<{ user: User; teamId: string }> {
    return this.dropCreation.createDrop(data, actor)
  }

  archiveDrop(
    dropId: string,
    actor: SessionUser,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    return this.archiveSvc.archiveDrop(dropId, actor)
  }

  /**
   * Rejoin-team primitive for a teamless SENIOR. Either creates a fresh
   * senior-team (`CREATE_NEW`) or attaches to an existing drop-team
   * (`JOIN_DROP_TEAM`). Caller must be the senior themselves (controller
   * enforces that the path is `me`).
   */
  async rejoinTeam(
    seniorId: string,
    data: {
      teamMode: 'CREATE_NEW' | 'JOIN_DROP_TEAM'
      dropTeamId?: string
      hrIds?: string[]
      accountantId?: string | null
    },
  ): Promise<{ teamId: string }> {
    const user = await this.findById(seniorId)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (user.role !== 'SENIOR') {
      throw apiError('REJOIN_TEAM_SENIOR_ONLY', HttpStatus.BAD_REQUEST)
    }
    // Caller must currently have NO active team membership.
    const activeMembership = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (activeMembership) {
      throw apiError('ALREADY_HAS_ACTIVE_TEAM', HttpStatus.BAD_REQUEST)
    }

    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (!data.dropTeamId) {
        throw apiError('DROP_TEAM_ID_REQUIRED', HttpStatus.BAD_REQUEST)
      }
      // LOW (security-review round 3, follow-up to #436): this is a
      // self-service call — the SENIOR is the caller, so there is no
      // HR/ADMIN actor to scope against (unlike createUser's HR check
      // above `isActiveMemberOfTeam`). Without a check here a teamless
      // SENIOR could self-attach to ANY drop-team with a free slot, not
      // just one they used to belong to — see
      // TeamsService.wasFormerMemberOfTeam's docblock for the full
      // rationale and the chain this closes.
      const wasFormerMember = await this.teamsService.wasFormerMemberOfTeam(
        data.dropTeamId,
        seniorId,
      )
      if (!wasFormerMember) {
        throw apiError('REJOIN_TEAM_MUST_BE_FORMER_MEMBER', HttpStatus.FORBIDDEN)
      }
      await this.teamsService.addSeniorToDropTeam(data.dropTeamId, seniorId)
      return { teamId: data.dropTeamId }
    }

    // CREATE_NEW path — mirrors createUser SENIOR branch.
    if (!data.hrIds || data.hrIds.length < 1) {
      throw apiError('HR_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
    }
    return this.db.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(teams)
        .values({ name: `Команда ${user.displayName}` })
        .returning()
      const team = inserted[0]
      if (!team) throw new Error('Failed to create senior team')
      const memberIds = [
        seniorId,
        ...data.hrIds!,
        ...(data.accountantId ? [data.accountantId] : []),
      ]
      for (const userId of memberIds) {
        await tx.insert(teamMembers).values({ teamId: team.id, userId })
      }
      return { teamId: team.id }
    })
  }

  /**
   * Returns `true` if the user has an active team membership. Used by
   * controller layer to guard SENIOR endpoints (interviews / projects).
   */
  async userHasActiveTeam(userId: string): Promise<boolean> {
    const row = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)))
      .limit(1)
      .then((rows) => rows[0])
    return Boolean(row)
  }

  /**
   * Returns salary metadata for the currently authenticated user (self-only).
   * changedAt = created_at of the most recent user_audit_log row where
   * target_id = userId AND changes JSONB contains 'monthlySalary' key.
   * Values in changes are redacted (SENSITIVE_FIELDS) — only the date is needed.
   *
   * AC3/4: used by JUNIOR hub salary block.
   */
  async getSalaryMeta(userId: string): Promise<{
    monthlySalary: string | null
    salaryCurrency: string | null
    changedAt: string | null
  }> {
    const userRow = await this.db.db
      .select({ monthlySalary: users.monthlySalary, salaryCurrency: users.salaryCurrency })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const user = userRow[0]
    if (!user) return { monthlySalary: null, salaryCurrency: null, changedAt: null }

    // Find the most recent audit log entry where monthlySalary was changed.
    // changes is JSONB — use raw sql for the ? key-existence operator.
    const auditRows = await this.db.db
      .select({ createdAt: userAuditLog.createdAt })
      .from(userAuditLog)
      .where(
        and(
          eq(userAuditLog.targetId, userId),
          // jsonb_exists(col, key) checks for top-level key existence in JSONB.
          // Using the function form instead of the ? operator avoids issues with
          // pg parameterized-query escaping of the ? character.
          sql`jsonb_exists(${userAuditLog.changes}, 'monthlySalary')`,
        ),
      )
      .orderBy(desc(userAuditLog.createdAt))
      .limit(1)

    return {
      monthlySalary: user.monthlySalary ?? null,
      salaryCurrency: user.salaryCurrency ?? null,
      changedAt: auditRows[0]?.createdAt.toISOString() ?? null,
    }
  }
}
