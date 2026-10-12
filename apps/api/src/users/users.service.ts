import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common'
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  lowerEmail,
  projectMembers,
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
import { TeamMembersPreviewService, type TeamMemberPreview } from './team-members-preview.service'
import { DropCreationService, type CreateDropInput } from './drop-creation.service'
import { UserCreationService, type CreateUserInput } from './user-creation.service'
import { PersonalEmailInviteService } from './personal-email-invite.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'

export type AppRole = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

export type { TeamMemberPreview }

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

  // Built lazily (same reason as `invites`): spec factories skip the constructor. The shared helpers
  // stay on this facade and are passed in as bound callbacks.
  private _userCreation?: UserCreationService
  private get userCreation(): UserCreationService {
    return (this._userCreation ??= new UserCreationService(
      this.db,
      this.teamsService,
      this.auditLogService,
      this.inviteMailer,
      {
        issuePersonalEmailInviteTx: (...a) => this.invites.issuePersonalEmailInviteTx(...a),
        assertEmailAvailable: (...a) => this.assertEmailAvailable(...a),
        writeUserEmailOrConflict: (...a) => this.writeUserEmailOrConflict(...a),
        findByEmail: (...a) => this.findByEmail(...a),
      },
    ))
  }

  // Built lazily (same reason as `invites`): spec factories skip the constructor.
  private _teamMembersPreview?: TeamMembersPreviewService
  private get teamMembersPreview(): TeamMembersPreviewService {
    return (this._teamMembersPreview ??= new TeamMembersPreviewService(this.db))
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

  createUser(data: CreateUserInput): Promise<User> {
    return this.userCreation.createUser(data)
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

  /** Per-viewer-masked teammate roster. Delegates to {@link TeamMembersPreviewService}. */
  getTeamMembersForUser(userId: string, viewerRole: AppRole): Promise<TeamMemberPreview[]> {
    return this.teamMembersPreview.getTeamMembersForUser(userId, viewerRole)
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
