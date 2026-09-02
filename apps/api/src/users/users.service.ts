import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type {
  ArchiveImpact,
  ArchivePendingTransaction,
  AuditChange,
  SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  documents,
  lowerEmail,
  projectMembers,
  projects,
  teamMembers,
  teams,
  transactions,
  userAuditLog,
  userEmailInvites,
  userEmails,
  users,
  type User,
  type UserEmail,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { isUniqueViolation, uniqueViolationConstraint } from '../database/pg-errors'
import { generateInviteToken, hashInviteToken, INVITE_TOKEN_TTL_MS } from './invite-token.util'
import {
  ARCHIVED_ENTITLEMENT_MESSAGE,
  changedEntitlementFields,
  type EntitlementSnapshot,
} from './archived-entitlement'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TosService } from '../tos/tos.service'
import { AuditLogService, REDACTED_TOKEN } from './audit-log.service'
import { UsersAccessService } from './users-access.service'
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

/**
 * LOW-1 (security-review PR #623 round 4): sentinel `ConflictException`
 * message `acceptPersonalEmailInvite` throws when the CONFIRMING Google
 * account is already bound to a DIFFERENT `user_emails` row
 * (`idx_user_emails_google_id`) — distinct from "this token was already
 * used" (which throws the SAME exception TYPE with a different message).
 * Exported so `AuthController.mapInviteAcceptError` can tell them apart by
 * message rather than guessing from the exception class alone.
 */
export const GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE =
  'Этот Google-аккаунт уже привязан к другому адресу в системе'

/**
 * LOW-2 (security-review PR #623 round 4): sentinel `ForbiddenException`
 * message `acceptPersonalEmailInvite` throws when the invited address's
 * OWNING user was archived (fired) after the invite was issued — distinct
 * from "wrong Google account" (same exception TYPE, different message).
 * `AuthController.mapInviteAcceptError` maps this to `account_disabled`,
 * the SAME `?error=` code the ordinary login path already uses for a fired
 * user (`login.tsx`'s `ERROR_MESSAGES`).
 */
