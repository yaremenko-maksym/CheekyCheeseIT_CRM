import { HttpStatus } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { userEmails, type User } from '../database/schema'
import { markUserEditDirty } from '../job-sourcing/dirty-producers'
import type { DrizzleTx } from '../database/types'
import { assertEmailAvailable } from './user-emails.util'
import {
  assertAdminTargetEditableForUpdate,
  assertAssignableRoleOnChange,
  assertSeniorTechFloor,
  techStackChanged,
} from './role-guards.util'
import { buildAdminUserUpdateSet } from './user-update.util'
import { assertAvatarDocument } from './user-avatar.util'
import { updateUserRow } from './user-write.util'

type AppRole = 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'

export interface AdminUpdateUserInput {
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
}

/**
 * Helpers SHARED with other `UsersService` writers (`createUser`, `createDrop`) or owned by sibling
 * collaborators. They stay implemented once and are passed in as bound callbacks.
 */
export interface AdminUserUpdateHelpers {
  upsertWorkEmail(
    db: DatabaseService['db'] | DrizzleTx,
    userId: string,
    email: string,
  ): Promise<void>
  findByEmail(email: string): Promise<User | undefined>
  findById(id: string): Promise<User | undefined>
  proposeSeniorShareChangeInTx(
    tx: DrizzleTx,
    existing: Pick<User, 'id' | 'archivedAt' | 'seniorSharePercent'>,
    requestedPercent: number,
    actorId: string,
  ): Promise<{ pendingSeniorSharePercent: number | null } | null>
  reconcileSeniorTeamTx(
    tx: DrizzleTx,
    seniorId: string,
    data: { hrIds?: string[] | undefined; accountantId?: string | null | undefined },
    actorId: string | null,
  ): Promise<void>
  updateSeniorTeamTelegramChannelTx(
    tx: DrizzleTx,
    seniorId: string,
    value: string | null,
    actorId: string | null,
  ): Promise<void>
}

/**
 * Admin edit of a user (`PATCH /users/:id`), extracted verbatim from `UsersService.adminUpdateUser`.
 * Behavior-preserving leaf move: guard order, the single transaction and its write order
 * (users row -> share proposal -> WORK email -> team reconcile -> telegram channel) are unchanged.
 */
export class AdminUserUpdateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly helpers: AdminUserUpdateHelpers,
  ) {}

  async adminUpdateUser(
    id: string,
    data: AdminUpdateUserInput,
    actorId: string | null = null,
  ): Promise<User> {
    // ut-10/11: ADMIN protection. Fetch the existing row first so we can apply
    // role-aware guards before any UPDATE statement.
    const existing = await this.helpers.findById(id)
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
    // SENIOR technology floor: on a role change TO SENIOR or an actual stack
    // change; an unrelated edit of a legacy SENIOR below the floor still passes.
    const stackChanged = techStackChanged(data.techStack, existing.techStack)
    // (`assertSeniorTechFloor` is a no-op unless `effectiveRole` is SENIOR.)
    if (existing.role !== 'SENIOR' || stackChanged) {
      assertSeniorTechFloor(
        effectiveRole,
        stackChanged ? (data.techStack ?? null) : existing.techStack,
      )
    }
    // Email uniqueness check — only when actually changing it.
    if (data.email !== undefined && data.email !== existing.email) {
      const conflict = await this.helpers.findByEmail(data.email)
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
      const u = await updateUserRow(tx, id, existing, set)
      await markUserEditDirty(tx, id, existing.role, set)

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
        const shareChangeResult = await this.helpers.proposeSeniorShareChangeInTx(
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
        await this.helpers.upsertWorkEmail(tx, u.id, u.email)
      }

      // SENIOR-only: optional team composition reconcile.
      if (u.role === 'SENIOR' && (data.hrIds !== undefined || data.accountantId !== undefined)) {
        await this.helpers.reconcileSeniorTeamTx(
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
        await this.helpers.updateSeniorTeamTelegramChannelTx(
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
}
