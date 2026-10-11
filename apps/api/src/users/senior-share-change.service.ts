import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { NOTIFICATION_TITLES, type SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { users, type User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { ApprovalsService } from '../approvals/approvals.service'
import { NotificationsService } from '../notifications/notifications.service'
import { ARCHIVED_ENTITLEMENT_CODE, changedEntitlementFields } from './archived-entitlement'
import { loadUserById } from './user-read.util'
import { updateUserRow } from './user-write.util'
import { UserProfileService, SENIOR_SHARE_SUBJECT_TYPE } from './user-profile.service'

// task-pending-share (position 5). Pulled out of `notifyPendingSeniorShareProposed`'s
// own signature so that method fits on one line — see that method's doc
// comment for why (a Stryker disable-comment / multi-line-inline-type
// interaction).
type NotifyPendingShareInput = {
  subjectId: string
  approverUserId: string
  proposedPercent: number
  previousPercent: number
  /**
   * QA-H-1 (manual-qa круг 3, #664): строка `approvals`, которую это
   * уведомление и представляет. Берётся из возврата
   * `ApprovalsService.proposeInTx` — то есть это ИМЕННО та строка, что
   * открылась сейчас, а не «согласование по такому-то объекту вообще».
   * Повторное предложение открывает новое поколение строк, и без этого
   * идентификатора старое уведомление оставалось активным рядом с новым.
   */
  approvalId: string
}

/**
 * Base senior-share change flow (propose / approve / reject / cancel) for a
 * user's own `seniorSharePercent`. Lock order is `users` BEFORE `approvals` in
 * every path, same as the `ProjectsService` twin.
 */
@Injectable()
export class SeniorShareChangeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
    private readonly profile: UserProfileService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * «Ждёт решения: новая доля» для БАЗОВОЙ доли — тому, чья доля меняется, и
   * никому больше. Близнец `ProjectsService.notifyPendingSeniorShareProposed`;
   * различие ровно одно и содержательное: там `scope: 'PROJECT'` с названием
   * проекта, здесь `scope: 'BASE'` — «базовая доля», у которой проекта нет.
   *
   * Позиция 5 оставила шов пустым и Stryker-подавленным (типа уведомления ещё
   * не существовало); позиция 6 его заполняет, подавление снято. Подпись
   * получила `tx` и стала асинхронной — запись пишется в той же транзакции,
   * что и предложение. Спека-хендофф `users.pending-share.spec.ts` обновлена.
   */
  async notifyPendingSeniorShareProposed(
    tx: DrizzleTx,
    input: NotifyPendingShareInput,
  ): Promise<void> {
    // SR-H-2 (security-review круг 2): путь производителя целиком — во
    // ВЛОЖЕННОЙ транзакции (SAVEPOINT). Событие уже состоялось; уронить его
    // из-за того, что уведомление о нём не собралось, — ровно то вето, которое
    // круг 2 запретил. Откат события по-прежнему уносит и запись: savepoint
    // вложен в транзакцию события, а не заменяет её.
    await this.notifications.emitInTx(tx, async (sp) => {
      await this.notifications.createInTx(sp, {
        userId: input.approverUserId,
        type: 'SHARE_CONFIRM_REQUIRED',
        title: NOTIFICATION_TITLES.SHARE_CONFIRM_REQUIRED,
        subjectType: 'USER',
        subjectId: input.subjectId,
        data: {
          scope: 'BASE',
          projectName: null,
          previousPercent: input.previousPercent,
          proposedPercent: input.proposedPercent,
          approvalId: input.approvalId,
        },
        // Ключа нет намеренно — см. близнеца в `ProjectsService`.
      })
    })
  }

  /**
   * task-pending-share (position 5, design spec §4.3). Intercepts a
   * requested `seniorSharePercent` change BEFORE it would reach `set` /
   * `updateUserRow`: the base share is one of the two levels that require
   * the affected SENIOR's own confirmation (task file "На каких уровнях" —
   * the TEAM override is the excluded third level and stays immediate,
   * unaffected by this method).
   *
   * Never writes `seniorSharePercent` itself — only `pendingSeniorSharePercent`
   * (until `approveSeniorShareChange` swaps them). No-ops when the requested
   * value equals the CURRENT active one (reuses `changedEntitlementFields` —
   * the exact same "actual change, not mere presence" rule `updateUserRow`
   * already applies to every other entitlement column, so resubmitting an
   * unchanged form does not spam a proposal). Reuses
   * `ARCHIVED_ENTITLEMENT_CODE` for the archived-user refusal — an
   * archived senior must not acquire a new entitlement any more than any
   * other entitlement write (archived-entitlement.ts's own module doc).
   *
   * Returns whether a proposal was actually opened — callers that also
   * return the `existing`/`updateUserRow` row to the caller (`adminUpdateUser`)
   * use this to patch `pendingSeniorSharePercent` onto that already-fetched
   * object: `updateUserRow`'s own `.returning()` runs BEFORE this method
   * writes the pending column (same transaction, later statement), so
   * without the patch the HTTP response would echo back a stale
   * `pendingSeniorSharePercent` even though the row IN THE DATABASE is
   * already correct — caught by hand while visually verifying this task
   * against a scratch DB (`adminUpdateUser`'s response showed `null` right
   * after a propose that the DB itself had recorded correctly).
   */
  async proposeSeniorShareChangeInTx(
    tx: DrizzleTx,
    existing: Pick<User, 'id' | 'archivedAt' | 'seniorSharePercent'>,
    requestedPercent: number,
    actorId: string,
  ): Promise<{ pendingSeniorSharePercent: number | null } | null> {
    if (changedEntitlementFields(existing, { seniorSharePercent: requestedPercent }).length === 0) {
      // task-648-fix-round-2 (SR-H-2 / SR-M-5 / QA-HIGH-3): requested ==
      // active is a plain no-op. Round 1 made this branch CANCEL any live
      // proposal ("вернул слайдер к действующему = отмена"); round 2 revokes
      // that decision. An implicit cancel through a side effect is exactly
      // what let an unrelated edit kill a live proposal: `UserDialog` sends
      // `seniorSharePercent` on EVERY save of a SENIOR, so changing a phone
      // number silently flipped a live proposal `PENDING → CANCELLED` with
      // no signal anywhere (reproduced live by manual QA). Withdrawing a
      // proposal is now EXPLICIT only — `cancelSeniorShareChange` behind a
      // named "Отменить предложение" button.
      return null
    }
    if (existing.archivedAt) {
      throw apiError(ARCHIVED_ENTITLEMENT_CODE, HttpStatus.BAD_REQUEST)
    }
    const [approval] = await this.approvals.proposeInTx(tx, {
      subjectType: SENIOR_SHARE_SUBJECT_TYPE,
      subjectId: existing.id,
      approverUserIds: [existing.id],
      proposedByUserId: actorId,
    })
    // Stryker disable next-line all: defensive-only (и условие, и текст сообщения) — `proposeInTx` вставляет по строке на каждого подтверждающего и возвращает `.returning()`; при непустом `approverUserIds` пустой массив на настоящем Postgres невозможен, и ни мок, ни фикстура не построят эту ветку, не соврав про базу.
    if (!approval) throw new Error('Failed to open senior-share approval')
    await tx
      .update(users)
      .set({ pendingSeniorSharePercent: requestedPercent, updatedAt: new Date() })
      .where(eq(users.id, existing.id))
    await this.notifyPendingSeniorShareProposed(tx, {
      subjectId: existing.id,
      approverUserId: existing.id,
      proposedPercent: requestedPercent,
      previousPercent: existing.seniorSharePercent,
      approvalId: approval.id,
    })
    return { pendingSeniorSharePercent: requestedPercent }
  }

  /**
   * task-648-fix-round-1 (SR-H-1). ADMIN withdraws an open base-share
   * proposal outright — the counterpart to the propose path above, and
   * since round 2 (SR-H-2) the ONLY way to withdraw one: the propose path's
   * no-op branch no longer cancels anything.
   *
   * Kept as a transaction-scoped core + public endpoint pair so the lock
   * order below is stated in one place; the public method adds the RBAC gate
   * and the profile-view reload.
   */
  async cancelSeniorShareChangeCore(tx: DrizzleTx, userId: string): Promise<void> {
    // task-648-fix-round-2 (SR-M-6): `users` BEFORE `approvals`, the same
    // order the propose path takes (`updateUserRow` → `proposeInTx`). See
    // the lock-order note on `approveSeniorShareChange` below.
    const [locked] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
      .limit(1)
    if (!locked) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    await this.approvals.cancelInTx(tx, SENIOR_SHARE_SUBJECT_TYPE, userId)
    // Reaching this line means `cancelInTx` found a real PENDING proposal —
    // same "no separate existence check needed" reasoning
    // `approveSeniorShareChange` below documents.
    await tx
      .update(users)
      .set({ pendingSeniorSharePercent: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
  }

  async cancelSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') {
      // task-648-fix-round-1 (COPY-H-1): user-facing text is Russian
      // (russian-language.md) — this exception's message reaches the caller
      // verbatim through `getApiErrorMessage`'s backend-message priority.
      throw apiError('SHARE_CANCEL_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction((tx) => this.cancelSeniorShareChangeCore(tx, id))
    // SR-M-3 (task-648-fix-round-1): route through the allow-list, not a
    // raw row — same reasoning as approve/reject below.
    const viewer = await loadUserById(this.db.db, currentUser.id)
    if (!viewer) throw new ForbiddenException()
    return this.profile.buildProfileView(viewer, id, currentUser.impersonatorId)
  }

  /**
   * task-pending-share, AC3: the pending → active swap happens as ONE
   * operation — `approveInTx` (marks the approval row APPROVED) and the
   * `users` write below run in the SAME transaction, so no caller can ever
   * observe a state where the approval is APPROVED but the active percent
   * has not moved yet (or vice versa). `impersonatorId` guard mirrors
   * `ProjectsService.approveDraft` exactly — consent must come from the
   * invited approver's own session, not an admin impersonating them.
   *
   * Routed through `updateUserRow` (the SAME choke point every other
   * `seniorSharePercent` writer uses) rather than a raw `tx.update(users)` —
   * this is a REAL entitlement move (archived-entitlement.ts's own
   * inventory test enumerates every direct writer and refuses to let a
   * second door open for an entitlement column), and going through it means
   * a senior archived AFTER proposing but BEFORE confirming correctly fails
   * the swap instead of silently minting a new entitlement for someone who
   * no longer works here.
   */
  async approveSeniorShareChange(id: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1) / round-2 (COPY-M-13): the reader
      // seeing this 403 has `ImpersonationBanner`'s «Вы вошли как «X»»
      // across the top of the same screen — same phrasing lives in
      // `SHARE_DECISION_IMPERSONATION` (`packages/shared/src/schemas/api-errors.ts`).
      // task-i18n-stage2-task5: the envelope carries `code`, not this prose —
      // the client re-translates by `code` (`getApiErrorMessage`), so this
      // string is no longer what reaches the browser (the English fallback
      // in the HTTP body is for logs only).
      throw apiError('SHARE_DECISION_IMPERSONATION', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      // task-648-fix-round-2 (SR-M-6): the row lock comes FIRST, before any
      // `approvals` row is touched — see this method's own lock-order note.
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1)
      // task-648-fix-round-1 (COPY-H-1): Russian — same defensive-only
      // reasoning as ProjectsService.approveSeniorShareChange's identical
      // check.
      if (!row) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      await this.approvals.approveInTx(tx, {
        subjectType: SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
      })
      // `row.pendingSeniorSharePercent` is guaranteed non-null here: it is
      // only ever read after `approveInTx` above has already thrown for
      // "no live PENDING row" — reaching this line means a real proposal
      // existed, and a base-share proposal is always a concrete percent
      // (proposeSeniorShareChangeInTx never writes null there).
      await updateUserRow(tx, id, row, {
        seniorSharePercent: row.pendingSeniorSharePercent ?? row.seniorSharePercent,
        pendingSeniorSharePercent: null,
        updatedAt: new Date(),
      })
    })
    // SR-M-3 (task-648-fix-round-1): route through the allow-list DTO
    // (buildProfileView), not the raw `users` row `updateUserRow` returns —
    // approve is called by the SENIOR themselves (self-view), and the raw
    // row includes `adminNote`/`googleId`, neither ever meant to reach a
    // non-admin caller (users-access.service.ts / SEC-09's own inventory).
    const viewer = await loadUserById(this.db.db, currentUser.id)
    if (!viewer) throw new ForbiddenException()
    return this.profile.buildProfileView(viewer, id, currentUser.impersonatorId)
  }

  /**
   * task-pending-share, design spec §3 decision 3: rejection requires a
   * reason (Zod-validated at the controller boundary) and discards the
   * pending value — the active `seniorSharePercent` is untouched, exactly
   * "При отказе ожидающее отбрасывается, действующее не трогается" (task
   * file, "Что сделать" §1).
   */
  async rejectSeniorShareChange(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-648-fix-round-1 (COPY-H-1): same reasoning as approve above.
      // task-i18n-stage2-task5: same code, see approveSeniorShareChange's
      // comment above.
      throw apiError('SHARE_DECISION_IMPERSONATION', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      // task-648-fix-round-2 (SR-M-6): `users` before `approvals` — see the
      // lock-order note on `approveSeniorShareChange` above.
      const [locked] = await tx.select().from(users).where(eq(users.id, id)).for('update').limit(1)
      if (!locked) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      await this.approvals.rejectInTx(tx, {
        subjectType: SENIOR_SHARE_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
        reason,
      })
      const [updated] = await tx
        .update(users)
        .set({ pendingSeniorSharePercent: null, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning()
      // task-648-fix-round-1 (COPY-H-1): Russian — same defensive-only
      // reasoning as approveSeniorShareChange's identical check above.
      if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    })
    // SR-M-3 (task-648-fix-round-1): same allow-list reasoning as
    // approveSeniorShareChange above.
    const viewer = await loadUserById(this.db.db, currentUser.id)
    if (!viewer) throw new ForbiddenException()
    return this.profile.buildProfileView(viewer, id, currentUser.impersonatorId)
  }
}
