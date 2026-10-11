import { ConflictException, ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { resolveLocale, type Locale } from '@crm/shared'
import { apiError } from '../common/api-error'
import { userEmailInvites, userEmails } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { uniqueViolationConstraint } from '../database/pg-errors'
import type { DrizzleTx } from '../database/types'
import { AuditLogService, REDACTED_TOKEN } from './audit-log.service'
import { generateInviteToken, hashInviteToken, INVITE_TOKEN_TTL_MS } from './invite-token.util'
import { assertEmailAvailable, writeUserEmailOrConflict } from './user-emails.util'
import { loadUserById } from './user-read.util'

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
  'Цей обліковий запис Google уже прив’язано до іншої адреси в системі'

/**
 * LOW-2 (security-review PR #623 round 4): sentinel `ForbiddenException`
 * message `acceptPersonalEmailInvite` throws when the invited address's
 * OWNING user was archived (fired) after the invite was issued — distinct
 * from "wrong Google account" (same exception TYPE, different message).
 * `AuthController.mapInviteAcceptError` maps this to `account_disabled`,
 * the SAME `?error=` code the ordinary login path already uses for a fired
 * user (`login.tsx`'s `ERROR_MESSAGES`).
 */
export const INVITE_TARGET_ARCHIVED_MESSAGE = 'Обліковий запис звільнено — запрошення недійсне'

/**
 * Personal-email invite flow (issue / resend / change / accept). Reads users via
 * `loadUserById` rather than `UsersService`, so there is no dependency cycle.
 * The two transactions that write both `user_emails` and `user_email_invites`
 * (`changePersonalEmail`, `acceptPersonalEmailInvite`) keep the SR-H-5 lock
 * order: `user_emails` first, `user_email_invites` second.
 */
@Injectable()
export class PersonalEmailInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditLogService: AuditLogService,
  ) {}

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
  async issuePersonalEmailInviteTx(
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
  ): Promise<{ rawToken: string; email: string; displayName: string; locale: Locale }> {
    const target = await loadUserById(this.db.db, userId)
    if (!target) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    const row = await this.db.db.query.userEmails.findFirst({
      // Stryker disable next-line StringLiteral: same class as buildProfileView's identical suppression above — `kind: 'PERSONAL'` inside a Drizzle `where` a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md); exercised end-to-end against real Postgres by user-email-invites.integration.spec.ts, which seeds a PERSONAL row and resends against it.
      where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')),
    })
    if (!row) throw apiError('PERSONAL_EMAIL_NOT_SET', HttpStatus.BAD_REQUEST)
    if (row.canLogin) {
      throw apiError('PERSONAL_EMAIL_ALREADY_VERIFIED', HttpStatus.CONFLICT)
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
    return {
      rawToken,
      email: row.email,
      displayName: target.displayName,
      // The INVITEE's stored language (corrupt/absent degrades to `uk`) — the caller renders the
      // mail in it; the admin's request locale is never consulted.
      locale: resolveLocale([target.locale]),
    }
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
  ): Promise<{ rawToken: string; email: string; displayName: string; locale: Locale } | null> {
    const target = await loadUserById(this.db.db, userId)
    if (!target) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    const existingRow = await this.db.db.query.userEmails.findFirst({
      // Stryker disable next-line StringLiteral: same class as resendPersonalEmailInvite's identical suppression above — `kind: 'PERSONAL'` inside a Drizzle `where` a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md); exercised end-to-end against real Postgres by user-email-invites.integration.spec.ts.
      where: and(eq(userEmails.userId, userId), eq(userEmails.kind, 'PERSONAL')),
    })

    // No-op: resubmitting the exact current value (incl. "still unset") —
    // see the method doc for why this must NOT go through delete+reissue.
    if ((existingRow?.email ?? null) === newEmail) return null

    if (newEmail) {
      if (newEmail.toLowerCase() === target.email.toLowerCase()) {
        throw apiError('PERSONAL_EMAIL_MUST_DIFFER_FROM_WORK', HttpStatus.BAD_REQUEST)
      }
      // SR-L-1 (security-review PR #623 round 5): `excludeUserId` — the
      // no-op check above (`existingRow?.email === newEmail`) is a plain,
      // case-SENSITIVE `===`, deliberately (see that check's own comment) —
      // so resubmitting the SAME address in a DIFFERENT case (e.g.
      // `Foo@Bar.com` after `foo@bar.com`) does NOT short-circuit as a
      // no-op and reaches this call. Without `excludeUserId`,
      // `assertEmailAvailable`'s case-INsensitive lookup finds the caller's
      // own existing row and — since `isOwnRow` compares against
      // `undefined` — rejects it as a collision with a misleading 409,
      // even though the only "other" row is the user's own. This does not
      // make the no-op check itself case-insensitive (a re-cased resubmit
      // still goes through delete+reissue, not a true no-op) — it only
      // stops that path from being reported as a conflict with a stranger.
      await assertEmailAvailable(this.db.db, newEmail, userId)
    }

    let personalInviteToken: string | undefined

    // SR-H-5 (security-review PR #623 round 5): lock-ordering invariant —
    // any transaction that writes BOTH `user_emails` AND `user_email_invites`
    // MUST touch `user_emails` FIRST. This transaction already does (delete
    // then insert, both `user_emails`, before the invite insert below) —
    // the invariant lives here as a comment because `acceptPersonalEmailInvite`
    // is the OTHER writer of this same pair and had it backwards (see that
    // method's own copy of this comment for the mechanism and the proof).
    await this.db.db.transaction(async (tx) => {
      if (existingRow) {
        // Cascades to the invite row (schema.ts, ON DELETE CASCADE) — the
        // OLD token, wherever it is, stops matching anything the instant
        // this commits, same guarantee a resend already gives the token
        // itself (issuePersonalEmailInviteTx's onConflictDoUpdate). This
        // DELETE is also where the lock-ordering invariant above matters:
        // the cascade acquires the invite row's lock AFTER this one, so
        // this statement's position (before any `user_email_invites` write
        // in this transaction) is what keeps this side of the pair correct.
        await tx.delete(userEmails).where(eq(userEmails.id, existingRow.id))
      }
      if (newEmail) {
        const rows = await writeUserEmailOrConflict(() =>
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
      return {
        rawToken: personalInviteToken,
        email: newEmail,
        displayName: target.displayName,
        locale: resolveLocale([target.locale]),
      }
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
   * `?error=` redirect. SR-H-1 (security-review PR #701 round 1): the
   * dispatch is by `apiError()`'s envelope `code`, NOT by exception class —
   * `apiError()` returns a plain `HttpException`, never a
   * `ForbiddenException`/`ConflictException`/`BadRequestException`
   * subclass, so an `instanceof` check on those classes cannot tell these
   * apart. The contract below is stated in terms of `code`:
   *   - `INVITE_INVALID` (404) — token hash matches no row (garbage link,
   *     or a token that was superseded by a resend — the OLD hash is gone
   *     from the DB the moment `issuePersonalEmailInviteTx` overwrites it,
   *     so this is indistinguishable from "never existed", which is
   *     correct: an old, superseded link should behave exactly like a bad
   *     one). Also the two defense-in-depth "row vanished mid-transaction"
   *     branches below.
   *   - `INVITE_EXPIRED` (400) — token expired.
   *   - `INVITE_ALREADY_USED` (409) — the token was already used (task:
   *     "Токен использован дважды — второй раз отказ").
   *   - a plain `ConflictException` (NOT `apiError()` — kept as a sentinel,
   *     see `mapInviteAcceptError`'s comment) with the exported
   *     `GOOGLE_ACCOUNT_ALREADY_BOUND_MESSAGE` message — (LOW-1,
   *     security-review PR #623 round 4) the confirming Google account is
   *     already bound to a DIFFERENT `user_emails` row
   *     (`idx_user_emails_google_id`); DIFFERENT situation from
   *     `INVITE_ALREADY_USED` above (this one leaves `used_at` NULL, since
   *     the whole transaction below rolls back) — `mapInviteAcceptError`
   *     inspects the message to pick `invite_account_taken` instead of
   *     `invite_used`.
   *   - `INVITE_GOOGLE_ACCOUNT_MISMATCH` (403) — Google confirmed a
   *     DIFFERENT address than the one this token was issued for (task §2:
   *     "Не совпал — внятный отказ, а не тихое ничего"; `canLogin` is left
   *     untouched — an opportunistic wrong-Google-account attempt against a
   *     stolen or guessed link gets no second, better-informed try).
   *   - a plain `ForbiddenException` (NOT `apiError()` — kept as a
   *     sentinel) with the exported `INVITE_TARGET_ARCHIVED_MESSAGE`
   *     message — (LOW-2, security-review PR #623 round 4) the target
   *     account was archived (fired) after the invite was issued, mapped
   *     to `account_disabled` (the SAME code the ordinary login path
   *     already uses for a fired user).
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
    if (!invite) throw apiError('INVITE_INVALID', HttpStatus.NOT_FOUND)
    if (invite.usedAt) throw apiError('INVITE_ALREADY_USED', HttpStatus.CONFLICT)
    if (invite.expiresAt.getTime() < Date.now()) {
      throw apiError('INVITE_EXPIRED', HttpStatus.BAD_REQUEST)
    }
    const row = await this.db.db.query.userEmails.findFirst({
      where: eq(userEmails.id, invite.userEmailId),
    })
    // Defensive only — `ON DELETE CASCADE` (schema.ts) means an invite row
    // cannot outlive the user_emails row it points at; unreachable via any
    // real flow.
    if (!row) throw apiError('INVITE_INVALID', HttpStatus.NOT_FOUND)
    if (row.email.toLowerCase() !== googleEmail.toLowerCase()) {
      throw apiError('INVITE_GOOGLE_ACCOUNT_MISMATCH', HttpStatus.FORBIDDEN)
    }
    // LOW-2 (security-review PR #623 round 4): checked AFTER the address
    // match above, deliberately — only someone who already controls the
    // invited mailbox (proven by the check above) learns that the target
    // account is archived; a mismatched-account prober does not.
    const owner = await loadUserById(this.db.db, row.userId)
    if (owner?.archivedAt) {
      throw new ForbiddenException(INVITE_TARGET_ARCHIVED_MESSAGE)
    }

    // SR-H-5 (security-review PR #623 round 5): lock-ordering invariant —
    // any transaction writing BOTH `user_emails` AND `user_email_invites`
    // MUST touch `user_emails` FIRST, `user_email_invites` second. This was
    // backwards here (invite-then-email) while `changePersonalEmail`'s
    // transaction (the OTHER writer of this same pair — see its own copy of
    // this comment) already went email-then-invite: `changePersonalEmail`'s
    // DELETE on `user_emails` cascades (ON DELETE CASCADE, schema.ts) into a
    // lock on `user_email_invites` SECOND, so the two transactions raced
    // with OPPOSITE lock orders — a textbook ABBA deadlock. Postgres does
    // not queue the two orders against each other, it detects the cycle and
    // kills one side with `40P01`; measured on the pre-fix code, real
    // Postgres, 40 concurrent (accept, change) pairs: 8/40 killed the
    // ADMIN's `changePersonalEmail` transaction while the attacker's accept
    // committed — the exact wrong-side-loses outcome this ordering removes
    // (proof: `user-email-invites.integration.spec.ts`, "SR-H-5" describe
    // block, `leaks=0/40` after this fix vs `leaks=8/40` before). This is
    // the SAME class of bug `lockCascadeRows` (transactions.service.ts)
    // already had to fix once for a single table's own rows via
    // `ORDER BY id` — here the fix is the analogous discipline across TWO
    // tables: a FIXED, documented, cross-file write order, not a decision
    // that lives in only one of the two call sites.
    await this.db.db.transaction(async (tx) => {
      let emailRows: { id: string }[]
      try {
        emailRows = await tx
          .update(userEmails)
          .set({ canLogin: true, verifiedAt: new Date(), googleId, updatedAt: new Date() })
          .where(eq(userEmails.id, row.id))
          .returning({ id: userEmails.id })
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
      // SR-L-3 (security-review PR #623 round 5): the `invite`/`row` reads
      // above happen BEFORE this transaction opens — a concurrent
      // `changePersonalEmail` can delete `row` (and cascade-delete `invite`
      // with it) in the gap between that read and this UPDATE. An UPDATE
      // matching zero rows is not a Postgres error, so without this check
      // the transaction would COMMIT having changed nothing, and the
      // caller (`AuthController.googleCallback`'s invite branch) would
      // report success — a user is told "готово" for an accept that never
      // actually happened. `.returning()` is what makes the zero-rows case
      // observable at all; reported as the SAME "invalid" outcome a
      // garbage/superseded token already gets (`mapInviteAcceptError` maps
      // any `NotFoundException` to `invite_invalid`), since from the
      // caller's perspective it IS the same situation: the row this token
      // pointed at no longer exists.
      if (!emailRows[0]) {
        throw apiError('INVITE_INVALID', HttpStatus.NOT_FOUND)
      }
      const inviteRows = await tx
        .update(userEmailInvites)
        .set({ usedAt: new Date(), updatedAt: new Date() })
        .where(eq(userEmailInvites.id, invite.id))
        .returning({ id: userEmailInvites.id })
      // SR-L-3, second half: the lock-ordering fix above means `user_emails`
      // is always updated first, so in practice a raced deletion is already
      // caught above (cascade removes BOTH rows atomically) — this second
      // check exists for defense in depth, not because a real path reaches
      // it: e.g. a future writer of `user_email_invites` alone (not
      // through `changePersonalEmail`) would only be caught here.
      if (!inviteRows[0]) {
        throw apiError('INVITE_INVALID', HttpStatus.NOT_FOUND)
      }
    })
  }
}