export const INVITE_TARGET_ARCHIVED_MESSAGE = 'Учётная запись уволена — приглашение недействительно'

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
  ) {}

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
   * §4.4 structural guarantee, application-side half. The DB unique index
   * on `user_emails.email` (schema.ts) is what actually makes "one address,
   * two accounts" impossible — this is only the friendly half: turns the
   * would-be raw 23505 constraint violation into a clean 409 that names the
   * problem, checked BEFORE the row that would collide is even inserted.
   * `excludeUserId` lets an update re-save a user's own unchanged address
   * without tripping over itself — it does NOT excuse a collision with a
   * DIFFERENT row belonging to the same user (own WORK vs own PERSONAL);
   * that one is real and still throws (see `isOwnRow` below), just later —
   * `writeUserEmailOrConflict` catches it at the DB write (SR-M-2).
   *
   * security-review PR #623 (SR-H-1): compares case-folded, matching the
   * unique index in schema.ts (`idx_user_emails_email_lower`) — mail is
   * case-insensitive, `varchar` equality is not, and a mismatch here is a
   * direct one-address-two-accounts hole (see schema.ts's migration file
   * header for the proof-by-experiment that found it).
   */
  private async assertEmailAvailable(
    db: DatabaseService['db'] | DrizzleTx,
    email: string,
    excludeUserId?: string,
  ): Promise<void> {
    const existing = await db.query.userEmails.findFirst({
      where: eq(lowerEmail(userEmails.email), email.toLowerCase()),
    })
    if (!existing) return
    const isOwnRow = existing.userId === excludeUserId
    if (isOwnRow) return
    throw new ConflictException('User with this email already exists')
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
   */
  private async writeUserEmailOrConflict<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write()
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('User with this email already exists')
      }
      throw err
    }
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
      await this.writeUserEmailOrConflict(() =>
        db.update(userEmails).set(workRowUpdate).where(eq(userEmails.id, existing.id)),
      )
    } else {
      await this.writeUserEmailOrConflict(() =>
        db
          .insert(userEmails)
          .values({ userId, email, kind: 'WORK', canLogin: true, verifiedAt: new Date() }),
      )
    }
  }

  findById(id: string): Promise<User | undefined> {
    return this.db.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
  }

  async findAll(filter: { archived?: boolean | 'all' } = {}): Promise<UserWithAvailability[]> {
    // round 7 (ut-44): tri-state filter — `'all'` returns both active and
    // archived rows in one query, used by the «Все» tab on /crm/users.
    const archivedFilter =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(users.archivedAt)
          : isNull(users.archivedAt)
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
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async findAllIncludingAdmin(
    filter: { archived?: boolean | 'all' } = {},
  ): Promise<UserWithAvailability[]> {
    const archivedFilter =
      filter.archived === 'all'
        ? undefined
        : filter.archived === true
          ? isNotNull(users.archivedAt)
          : isNull(users.archivedAt)
    // USER_LIST_PROJECTION excludes legalFullName — see module-level constant.
    const allUsers = archivedFilter
      ? await this.db.db.select(USER_LIST_PROJECTION).from(users).where(archivedFilter)
      : await this.db.db.select(USER_LIST_PROJECTION).from(users)
    const activeProjectMemberships = await this.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(isNull(projectMembers.leftAt))
    const busyJuniorIds = new Set(activeProjectMemberships.map((m) => m.userId))
    return allUsers.map((u) => ({
      ...u,
      hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
    }))
  }

  async getProfile(id: string): Promise<User> {
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')
    return user
  }

  /**
   * Validate that the supplied `avatarDocumentId` references a document with
   * `category = 'AVATAR'` owned by `ownerId` (or any owner when invoker is
   * ADMIN). Throws `BadRequestException` otherwise so the caller surfaces a
   * 400 with a human-readable message.
   *
   * `null` is treated as a clear-avatar operation and short-circuits.
   */
  private async assertAvatarDocument(
    documentId: string | null | undefined,
    expectedOwnerId: string,
  ): Promise<void> {
    if (documentId === undefined || documentId === null) return
    const row = await this.db.db.query.documents.findFirst({
      where: eq(documents.id, documentId),
    })
    if (!row) throw new BadRequestException('Аватар: документ не найден')
    if (row.category !== 'AVATAR') {
      throw new BadRequestException('Категория документа должна быть AVATAR')
    }
    if (row.ownerId !== expectedOwnerId) {
      throw new BadRequestException('Аватар: документ принадлежит другому пользователю')
    }
    if (row.deletedAt !== null) {
      throw new BadRequestException('Аватар: документ удалён')
    }
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
      throw new ForbiddenException('Создание ADMIN запрещено — пул фиксирован')
    }
    // Drop role - phase 1: DROP must be created via `createDrop` (mandatory
    // team section). Reject here defensively in case a malformed request
    // reaches the legacy endpoint.
    if (data.role === 'DROP') {
      throw new BadRequestException('Создание DROP — через POST /api/users/drops')
    }
    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (data.role !== 'SENIOR') {
        throw new BadRequestException('teamMode=JOIN_DROP_TEAM доступен только при создании SENIOR')
      }
      if (!data.dropTeamId) {
        throw new BadRequestException('dropTeamId обязателен при teamMode=JOIN_DROP_TEAM')
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
          throw new ForbiddenException('HR может присоединять синьора только к своей drop-команде')
        }
      }
    }
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('User with this email already exists')
    // §4.4: `users.email` uniqueness alone cannot see a PERSONAL row on
    // another user — check the whole `user_emails` table too, for both the
    // work address AND the optional personal one, BEFORE creating anything.
    await this.assertEmailAvailable(this.db.db, data.email)
    if (data.personalEmail) {
      await this.assertEmailAvailable(this.db.db, data.personalEmail)
    }

    // Build insert payload — only include payment columns when relevant so we
    // keep "no requisites" rows clean (null in DB rather than empty string).
    const insertValues: typeof users.$inferInsert = {
      email: data.email,
      displayName: data.displayName,
      role: data.role,
      telegram: data.telegram ?? null,
      phone: data.phone ?? null,
      // No auto-generated (dicebear) placeholder — new users get null here and
      // the UI (UserAvatar) falls back to initials until a real photo/upload
      // is set.
      avatarUrl: data.avatarUrl ?? null,
      techStack: data.techStack ?? null,
    }
    if (data.seniorSharePercent !== undefined)
      insertValues.seniorSharePercent = data.seniorSharePercent
    if (data.monthlySalary != null) insertValues.monthlySalary = String(data.monthlySalary)
    if (data.salaryCurrency) insertValues.salaryCurrency = data.salaryCurrency
    if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()

    // Payment requisites — only persist the fields matching the selected method.
    if (data.paymentMethod) {
      insertValues.paymentMethod = data.paymentMethod
      if (data.paymentMethod === 'USDT_ERC20') {
        insertValues.walletUsdtErc20 = data.walletUsdtErc20 ?? null
        insertValues.walletUsdtLabel = data.walletUsdtLabel ?? null
      } else {
        insertValues.bankUahRecipient = data.bankUahRecipient ?? null
        insertValues.bankUahIban = data.bankUahIban ?? null
        insertValues.bankUahRnokpp = data.bankUahRnokpp ?? null
        insertValues.bankUahBankName = data.bankUahBankName ?? null
      }
    }

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
      await this.writeUserEmailOrConflict(() =>
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
        const personalRows = await this.writeUserEmailOrConflict(() =>
          tx
            .insert(userEmails)
            .values({ userId: createdUser.id, email: data.personalEmail!, kind: 'PERSONAL' })
            .returning(),
        )
        const personalRow = personalRows[0]
        if (personalRow) {
          personalInviteToken = await this.issuePersonalEmailInviteTx(tx, personalRow.id)
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
    if (!existing) throw new NotFoundException('User not found')

    if (existing.role === 'ADMIN' && actorId !== null && existing.id !== actorId) {
      throw new ForbiddenException('Cannot edit another admin')
    }
    if (
      data.role !== undefined &&
      existing.role === 'ADMIN' &&
      actorId !== null &&
      existing.id === actorId &&
      data.role !== 'ADMIN'
    ) {
      throw new ForbiddenException('Cannot change own ADMIN role')
    }
    // MED (security-audit authz-hardening): mirror changeRole's privilege-
    // escalation guards here. PATCH /:id/role already forbids elevating
    // anyone to ADMIN (fixed pool) and moving a user to DROP (must go
    // through POST /users/drops, which atomically provisions the mandatory
    // drop-team). Without this, the SAME `role` field on the general
    // PATCH /:id body bypassed both invariants — this only fires on an
    // ACTUAL role change (data.role !== existing.role) so the routine
    // round-trip of resubmitting the current role (e.g. an ADMIN self-edit,
    // or editing a DROP user's other fields) is unaffected.
    if (data.role !== undefined && data.role !== existing.role) {
      if (data.role === 'ADMIN') {
        throw new ForbiddenException('Назначение роли ADMIN запрещено — пул фиксирован')
      }
      if (data.role === 'DROP') {
        throw new ForbiddenException('Изменение роли на DROP — через POST /api/users/drops')
      }
    }
    // ut-17: Telegram channel of the team is a SENIOR-only field. The pair
    // invariant SENIOR ≡ team means setting it for any other role would be a
    // contract violation — reject early with 400.
    const effectiveRole = data.role ?? existing.role
    if (data.teamTelegramChannel !== undefined && effectiveRole !== 'SENIOR') {
      throw new BadRequestException('Telegram channel can only be set for SENIOR users')
    }
    // Email uniqueness check — only when actually changing it.
    if (data.email !== undefined && data.email !== existing.email) {
      const conflict = await this.findByEmail(data.email)
      if (conflict && conflict.id !== id) {
        throw new ConflictException('User with this email already exists')
      }
      // §4.4 — see createUser's identical check: users.email alone cannot
      // see a collision with someone else's PERSONAL row.
      await this.assertEmailAvailable(this.db.db, data.email, id)
    }

    const set: Partial<{
      email: string
      displayName: string
      role: AppRole
      telegram: string | null
      phone: string | null
      avatarUrl: string | null
      avatarDocumentId: string | null
      techStack: string[] | null
      seniorSharePercent: number
      dropSharePercent: number
      monthlySalary: string | null
      salaryCurrency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
      walletUsdtErc20: string | null
      walletUsdtLabel: string | null
      bankUahRecipient: string | null
      bankUahIban: string | null
      bankUahRnokpp: string | null
      bankUahBankName: string | null
      legalFullName: string | null
      registrationAddress: string | null
      updatedAt: Date
    }> = { updatedAt: new Date() }

    if (data.email !== undefined) set.email = data.email
    if (data.displayName !== undefined) set.displayName = data.displayName
    if (data.role !== undefined) set.role = data.role
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('avatarUrl' in data) set.avatarUrl = data.avatarUrl ?? null
    if ('avatarDocumentId' in data) {
      // ADMIN may attach any AVATAR document; ownership check is bypassed
      // (admin operating on someone else's profile). Still enforce category.
      await this.assertAvatarDocument(data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }
    if ('techStack' in data) set.techStack = data.techStack ?? null
    // Share-percent fields — role-scoped writes: only persist when the
    // effective role actually uses the field, so an "orphaned" value can't
    // surface later if the user is promoted into that role. Mirrors the
    // UserDialog finance section (SENIOR-slider / DROP-slider / salary-field).
    if (data.seniorSharePercent !== undefined && effectiveRole === 'SENIOR')
      set.seniorSharePercent = data.seniorSharePercent
    if (data.dropSharePercent !== undefined && effectiveRole === 'DROP')
      set.dropSharePercent = data.dropSharePercent
    if ('monthlySalary' in data)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.legalFullName !== undefined) set.legalFullName = data.legalFullName.trim() || null
    if ('registrationAddress' in data)
      set.registrationAddress = data.registrationAddress?.trim() || null

    // Payment requisites — switching method clears the other branch's fields.
    if (data.paymentMethod !== undefined) {
      set.paymentMethod = data.paymentMethod
      if (data.paymentMethod === 'USDT_ERC20') {
        if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
        if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
        set.bankUahRecipient = null
        set.bankUahIban = null
        set.bankUahRnokpp = null
        set.bankUahBankName = null
      } else {
        if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
        if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
        if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
        if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
        set.walletUsdtErc20 = null
        set.walletUsdtLabel = null
      }
    } else {
      // No method switch — but the admin may still patch individual fields of
      // the current method (e.g. update IBAN without changing payment method).
      if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
      if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
      if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
      if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
      if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
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

      // §4.4: keep the WORK row in `user_emails` in sync — login now reads
      // THAT table (findLoginableUserByEmail), so without this an admin
      // changing a user's email would silently lock them out of the new
      // address (and leave the old one still working, which is worse).
      if (data.email !== undefined && data.email !== existing.email) {
        await this.upsertWorkEmail(tx, u.id, u.email)
      }

      // SENIOR-only: optional team composition reconcile.
      if (u.role === 'SENIOR' && (data.hrIds !== undefined || data.accountantId !== undefined)) {
        await this.reconcileSeniorTeamTx(
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
        await this.updateSeniorTeamTelegramChannelTx(tx, u.id, data.teamTelegramChannel, actorId)
      }

      return u
    })

    return updated
  }

  /**
   * Update `teams.telegram_channel` for the team owned by `seniorId` and write
   * a `team_updated` audit row inside the SAME transaction. No-op if the value
   * hasn't actually changed (avoids spurious audit entries for re-saves).
   */
  private async updateSeniorTeamTelegramChannelTx(
    tx: DrizzleTx,
    seniorId: string,
    value: string | null,
    actorId: string | null,
  ): Promise<void> {
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const team = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) return

    const previous = team.telegramChannel ?? null
    const next = value ?? null
    if (previous === next) return

    await tx
      .update(teams)
      .set({ telegramChannel: next, updatedAt: new Date() })
      .where(eq(teams.id, teamId))

    await this.teamAuditLogService.record(
      {
        actorId,
        targetId: teamId,
        action: 'team_updated',
        changes: { telegramChannel: { before: previous, after: next } },
      },
      tx,
    )
  }

  /**
   * Transactional variant of reconcileSeniorTeam. All membership writes and
   * audit log entries use the supplied `tx` so adminUpdateUser's outer
   * transaction can commit them atomically with the user UPDATE.
   *
   * Active members (`leftAt IS NULL`) are diffed against the target sets:
   *  - new HR/Acc -> insert team_member or restore via leftAt=NULL on existing row
   *  - removed HR/Acc -> set leftAt=now()
   * Each delta is logged into `team_audit_log`.
   */
  private async reconcileSeniorTeamTx(
    tx: DrizzleTx,
    seniorId: string,
    data: { hrIds?: string[] | undefined; accountantId?: string | null | undefined },
    actorId: string | null,
  ): Promise<void> {
    // Resolve the senior's team via team_members (teams has no seniorId column —
    // a SENIOR is always team_member of exactly one team by business invariant).
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const activeMembers: Array<{ userId: string; id: string; role: User['role'] }> = await tx
      .select({
        userId: teamMembers.userId,
        id: teamMembers.id,
        role: users.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))

    const now = new Date()

    if (data.hrIds !== undefined) {
      const desiredHrIds = new Set(data.hrIds)
      const currentHrIds = new Set(
        activeMembers.filter((m) => m.role === 'HR').map((m) => m.userId),
      )

      // To remove: currently active HR not in desired set.
      const toRemove = [...currentHrIds].filter((id) => !desiredHrIds.has(id))
      // To add: desired but not currently active.
      const toAdd = [...desiredHrIds].filter((id) => !currentHrIds.has(id))

      for (const userId of toRemove) {
        await tx
          .update(teamMembers)
          .set({ leftAt: now })
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.userId, userId),
              isNull(teamMembers.leftAt),
            ),
          )
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_removed',
            changes: {
              userId: { before: userId, after: null },
              role: { before: 'HR', after: null },
            },
          },
          tx,
        )
      }
      for (const userId of toAdd) {
        await this.upsertTeamMemberTx(tx, teamId, userId)
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_added',
            changes: {
              userId: { before: null, after: userId },
              role: { before: null, after: 'HR' },
            },
          },
          tx,
        )
      }
    }

    if (data.accountantId !== undefined) {
      const desiredId = data.accountantId ?? null
      const currentAcc = activeMembers.find((m) => m.role === 'ACCOUNTANT')
      const currentId = currentAcc?.userId ?? null

      if (currentId !== desiredId) {
        if (currentId) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                eq(teamMembers.userId, currentId),
                isNull(teamMembers.leftAt),
              ),
            )
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_removed',
              changes: {
                userId: { before: currentId, after: null },
                role: { before: 'ACCOUNTANT', after: null },
              },
            },
            tx,
          )
        }
        if (desiredId) {
          await this.upsertTeamMemberTx(tx, teamId, desiredId)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_added',
              changes: {
                userId: { before: null, after: desiredId },
                role: { before: null, after: 'ACCOUNTANT' },
              },
            },
            tx,
          )
        }
      }
    }
  }

  /**
   * Insert team_member; if row already exists (left previously) — clear leftAt to restore.
   * Uses the supplied transaction handle so it shares the outer atomicity boundary.
   */
  private async upsertTeamMemberTx(tx: DrizzleTx, teamId: string, userId: string): Promise<void> {
    const existing = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .then((rows) => rows[0])
    if (existing) {
      if (existing.leftAt !== null) {
        await tx.update(teamMembers).set({ leftAt: null }).where(eq(teamMembers.id, existing.id))
      }
      return
    }
    await tx.insert(teamMembers).values({ teamId, userId })
  }

  async updateProfile(
    id: string,
    data: {
      displayName?: string
      telegram?: string | null
      phone?: string | null
      techStack?: string[] | null
      avatarDocumentId?: string | null
    },
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.displayName !== undefined) set.displayName = data.displayName
    if ('telegram' in data) set.telegram = data.telegram ?? null
    if ('phone' in data) set.phone = data.phone ?? null
    if ('techStack' in data) set.techStack = data.techStack ?? null
    if ('avatarDocumentId' in data) {
      // Self-update: document must be owned by `id`.
      await this.assertAvatarDocument(data.avatarDocumentId ?? null, id)
      set.avatarDocumentId = data.avatarDocumentId ?? null
    }

    const rows = await this.db.db.update(users).set(set).where(eq(users.id, id)).returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
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
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  /**
   * task-archived-user-completeness (AC2) — the single write path for every
   * UPDATE that can move an entitlement column, and the only place the
   * archived-user refusal is spelled out.
   *
   * ## Why one choke point instead of a check per endpoint
   *
   * The defect this closes is not one missing `if`. `changeRole` and
   * `adminUpdateUser` are two doors into the SAME state (`PATCH /:id/role`
   * and the `role` field of `PATCH /:id`), and `changeSalary` is a third into
   * the money half of it — the reported chain (JUNIOR → HR → archive →
   * JUNIOR) walks through them precisely because they do not agree with each
   * other. Five copies of the same `if` agree only until someone edits one of
   * them, and the next door added to this service starts out with zero. Here
   * the decision (which columns, which message, actual-change semantics) is
   * stated ONCE in `archived-entitlement.ts` and every writer inherits it by
   * calling this method rather than by remembering a rule.
   *
   * The honest limit of a choke point: it protects writers that USE it. A
   * future method reaching for `this.db.db.update(users)` directly is not
   * covered — which is why this is not the only layer (see below), and why the
   * set of direct writers is a CHECKED inventory rather than a claim in this
   * comment.
   *
   * Two of them bypass this method on purpose (`updateProfile`,
   * `updateRequisites`). They are safe not because they look harmless but
   * because the `set` object they build contains no entitlement column, and
   * `archived-entitlement.unit.spec.ts` asserts exactly that by capturing what
   * they hand to Drizzle. The rest (`setAdminNote`, `archive`,
   * `unarchivePairTx`, `updateGoogleId`, `archiveDrop`, and
   * `TeamsService.archiveDropTeam`) write only `admin_note` / `archived_at` /
   * `google_id`, none of which decide what anyone is owed.
   *
   * Do NOT trust that list as prose — an earlier revision of this docblock
   * promised that a third direct writer would turn the spec red, and security
   * review measured that it did not: the spec named two methods one by one and
   * was structurally blind to a third. It is now ENUMERATING — it scans every
   * non-spec file under `apps/api/src`, collects the enclosing method of every
   * `.update(users)`, and diffs the whole set against an explicit inventory.
   * A new writer anywhere in the API fails that test by name. That is the only
   * form in which this paragraph is worth reading — and it too has stated
   * limits (the scan is line-based, so its coverage of a multi-line call rests
   * on the prettier gate); they are listed on the check itself, not paraphrased
   * here, so there is one place to keep honest.
   *
   * ## Two layers, not one
   *
   * `existing` is read BEFORE this call (its callers need it for their own
   * guards), so on its own it is a TOCTOU window: an archive committing
   * between that read and this UPDATE would let the change through. When the
   * write actually moves an entitlement column, the refusal is therefore
   * ALSO expressed as `archived_at IS NULL` inside the statement, where
   * Postgres re-evaluates it against the committed row. Same two-layer shape
   * `TransactionsService` already uses for the salary receiver
   * (`assertSalaryReceiverNotArchived` + `salaryReceiverNotArchivedFilter`).
   *
   * When nothing entitlement-bearing changes, no predicate is added: the
   * statement stays exactly what it was, so settlement-time edits (requisites,
   * contacts, a resubmitted unchanged role) are untouched.
   */
  private async updateUserRow(
    db: DatabaseService['db'] | DrizzleTx,
    id: string,
    existing: EntitlementSnapshot,
    set: Record<string, unknown>,
  ): Promise<User> {
    const changed = changedEntitlementFields(existing, set)
    if (changed.length > 0 && existing.archivedAt) {
      throw new BadRequestException(ARCHIVED_ENTITLEMENT_MESSAGE)
    }

    const rows = await db
      .update(users)
      .set(set)
      .where(
        changed.length > 0 ? and(eq(users.id, id), isNull(users.archivedAt)) : eq(users.id, id),
      )
      .returning()

    const updated = rows[0]
    if (updated) return updated

    // Zero rows with the archival predicate attached is ambiguous by itself —
    // the row may be missing, or it may have been archived since `existing`
    // was read. Re-read (same executor, so it sees this transaction's own
    // writes) rather than guess, so the operator gets the true reason.
    if (changed.length > 0) {
      const [current] = await db
        .select({ archivedAt: users.archivedAt })
        .from(users)
        .where(eq(users.id, id))
      if (current?.archivedAt) throw new BadRequestException(ARCHIVED_ENTITLEMENT_MESSAGE)
    }
    throw new NotFoundException('User not found')
  }

  async changeRole(id: string, role: User['role'], actorId: string): Promise<User> {
    // SEC-03 (MED): privilege-escalation guards. These mirror the protections in
    // adminUpdateUser and createUser so that the lightweight PATCH /:id/role
    // endpoint cannot be used to bypass them.

    // (1) ADMIN pool is fixed — elevation to ADMIN is always forbidden here.
    if (role === 'ADMIN') {
      throw new ForbiddenException('Назначение роли ADMIN запрещено — пул фиксирован')
    }

    // (2) DROP must be created via the dedicated POST /users/drops endpoint
    // which provisions the associated drop-team atomically. Routing through
    // changeRole would leave the user without a team (broken invariant).
    if (role === 'DROP') {
      throw new ForbiddenException('Изменение роли на DROP — через POST /api/users/drops')
    }

    const existing = await this.findById(id)
    if (!existing) throw new NotFoundException('User not found')

    // (3) Cannot change the role of any ADMIN (even to a lower role) unless
    // the actor is editing their own record — and even then self-demotion is
    // blocked by rule (4). Mirrors adminUpdateUser :410.
    if (existing.role === 'ADMIN' && actorId !== existing.id) {
      throw new ForbiddenException('Нельзя изменить роль другого администратора')
    }

    // (4) An ADMIN cannot demote themselves via this endpoint.
    if (existing.role === 'ADMIN' && actorId === existing.id) {
      throw new ForbiddenException('Администратор не может сменить собственную роль')
    }

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
  ): Promise<User> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (data.monthlySalary !== undefined)
      set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
    if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
    if (data.seniorSharePercent !== undefined) set.seniorSharePercent = data.seniorSharePercent
    // task-archived-user-completeness (AC2): this method wrote blind (no read
    // of the target at all), so it could not have known the user was archived.
    // The read is what `updateUserRow` compares against — without it every
    // resubmit of an unchanged salary would look like a change and 400.
    const existing = await this.findById(id)
    if (!existing) throw new NotFoundException('User not found')
    return this.updateUserRow(this.db.db, id, existing, set)
  }

  async setAdminNote(id: string, note: string | null): Promise<User> {
    const rows = await this.db.db
      .update(users)
      .set({ adminNote: note, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning()
    const updated = rows[0]
    if (!updated) throw new NotFoundException('User not found')
    return updated
  }

  /**
   * Soft-archive a user with role-specific cascade:
   *  - SENIOR: paired with their team — archives team + active projects + sets leftAt
   *    for HR/Acc team_members (but NOT for senior's own team_member row).
   *  - HR/ACCOUNTANT: sets leftAt for their team memberships.
   *  - JUNIOR: sets leftAt for their project memberships (and any team_members).
   *  - ADMIN: just the user row.
   * Audit log entries written to user_audit_log + team_audit_log + project_audit_log.
   * All mutations in one transaction — any throw rolls back the whole cascade.
   *
   * @param id user id
   * @param actorId admin who triggered archive (for audit log)
   */
  async archive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      // security-review PR #584 round 2 (MED-4): SELECT ... FOR UPDATE locks
      // this row for the lifetime of the transaction. Without it, two
      // concurrent archive requests for the same user both read
      // `archivedAt: null` under READ COMMITTED, both pass the check below,
      // and both run the cascade — duplicate audit-trail rows and
      // timestamp drift (no money moves, no privilege is gained, but the
      // audit trail lies about how many times this happened). The second
      // concurrent caller now blocks here until the first commits, then
      // re-reads `archivedAt` already set and hits the throw below instead.
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .for('update')
        .then((rows) => rows[0])
      if (!user) throw new NotFoundException('User not found')
      if (user.archivedAt) throw new BadRequestException('User is already archived')
      // Defense-in-depth: ADMIN cannot archive another ADMIN. The controller
      // already blocks self-archive; this guard makes ADMINs mutually
      // indestructible regardless of how the endpoint is called.
      if (user.role === 'ADMIN' && actorId !== null && user.id !== actorId) {
        throw new ForbiddenException('Cannot archive another admin')
      }

      const now = new Date()

      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, id))

      if (user.role === 'SENIOR') {
        // Pair-archive: senior's team + projects. SENIOR's own team_member row is NOT touched.
        //
        // task-archive-pending-modal (AC7/AC9, owner decision 2026-08-19):
        // archiving the team/projects here must NOT touch anyone ELSE's
        // membership — HR/ACCOUNTANT on the team, JUNIOR on the projects stay
        // exactly as they were. `archivedAt` on a TEAM/PROJECT is not the same
        // thing as `archivedAt` on a PERSON: the salary cron
        // (`TransactionsService.createMonthlySalaries`) decides whether to
        // accrue a JUNIOR/HR/ACCOUNTANT their next PENDING salary by reading
        // ONLY their own `users.archivedAt` — never `projects.archivedAt` or
        // `teams.archivedAt` — so leaving `leftAt` untouched here is exactly
        // what keeps their pay flowing, not an oversight. An earlier revision
        // of this cascade DID set `leftAt` on both (see git history) — that
        // was a deliberate removal, not a regression.
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (seniorMembership) {
          const teamId = seniorMembership.teamId
          await tx
            .update(teams)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(teams.id, teamId))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }

        // Archive all of senior's active projects. JUNIOR project_members are
        // left untouched — see the AC9 note above.
        const ownedProjects = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))

        for (const p of ownedProjects) {
          await tx
            .update(projects)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(projects.id, p.id))
          await this.projectAuditLogService.record(
            {
              actorId,
              targetId: p.id,
              action: 'project_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // Set leftAt across all team memberships.
        const memberships = await tx
          .select({ id: teamMembers.id, teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        if (memberships.length > 0) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          for (const m of memberships) {
            await this.teamAuditLogService.record(
              {
                actorId,
                targetId: m.teamId,
                action: 'team_member_removed',
                changes: {
                  userId: { before: id, after: null },
                  role: { before: user.role, after: null },
                },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'JUNIOR') {
        // Detach JUNIOR from all active project memberships.
        // NB: JUNIOR is never persisted in `team_members` — team membership for
        // JUNIORs is derived state (project membership ⇒ implicit team), see
        // CLAUDE.md §Teams. So we deliberately do NOT update team_members here.
        const projectMemberships = await tx
          .select({ id: projectMembers.id, projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
        if (projectMemberships.length > 0) {
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
          for (const pm of projectMemberships) {
            await this.projectAuditLogService.record(
              {
                actorId,
                targetId: pm.projectId,
                action: 'project_member_removed',
                changes: { userId: { before: id, after: null } },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'DROP') {
        // Drop role - phase 1: pair-archive drop + drop-team + drop-projects.
        // Active SENIOR (if any) is detached but NOT archived. Delegated to
        // TeamsService.archiveDropTeam inside the same transaction.
        const dropMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (dropMembership) {
          await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: dropMembership.teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }
      }
      // ADMIN: no dependencies.

      // Final user_audit_log entry.
      await this.auditLogService.record(
        {
          actorId,
          targetId: id,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Restore an archived user. SENIOR restoration is paired with their team —
   * projects remain archived; HR/Acc team_members.leftAt is NOT restored.
   * For HR/Acc/Junior/Admin — only the user row is restored, memberships stay closed.
   */
  async unarchive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      await this.unarchivePairTx(tx, id, actorId)
      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      if (!updated) throw new NotFoundException('User not found')
      return updated
    })
  }

  /**
   * Pair-unarchive primitive that runs ENTIRELY within the caller's transaction.
   * Used by:
   *   - `UsersService.unarchive()` — wraps this in its own tx
   *   - `ProjectsService.unarchive(cascade=true)` — passes its outer tx so the
   *     project unarchive + senior/team unarchive commit atomically (no nested
   *     transactions, no orphaned state if the outer flow throws).
   *
   * IMPORTANT: All mutations and audit log writes use the supplied `tx` — never
   * `this.db.db` — so rollback discards everything together. Caller is
   * responsible for opening the transaction.
   */
  async unarchivePairTx(tx: DrizzleTx, id: string, actorId: string | null = null): Promise<void> {
    const user = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
    if (!user) throw new NotFoundException('User not found')
    if (!user.archivedAt) throw new BadRequestException('User is not archived')

    const now = new Date()
    const previousArchivedAt = user.archivedAt

    await tx.update(users).set({ archivedAt: null, updatedAt: now }).where(eq(users.id, id))

    await this.auditLogService.record(
      {
        actorId,
        targetId: id,
        action: 'user_unarchived',
        changes: { archivedAt: { before: previousArchivedAt?.toISOString() ?? null, after: null } },
      },
      tx,
    )

    if (user.role === 'SENIOR') {
      // Pair-unarchive: also unarchive the team via senior's team_member row.
      // We require `leftAt IS NULL` because senior's own membership is the
      // permanent identity link and stays active even while archived. A row
      // with `leftAt != NULL` would be stale data we shouldn't follow.
      const seniorMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])
      if (seniorMembership) {
        const team = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, seniorMembership.teamId))
          .then((rows) => rows[0])
        if (team?.archivedAt) {
          const teamPreviousArchivedAt = team.archivedAt
          await tx
            .update(teams)
            .set({ archivedAt: null, updatedAt: now })
            .where(eq(teams.id, team.id))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: team.id,
              action: 'team_unarchived',
              changes: {
                archivedAt: { before: teamPreviousArchivedAt.toISOString(), after: null },
              },
            },
            tx,
          )
        }
      }
      // Projects intentionally stay archived (admin re-unarchives them
      // separately, with cascade if needed — see ProjectsService.unarchive).
      // HR/ACCOUNTANT team_members.leftAt was never touched by archive() in
      // the first place (task-archive-pending-modal AC9) — nothing to restore.
    }
  }

  /**
   * task-archive-pending-modal (AC2). Earned-but-unpaid rows addressed to this
   * user that will survive the archive — scope matches AC1 exactly (SALARY /
   * SENIOR_INCOME / DROP_INCOME, `status='PENDING'`). Deliberately excludes
   * the `*_PENDING_PAYMENT` obligation rows — those were never blocked from an
   * archived receiver (AC4), so there is nothing new to warn about there.
   */
  private async getPendingTransactionsForArchiveWarning(
    userId: string,
  ): Promise<ArchivePendingTransaction[]> {
    const rows = await this.db.db
      .select({
        id: transactions.id,
        type: transactions.type,
        salaryMonth: transactions.salaryMonth,
        txDate: transactions.txDate,
        amount: transactions.amount,
        currency: transactions.currency,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.receiverId, userId),
          eq(transactions.status, 'PENDING'),
          inArray(transactions.type, ['SALARY', 'SENIOR_INCOME', 'DROP_INCOME']),
          isNull(transactions.deletedAt),
        ),
      )
    return rows as ArchivePendingTransaction[]
  }

  /**
   * Returns the cascade impact summary the UI shows before the admin confirms archive.
   * Shape varies by role — see ArchiveImpact union in @crm/shared.
   */
  async getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    // security-review PR #584 (round 2, MED-2): this payload now carries
    // salary/income sums (`pendingTransactions`) — mirror the inline RBAC
    // TeamsService/ProjectsService.getArchiveImpact already do, so
    // enforcement on the money-bearing path isn't single-point (controller
    // @Roles only).
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const user = await this.findById(id)
    if (!user) throw new NotFoundException('User not found')

    const pendingTransactions = await this.getPendingTransactionsForArchiveWarning(id)

    if (user.role === 'SENIOR') {
      // Find senior's team via team_members.
      const seniorMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsOnTeam = 0
      if (seniorMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, seniorMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, seniorMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsOnTeam = others.length
      }
      const seniorProjects = await this.db.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))
      const projectIds = seniorProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (projectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName,
        projectsCount: seniorProjects.length,
        projectNames: seniorProjects.map((p) => p.name),
        juniorsAffected,
        hrAccountantsOnTeam,
        pendingTransactions,
      }
    }

    if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
      return { type: 'user', role: user.role, teamsCount: memberships.length, pendingTransactions }
    }

    if (user.role === 'JUNIOR') {
      const memberships = await this.db.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
      return {
        type: 'user',
        role: 'JUNIOR',
        projectsCount: memberships.length,
        pendingTransactions,
      }
    }

    if (user.role === 'DROP') {
      // Drop role - phase 1: archive impact mirrors SENIOR pair behavior.
      // teamName + projectsCount come from the drop's team + drop-projects.
      const dropMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsOnTeam = 0
      if (dropMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, dropMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, dropMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsOnTeam = others.length
      }
      const dropProjects = await this.db.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.dropId, id), isNull(projects.archivedAt)))
      const dropProjectIds = dropProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (dropProjectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(inArray(projectMembers.projectId, dropProjectIds), isNull(projectMembers.leftAt)),
          )
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'DROP',
        isPaired: true,
        teamName,
        projectsCount: dropProjects.length,
        projectNames: dropProjects.map((p) => p.name),
        juniorsAffected,
        hrAccountantsOnTeam,
        pendingTransactions,
      }
    }

    // ADMIN
    return { type: 'user', role: 'ADMIN', noDependencies: true, pendingTransactions }
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
    if (!user) throw new NotFoundException('User not found')

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

  /**
   * `actorImpersonatorId` (security-review round 2, authz-hardening):
   * `viewer` is a DB row (no `impersonatorId` — that field only ever lives
   * on the JWT), so unlike the other `SessionUser`-scoped fixes in this
   * file, correcting the `requisites_read` audit attribution below needs it
   * threaded in explicitly from the controller's `currentUser.impersonatorId`.
   * Optional — both real callers (getMe/getProfile in UsersController) pass
   * it; omitted call sites just fall back to `viewer.id` (unchanged
   * pre-fix behavior).
   */
  async buildProfileView(viewer: User, targetId: string, actorImpersonatorId?: string) {
    const target = await this.findById(targetId)
    if (!target) throw new NotFoundException('User not found')
    const permissions = await this.accessService.getViewPermissions(viewer, target)

    // Empty tabs means the viewer has no access to this profile at all.
    // Mirror the guard pattern used in GET /:id/team — throw 403 before
    // leaking any user fields (displayName, email, phone, telegram, avatarUrl).
    // Rationale: isSelf always produces non-empty tabs; ADMIN always has tabs;
    // HR has tabs for users in their team; ACCOUNTANT has tabs for all.
    // The only case of empty tabs is e.g. SENIOR viewing a JUNIOR — Broken
    // Access Control (OWASP A01) if we return 200 + personal data here.
    if (permissions.tabs.length === 0) {
      throw new ForbiddenException()
    }

    // §4.4: personal address lives in user_emails, not on `target` — fetch
    // it only when the viewer may actually see it. security-review PR #623
    // (SR-M-4): gated on `fields.personalContact`, NOT `fields.realContacts`
    // — the two used to be the same flag, which meant HR (realContacts=true
    // for a teammate) could VIEW a personalEmail that HR is deliberately
    // barred from ever SETTING (UsersController.createUser forces it null
    // for an HR actor). Same sensitivity boundary now enforced in both
    // places — see users-access.service.ts's `personalContact` comment.
    const personalEmailRow = permissions.fields.personalContact
      ? await this.db.db.query.userEmails.findFirst({
          // Stryker disable next-line StringLiteral: `kind: 'PERSONAL'` is a literal inside a Drizzle query-builder `where` clause a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md) — the PERSONAL-vs-WORK distinction it encodes is exercised end-to-end against real Postgres by user-emails-uniqueness.integration.spec.ts, which asserts `personalRow?.kind === 'PERSONAL'` on an actual inserted row.
          where: and(eq(userEmails.userId, target.id), eq(userEmails.kind, 'PERSONAL')),
        })
      : undefined

    // ---------------------------------------------------------------------------
    // Build filteredUser with explicit allow-list projection (OWASP A01 guard).
    //
    // IMPORTANT: use an explicit field list rather than `{ ...target }` so that
    // future DB columns do NOT leak automatically before a permissions gate is
    // added. Add new sensitive fields here AND in getViewPermissions flags.
    //
    // Field visibility matrix (viewer → target):
    //   email / phone / telegram (realContacts) — hidden when fields.realContacts=false
    //     (e.g. JUNIOR viewing SENIOR/DROP: legend persona boundary)
    //   adminNote                               — ADMIN only (fields.adminNote), never self
    //   registrationAddress (fopPii)            — ADMIN + self (fields.fopPii)
    //   legalFullName                           — ADMIN + self (fields.legalName)
    //   monthlySalary                           — fields.salary
    //   seniorSharePercent / dropSharePercent   — fields.share
    //   paymentMethod / wallet* / bankUah*      — fields.requisites
    //   techStack                               — fields.techStack
    //   displayName, avatarUrl, avatarDocumentId, role, id — always present
    // ---------------------------------------------------------------------------
    // FilteredUser extends User but allows email to be null when realContacts
    // is masked (e.g. JUNIOR viewing SENIOR). The DB type is string (NOT NULL)
    // but the API contract intentionally redacts it at this layer.
    // SEC-09: exclude googleId — Google's internal identifier is not part of the
    // profile API contract and should not be returned to any caller. The field
    // is used only for OAuth callback flow (updateGoogleId), never for display.
    type FilteredUser = Omit<User, 'email' | 'googleId'> & {
      email: string | null
      personalEmail: string | null
      personalEmailCanLogin: boolean | null
      personalContactVisible: boolean
    }
    const filteredUser: FilteredUser = {
      // Always-safe identity fields (persona display, never masked)
      id: target.id,
      displayName: target.displayName,
      role: target.role,
      avatarUrl: target.avatarUrl,
      avatarDocumentId: target.avatarDocumentId,
      archivedAt: target.archivedAt,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,

      // Real contacts — hidden from JUNIOR viewing SENIOR/DROP (legend boundary)
      email: permissions.fields.realContacts ? target.email : null,
      phone: permissions.fields.realContacts ? (target.phone ?? null) : null,
      telegram: permissions.fields.realContacts ? (target.telegram ?? null) : null,
      // §4.4 — same realContacts gate as email/phone/telegram above.
      // SR-M-4 — same `personalContact` gate as the fetch above.
      personalEmail: permissions.fields.personalContact ? (personalEmailRow?.email ?? null) : null,
      // task-user-emails-invite: lets the frontend tell "no personal address
      // set" (null) apart from "set, invite not yet accepted" (false) apart
      // from "accepted, works as a login" (true) — drives the ADMIN-only
      // "resend invite" action (AdminActionsMenu) and the profile-header
      // status badge. Same gate as personalEmail itself — never surfaced to
      // a viewer who cannot see the address in the first place.
      personalEmailCanLogin: permissions.fields.personalContact
        ? (personalEmailRow?.canLogin ?? null)
        : null,
      // UX-M-1 (design-gate audit, PR #623): WITHOUT this flag, "no access
      // to this field" and "field is genuinely empty" were the exact same
      // wire value (`null`) — a viewer with real access (e.g. an ADMIN
      // looking at a user who simply never got a personal address) could
      // not be told apart, over the API, from a viewer who is masked from
      // seeing it at all (e.g. ACCOUNTANT, or HR outside their own team).
      // `personalEmail`/`personalEmailCanLogin` being `null` is ONLY
      // meaningful "not set" once THIS is `true` — a consumer must check it
      // FIRST. Mirrors `permissions.fields.personalContact` exactly (it IS
      // that flag, just also shipped on the DTO the frontend actually
      // reads — `permissions.fields` is a `Record<string, boolean>` the
      // frontend does consult elsewhere, but naming the specific field here
      // makes the contract explicit rather than requiring every consumer to
      // know `personalContact` is the flag that governs these two).
      personalContactVisible: permissions.fields.personalContact ?? false,

      // Admin-only internal note (never visible to subject or non-ADMIN)
      adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,

      // FOP PII: registrationAddress — ADMIN + self only
      registrationAddress: permissions.fields.fopPii ? (target.registrationAddress ?? null) : null,

      // Passport PII — ADMIN + self only
      legalFullName: permissions.fields.legalName ? (target.legalFullName ?? null) : null,

      // Financial fields — gated by role-based flags
      monthlySalary: permissions.fields.salary ? target.monthlySalary : null,
      salaryCurrency: permissions.fields.salary ? (target.salaryCurrency ?? null) : null,
      seniorSharePercent: permissions.fields.share ? target.seniorSharePercent : 0,
      // Drop role - phase 1: also mask dropSharePercent for non-privileged viewers
      dropSharePercent: permissions.fields.share ? (target.dropSharePercent ?? null) : null,

      // Tech stack
      techStack: permissions.fields.techStack ? (target.techStack ?? null) : null,

      // Payment requisites.
      // `requisitesExcludeWallet` (pre-deploy MEDIUM): an ACCOUNTANT viewing an
      // ADMIN gets the requisites surface EXCEPT the payout destination
      // (wallet/IBAN/recipient/RNOKPP/bank) — admins are not on payroll, so the
      // accountant has no business need for another admin's payout details.
      // `paymentMethod` (the method type, no destination) stays visible.
      paymentMethod: permissions.fields.requisites ? (target.paymentMethod ?? null) : null,
      walletUsdtErc20:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.walletUsdtErc20 ?? null)
          : null,
      walletUsdtLabel:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.walletUsdtLabel ?? null)
          : null,
      bankUahRecipient:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahRecipient ?? null)
          : null,
      bankUahIban:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahIban ?? null)
          : null,
      bankUahRnokpp:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahRnokpp ?? null)
          : null,
      bankUahBankName:
        permissions.fields.requisites && !permissions.fields.requisitesExcludeWallet
          ? (target.bankUahBankName ?? null)
          : null,
    }

    const data: Record<string, unknown> = {}
    if (permissions.tabs.includes('overview')) {
      // ToS acceptance — visible to ADMIN or self (except JUNIOR self: data-privacy,
      // task-junior-ut-round3 §6b). JUNIOR sees their own overview tab but does NOT
      // get tosAcceptedAt/tosVersion — the onboarding flow already gated them before
      // reaching the hub, so the date is irrelevant and leaks internal audit info.
      const canSeeTos =
        viewer.role === 'ADMIN' || (viewer.id === target.id && viewer.role !== 'JUNIOR')
      const tosAcceptance = canSeeTos
        ? await this.tosService.getLatestAcceptanceForUser(target.id)
        : null

      data.overview = {
        techStack: permissions.fields.techStack ? (target.techStack ?? []) : null,
        // adminNote — gated by the same permission flag as filteredUser.adminNote
        // (ADMIN viewing another user; never self). Keeps both surfaces consistent.
        adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,
        tosAcceptedAt: tosAcceptance?.acceptedAt.toISOString() ?? null,
        tosVersion: tosAcceptance?.tosVersion ?? null,
      }
    }
    // Other tabs (finance, projects, team, interviews, requisites) — wired in later tasks

    // Pre-deploy MEDIUM: read-access audit for the ACCOUNTANT requisites scope.
    // The base audit log only tracked *writes*; an ACCOUNTANT can read the
    // payout requisites (RNOKPP / IBAN / wallet) of any user company-wide for
    // payroll. Record a `requisites_read` event when an accountant (never self)
    // actually receives requisites, so the read is attributable. Values are NOT
    // logged (it is a read of existing data, not a change) — `changes` records
    // only WHICH fields were exposed, with redacted markers, mirroring how the
    // write-audit redacts SENSITIVE_FIELDS.
    if (viewer.role === 'ACCOUNTANT' && viewer.id !== target.id && permissions.fields.requisites) {
      const exposedFields = (
        [
          'paymentMethod',
          'walletUsdtErc20',
          'walletUsdtLabel',
          'bankUahRecipient',
          'bankUahIban',
          'bankUahRnokpp',
          'bankUahBankName',
        ] as const
      ).filter((f) => (filteredUser as Record<string, unknown>)[f] != null)
      if (exposedFields.length > 0) {
        const changes: Record<string, AuditChange> = {}
        for (const f of exposedFields) {
          // Read-audit: record THAT the field was read, never its plaintext value.
          changes[f] = { before: REDACTED_TOKEN, after: REDACTED_TOKEN }
        }
        await this.auditLogService.record({
          actorId: actorImpersonatorId ?? viewer.id,
          targetId: target.id,
          action: 'requisites_read',
          changes,
        })
      }
    }

    return { user: filteredUser, permissions, data }
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

  /**
   * Generates a fresh invite token for a PERSONAL `user_emails` row and
   * writes ONLY its hash (`invite-token.util.ts`'s `hashInviteToken`) —
   * called from `createUser` (inside its existing transaction, right after
   * the PERSONAL row insert) and from `resendPersonalEmailInvite` below.
   * One row per `userEmailId` (schema.ts's unique index) —
   * `onConflictDoUpdate` overwrites in place, which is what makes a resend
   * gate the OLD token (task §5: "новый токен гасит старый"): the old hash
   * stops existing in the DB the instant this runs, not merely
   * "eventually, once it expires".
   *
   * Returns the RAW token — the only moment it ever exists outside this
   * function's stack frame. The caller puts it straight into the invite
   * email link and nowhere else (never logged, never returned over HTTP as
   * JSON — see the two callers).
   */
  private async issuePersonalEmailInviteTx(
    tx: DatabaseService['db'] | DrizzleTx,
    userEmailId: string,
  ): Promise<string> {
    const rawToken = generateInviteToken()
    const tokenHash = hashInviteToken(rawToken)
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS)
    await tx
      .insert(userEmailInvites)
      .values({ userEmailId, tokenHash, expiresAt })
      .onConflictDoUpdate({
        target: userEmailInvites.userEmailId,
        set: { tokenHash, expiresAt, usedAt: null, updatedAt: new Date() },
      })
    return rawToken
  }

  /**
   * ADMIN action (task §5 — "Админ должен уметь выслать приглашение
   * заново"). Regenerates the token for the user's EXISTING PERSONAL row
   * — it does NOT create one. Post-creation, a PERSONAL row can also be
   * REPLACED wholesale (typo fix, address rotation, removal) — see
   * `changePersonalEmail` below, added in security-review PR #623 round 4;
   * this method stays narrowly "reissue the token for the SAME row", not
   * "change the address".
   *
   * Returns the raw token + enough identity for the caller (`UsersController`)
   * to hand off to the mailer.
   *
   * Throws:
   *   - BadRequestException — the user has no PERSONAL row at all (nothing
   *     to resend; the UI only offers this action when one exists, but the
   *     endpoint does not trust that).
   *   - ConflictException — the row already has `canLogin=true`. Resending
   *     an invite for an address that already works as a login method is
   *     not a real action — `acceptPersonalEmailInvite` would happily
   *     overwrite `canLogin=true` with `canLogin=true` again, so this
   *     guard is not a safety net against a broken accept flow, only
   *     against generating a token that has no reason to ever be used and
   *     would confuse an audit trail.
   */
  async resendPersonalEmailInvite(
    userId: string,
    actorId: string,
  ): Promise<{ rawToken: string; email: string; displayName: string }> {
    const target = await this.findById(userId)
    if (!target) throw new NotFoundException('Пользователь не найден')
    const row = await this.db.db.query.userEmails.findFirst({
      // Stryker disable next-line StringLiteral: same class as buildProfileView's identical suppression above — `kind: 'PERSONAL'` inside a Drizzle `where` a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md); exercised end-to-end against real Postgres by user-email-invites.integration.spec.ts, which seeds a PERSONAL row and resends against it.
      where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')),
    })
    if (!row) throw new BadRequestException('У пользователя не задан личный email')
    if (row.canLogin) {
      throw new ConflictException(
        'Личный email уже подтверждён — повторное приглашение не требуется',
      )
    }
    const rawToken = await this.issuePersonalEmailInviteTx(this.db.db, row.id)
    // security-review PR #623 round 4 (SR-M-12): this was the only write
    // endpoint on UsersController with no audit trail — reissues a
    // credential AND sends mail, both auditable elsewhere in this file.
    // Written directly (not via the `@AuditLog` decorator): the decorator's
    // automatic before/after diff (`AuditInterceptor`) compares the `users`
    // TABLE row — a resend touches `user_email_invites` only, which the
    // diff never sees, so decorating the controller method alone would
    // silently record nothing.
    await this.auditLogService.record({
      actorId,
      targetId: userId,
      action: 'personal_email_invite_resend',
      changes: { personalEmailInvite: { before: REDACTED_TOKEN, after: REDACTED_TOKEN } },
    })
    return { rawToken, email: row.email, displayName: target.displayName }
  }

  /**
   * ADMIN action (security-review PR #623 round 4, owner decision — see
   * `changePersonalEmailSchema`'s doc, `@crm/shared`). Replaces whatever
   * PERSONAL row the user currently has (if any) with a fresh one, or
   * removes it entirely when `newEmail` is `null`.
   *
   * This is NOT an update-in-place: the OLD row is DELETED, not edited —
   * `ON DELETE CASCADE` (schema.ts, `userEmailInvites`) means its invite row
   * goes with it, and a brand-new row starts at the column defaults
   * (`canLogin=false`, `verifiedAt=null`, `googleId=null`). That is what
   * makes the revocation unconditional and immediate: there is no code path
   * that could leave a `canLogin=true` copy of the OLD address behind — the
   * row that carried that flag no longer exists the instant this
   * transaction commits, regardless of what state it was in a moment
   * before (never invited, invited-not-accepted, or already accepted and
   * logging in daily all take the exact same path here).
   *
   * A resubmit of the SAME address (byte-identical to the current PERSONAL
   * row, including "still unset") is a no-op — it does not delete-then-
   * reissue, so it cannot needlessly revoke a working login or burn an
   * unopened invite the admin never meant to touch.
   *
   * Returns the same shape `resendPersonalEmailInvite` does when a new
   * address was set (so the controller can reuse the identical "send the
   * invite mail" call) — `null` when the call was a pure removal
   * (`newEmail === null`) or a no-op, neither of which has anything to email.
   *
   * Throws:
   *   - NotFoundException — no such user.
   *   - BadRequestException — `newEmail` collides with the user's OWN work
   *     address (case-insensitive) — same rule `createUserSchema.superRefine`
   *     enforces at creation time; this endpoint has no sibling `email`
   *     field in its payload to check against, so the check lives here.
   *   - ConflictException — `newEmail` is already in use by ANY OTHER row
   *     in `user_emails` (`assertEmailAvailable`) — the same §4.4
   *     structural guarantee every other writer of this table honours.
   */
  async changePersonalEmail(
    userId: string,
    newEmail: string | null,
    actorId: string,
  ): Promise<{ rawToken: string; email: string; displayName: string } | null> {
    const target = await this.findById(userId)
    if (!target) throw new NotFoundException('Пользователь не найден')

    const existingRow = await this.db.db.query.userEmails.findFirst({
      // Stryker disable next-line StringLiteral: same class as resendPersonalEmailInvite's identical suppression above — `kind: 'PERSONAL'` inside a Drizzle `where` a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md); exercised end-to-end against real Postgres by user-email-invites.integration.spec.ts.
      where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')),
    })

    // No-op: resubmitting the exact current value (incl. "still unset") —
    // see the method doc for why this must NOT go through delete+reissue.
    if ((existingRow?.email ?? null) === newEmail) return null

    if (newEmail) {
      if (newEmail.toLowerCase() === target.email.toLowerCase()) {
        throw new BadRequestException('Личный email должен отличаться от рабочего')
      }
      await this.assertEmailAvailable(this.db.db, newEmail)
    }

    let personalInviteToken: string | undefined

    await this.db.db.transaction(async (tx) => {
      if (existingRow) {
        // Cascades to the invite row (schema.ts, ON DELETE CASCADE) — the
        // OLD token, wherever it is, stops matching anything the instant
        // this commits, same guarantee a resend already gives the token
        // itself (issuePersonalEmailInviteTx's onConflictDoUpdate).
        await tx.delete(userEmails).where(eq(userEmails.id, existingRow.id))
      }
      if (newEmail) {
        const rows = await this.writeUserEmailOrConflict(() =>
          tx.insert(userEmails).values({ userId, email: newEmail, kind: 'PERSONAL' }).returning(),
        )
        const row = rows[0]
        if (row) {
          personalInviteToken = await this.issuePersonalEmailInviteTx(tx, row.id)
        }
      }
    })

    // PII-redacted, mirrors AuditLogService.diff()'s SENSITIVE_FIELDS
    // treatment of `email`: record THAT the address changed, never to what.
    await this.auditLogService.record({
      actorId,
      targetId: userId,
      action: 'personal_email_changed',
      changes: { personalEmail: { before: REDACTED_TOKEN, after: REDACTED_TOKEN } },
    })

    if (newEmail && personalInviteToken) {
      return { rawToken: personalInviteToken, email: newEmail, displayName: target.displayName }
    }
    return null
  }

  /**
   * The accept half of the invite flow (task §2 — "Точка приёма"). Called
   * from `AuthController.googleCallback`'s invite branch AFTER Google has
   * already confirmed `googleEmail`/`googleId` for whoever is currently in
   * the browser — this method's only job is to check that ALREADY-
   * CONFIRMED identity against the token; it never talks to Google itself
   * and never mints a session (task §2: "Токен НЕ выдаёт сессию").
   *
   * Throws — `AuthController.mapInviteAcceptError` maps each to a distinct
   * `?error=` redirect:
   *   - NotFoundException — token hash matches no row (garbage link, or a
   *     token that was superseded by a resend — the OLD hash is gone from
   *     the DB the moment `issuePersonalEmailInviteTx` overwrites it, so
   *     this is indistinguishable from "never existed", which is correct:
   *     an old, superseded link should behave exactly like a bad one).
   *   - BadRequestException — token expired.
   *   - ConflictException — either the token was already used (task:
   *     "Токен использован дважды — второй раз отказ"), OR (LOW-1,
   *     security-review PR #623 round 4) the confirming Google account is
   *     already bound to a DIFFERENT `user_emails` row
   *     (`idx_user_emails_google_id`) — these are DIFFERENT situations
   *     (the second one leaves `used_at` NULL, since the whole transaction
   *     below rolls back) and get DIFFERENT messages via the exported
   *     `GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE` sentinel —
   *     `mapInviteAcceptError` inspects it to pick `invite_account_taken`
   *     instead of `invite_used`.
   *   - ForbiddenException — either Google confirmed a DIFFERENT address
   *     than the one this token was issued for (task §2: "Не совпал —
   *     внятный отказ, а не тихое ничего"; `canLogin` is left untouched —
   *     an opportunistic wrong-Google-account attempt against a stolen or
   *     guessed link gets no second, better-informed try), OR (LOW-2,
   *     security-review PR #623 round 4) the target account was archived
   *     (fired) after the invite was issued — `INVITE_TARGET_ARCHIVED_MESSAGE`
   *     sentinel, mapped to `account_disabled` (the SAME code the ordinary
   *     login path already uses for a fired user).
   *
   * On success: ONE transaction marks the invite used AND flips
   * `canLogin`/`verifiedAt`/`googleId` on the `user_emails` row — either
   * both happen or neither does. A token that shows as "used" but never
   * actually opened the door (or the reverse) is a locked-out user with no
   * way to self-recover short of an admin resend.
   */
  async acceptPersonalEmailInvite(
    rawToken: string,
    googleEmail: string,
    googleId: string,
  ): Promise<void> {
    const tokenHash = hashInviteToken(rawToken)
    const invite = await this.db.db.query.userEmailInvites.findFirst({
      where: eq(userEmailInvites.tokenHash, tokenHash),
    })
    if (!invite) throw new NotFoundException('Приглашение недействительно')
    if (invite.usedAt) throw new ConflictException('Приглашение уже использовано')
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Срок действия приглашения истёк')
    }
    const row = await this.db.db.query.userEmails.findFirst({
      where: eq(userEmails.id, invite.userEmailId),
    })
    // Defensive only — `ON DELETE CASCADE` (schema.ts) means an invite row
    // cannot outlive the user_emails row it points at; unreachable via any
    // real flow.
    if (!row) throw new NotFoundException('Приглашение недействительно')
    if (row.email.toLowerCase() !== googleEmail.toLowerCase()) {
      throw new ForbiddenException('Адрес аккаунта Google не совпадает с приглашённым адресом')
    }
    // LOW-2 (security-review PR #623 round 4): checked AFTER the address
    // match above, deliberately — only someone who already controls the
    // invited mailbox (proven by the check above) learns that the target
    // account is archived; a mismatched-account prober does not.
    const owner = await this.findById(row.userId)
    if (owner?.archivedAt) {
      throw new ForbiddenException(INVITE_TARGET_ARCHIVED_MESSAGE)
    }

    await this.db.db.transaction(async (tx) => {
      await tx
        .update(userEmailInvites)
        .set({ usedAt: new Date(), updatedAt: new Date() })
        .where(eq(userEmailInvites.id, invite.id))
      try {
        await tx
          .update(userEmails)
          .set({ canLogin: true, verifiedAt: new Date(), googleId, updatedAt: new Date() })
          .where(eq(userEmails.id, row.id))
      } catch (err) {
        // LOW-1 (security-review PR #623 round 4): distinguish WHICH unique
        // index tripped — `pg-errors.ts`'s own doc warns against a blanket
        // catch reporting a message unrelated to what actually collided.
        // The only unique index this UPDATE can hit is
        // `idx_user_emails_google_id` (it never touches `email`), so a
        // constraint name we do not recognise is a genuine surprise and
        // rethrown as-is rather than mislabelled.
        const constraint = uniqueViolationConstraint(err)
        if (constraint === 'idx_user_emails_google_id') {
          throw new ConflictException(GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE)
        }
        throw err
      }
    })
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
  async createDrop(
    data: {
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
    },
    actor: SessionUser,
  ): Promise<{ user: User; teamId: string }> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Создание дропа доступно только администратору')
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
      throw new BadRequestException('HR обязателен (минимум 1)')
    }
    const existing = await this.findByEmail(data.email)
    if (existing) throw new ConflictException('Пользователь с таким email уже существует')
    // §4.4 — see createUser's identical check for the full rationale.
    await this.assertEmailAvailable(this.db.db, data.email)

    return this.db.db.transaction(async (tx) => {
      const insertValues: typeof users.$inferInsert = {
        email: data.email,
        displayName: data.displayName,
        role: 'DROP',
        telegram: data.telegram ?? null,
        phone: data.phone ?? null,
        // Same rationale as UsersService.createUser — no dicebear placeholder.
        avatarUrl: data.avatarUrl ?? null,
        techStack: data.techStack ?? null,
        dropSharePercent: data.dropSharePercent ?? 5,
      }
      // Contract data — persist the legal ФИО / registration address so the
      // drop's MSA contract renders them (buildContractVariableMap reads both).
      // Trim + only set when non-blank, mirroring createUser.
      if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()
      if (data.registrationAddress?.trim())
        insertValues.registrationAddress = data.registrationAddress.trim()
      if (data.paymentMethod) {
        insertValues.paymentMethod = data.paymentMethod
        if (data.paymentMethod === 'USDT_ERC20') {
          insertValues.walletUsdtErc20 = data.walletUsdtErc20 ?? null
          insertValues.walletUsdtLabel = data.walletUsdtLabel ?? null
        } else {
          insertValues.bankUahRecipient = data.bankUahRecipient ?? null
          insertValues.bankUahIban = data.bankUahIban ?? null
          insertValues.bankUahRnokpp = data.bankUahRnokpp ?? null
          insertValues.bankUahBankName = data.bankUahBankName ?? null
        }
      }

      const rows = await tx.insert(users).values(insertValues).returning()
      const created = rows[0]
      if (!created) throw new Error('Failed to create drop user')

      // §4.4 — see createUser's identical insert for the full rationale.
      // writeUserEmailOrConflict: SR-M-2 — same 23505-to-409 conversion as
      // every other user_emails write in this file.
      await this.writeUserEmailOrConflict(() =>
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

  /**
   * Soft-archive a DROP user with the full cascade:
   *  - Drop-team → archived (HR/Accountant detached).
   *  - Drop-projects → archived (project_members.leftAt set).
   *  - Active SENIOR (if any) → DETACHED from team_members but user row
   *    stays active. Becomes "teamless"; controller layer guards their
   *    sensitive endpoints (interviews → 403, projects → empty).
   *
   * Returns `{ archivedProjects, detachedSeniorId }` for UI confirmation.
   * RBAC: ADMIN only (enforced in controller; defensive guard here).
   */
  async archiveDrop(
    dropId: string,
    actor: SessionUser,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    if (actor.role !== 'ADMIN') {
      throw new ForbiddenException('Архивация дропа доступна только администратору')
    }
    // security-review round 2 (authz-hardening) — see createDrop's identical
    // comment above for the full rationale.
    const effectiveActorId = actor.impersonatorId ?? actor.id
    return this.db.db.transaction(async (tx) => {
      // security-review PR #584 round 2 (MED-4): same row-lock rationale as
      // `archive()` above — prevents two concurrent DELETE /users/drops/:id
      // calls on the same drop from both passing the archivedAt check and
      // both running archiveDropTeam's cascade.
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, dropId))
        .for('update')
        .then((rows) => rows[0])
      if (!user) throw new NotFoundException('Пользователь не найден')
      if (user.role !== 'DROP') {
        throw new BadRequestException('Метод доступен только для DROP')
      }
      if (user.archivedAt) throw new BadRequestException('Дроп уже архивирован')

      const dropMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, dropId), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])

      let result = { archivedProjects: 0, detachedSeniorId: null as string | null }
      if (dropMembership) {
        result = await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
      }

      const now = new Date()
      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, dropId))

      await this.auditLogService.record(
        {
          actorId: effectiveActorId,
          targetId: dropId,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      return result
    })
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
    if (!user) throw new NotFoundException('Пользователь не найден')
    if (user.role !== 'SENIOR') {
      throw new BadRequestException('Rejoin-team доступен только для SENIOR')
    }
    // Caller must currently have NO active team membership.
    const activeMembership = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (activeMembership) {
      throw new BadRequestException('У вас уже есть активная команда')
    }

    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (!data.dropTeamId) {
        throw new BadRequestException('dropTeamId обязателен при teamMode=JOIN_DROP_TEAM')
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
        throw new ForbiddenException(
          'Самостоятельно присоединиться можно только к команде, в которой вы уже состояли',
        )
      }
      await this.teamsService.addSeniorToDropTeam(data.dropTeamId, seniorId)
      return { teamId: data.dropTeamId }
    }

    // CREATE_NEW path — mirrors createUser SENIOR branch.
    if (!data.hrIds || data.hrIds.length < 1) {
      throw new BadRequestException('HR обязателен (минимум 1) при teamMode=CREATE_NEW')
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
