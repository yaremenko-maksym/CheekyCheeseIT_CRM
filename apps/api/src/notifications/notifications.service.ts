/**
 * NotificationsService — server-side in-app notifications backing the header
 * bell + dropdown. PHASE 1 had a front-end-only stub; the Invoice Signing
 * Epic upgrades it to a persistent log (`notifications` table) shared across
 * sessions.
 *
 * Surface:
 *   - `create(...)` — single emitter, called by InvoicesService (and future
 *     epics) whenever a user-visible event happens.
 *   - `listForUser(...)` — fetched by the header dropdown on a 30s poll
 *     (WebSockets are deliberately out of scope for v1).
 *   - `markRead` / `markAllRead` — flip `read_at` so the badge count drops.
 *
 * Why a thin service: the table is intentionally schema-flat (no JSON blob,
 * no event-source) so emitters validate against the Zod `notificationType`
 * enum at the boundary instead of reusing a heavier event bus. Adding new
 * notification types only requires appending to the enum + a single emitter
 * call site.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type {
  Notification as NotificationDto,
  NotificationListFilters,
  NotificationSubjectType,
  NotificationType,
  NotificationsListResponse,
} from '@crm/shared'
import { isNewNotificationType, notificationDataSchemaFor } from '@crm/shared'
import { safeNotificationLinkSchema } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { notificationEmails, notifications, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import {
  approvalIdFromData,
  type SubjectRef,
  type SubjectResolution,
} from './notification-subject-resolver'
import { NotificationSubjectStateService } from './notification-subject-state.service'
import { decideEnqueue } from './notification-email-outbox'

/**
 * What the producer puts into the record. §7.1: the event type and the identifiers of
 * objects — NOT ready buttons and NOT ready detail text.
 *
 * `title` remains and is mandatory: it is a NEUTRAL heading without amounts and
 * percentages, one per type (`NOTIFICATION_TITLES`). It is also the only thing that
 * item 7 is entitled to put into the email: the email goes to a personal mailbox outside
 * our perimeter, and figures do not go there (§10).
 */
export type CreateNotificationInput = {
  userId: string
  type: NotificationType
  title: string
  body?: string | null
  link?: string | null
  subjectType?: NotificationSubjectType | null
  subjectId?: string | null
  secondaryId?: string | null
  /** Facts of the event. The shape is defined by `notificationDataSchemaFor(type)`. */
  data?: unknown
  /**
   * Idempotency where the event may repeat (`<TYPE>:<subjectId>`).
   * `undefined` = we do not fear duplicates: a repeated share proposal MUST ask
   * again, and muting it would be a lost confirmation.
   */
  dedupeKey?: string | null
  /**
   * In-app only: no `notification_emails` row is written. For a producer with its own email budget
   * (U5a: at most 3 source-health alert emails per source per Kyiv day) — every other producer
   * leaves this unset and keeps the "a row always exists" invariant. A skipped email leaves no
   * `SKIPPED` row because every `skip_reason` value is a recipient/channel fact, and a budget is not.
   */
  skipEmail?: boolean
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)
  /**
   * Not via a constructor DI parameter on purpose: `NotificationsService`
   * is instantiated by hand (without the Nest container) in a good dozen specs
   * (unit and integration) via `new NotificationsService(db, telemetry)`
   * — a third required parameter would break them all at once, for a service that
   * has no state of its own and must not have a DI lifecycle separate from `db`.
   * `OutboxRepository` builds its own instance the same way, by the same device —
   * one class, two places of creation.
   */
  private readonly subjectStates: NotificationSubjectStateService

  constructor(
    private readonly db: DatabaseService,
    private readonly telemetry: TelemetryErrorsService,
  ) {
    this.subjectStates = new NotificationSubjectStateService(db)
  }

  /**
   * Insert a new notification row. The schema enum is the single source of
   * truth for `type` values; callers should reference the shared
   * `NotificationType` so a typo at the emitter site fails at compile time.
   *
   * Security: link is validated server-side against safeNotificationLinkSchema
   * (relative path only, no '://' or 'javascript:') before insert to prevent
   * storing open-redirect or XSS payloads.
   */
  async create(input: CreateNotificationInput): Promise<NotificationDto | null> {
    return this.db.db.transaction((tx) => this.createInTx(tx, input))
  }

  /**
   * The same code, but INSIDE a transaction that the caller opened. This is exactly
   * what producers rely on: "each producer call happens inside the same transaction
   * as the event, or after its commit with an explicit justification;
   * a notification about an event that did not happen is unacceptable". Inside a transaction this is
   * not discipline but a property: the event rolled back — so did the record.
   *
   * `create()` above is a thin wrapper that opens its own transaction, so that two
   * entry points cannot diverge (the same device as
   * `ApprovalsService.propose` / `proposeInTx`).
   *
   * Returns `null` when the record was absorbed by idempotency — the caller
   * need not know this, but must not claim "created".
   */
  async createInTx(tx: DrizzleTx, input: CreateNotificationInput): Promise<NotificationDto | null> {
    // Validate link server-side before insert (defence-in-depth: shared schema
    // also validates on the DTO layer, but the service is the last gate before DB).
    if (input.link != null) {
      const result = safeNotificationLinkSchema.safeParse(input.link)
      if (!result.success) {
        return this.refuse(
          input,
          // Stryker disable next-line OptionalChaining: issues[0] always exists on a failed parse — the mutant is unobservable
          `Invalid notification link: ${result.error.issues[0]?.message ?? 'invalid'}`,
        )
      }
    }

    // The data is parsed against the shape of ITS OWN type right here — the last line before
    // the database, just as with the link above. A client that meets unparseable data
    // will show the generic view (AC2) and will not crash; but letting a knowingly
    // unreadable record into the database means accepting that its button will never appear.
    if (isNewNotificationType(input.type) && input.data !== undefined && input.data !== null) {
      const parsed = notificationDataSchemaFor(input.type).safeParse(input.data)
      if (!parsed.success) {
        // `issues` is always non-empty when parsing fails — this is a property of
        // Zod itself, not our assumption. So removing `?.` is not observable
        // by anything: no shape produces a list with zero refusal reasons, and
        // the fallback "invalid" is unreachable. It is kept as insurance in case the library
        // changes — but there is nothing to test it with.
        return this.refuse(
          input,
          // Stryker disable next-line OptionalChaining: issues[0] always exists on a failed parse — the mutant is unobservable
          `Invalid notification data for ${input.type}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        )
      }
    }

    const values = {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      secondaryId: input.secondaryId ?? null,
      data: input.data ?? null,
      dedupeKey: input.dedupeKey ?? null,
    }

    // Idempotency by (type, subjectId, userId): the key carries the first two,
    // the partial unique index `uq_notifications_user_dedupe` adds
    // the recipient. `DO NOTHING` instead of a preliminary SELECT — otherwise between
    // the check and the insert there remains a window through which a repeated delivery
    // of the event slips through whole.
    const rows =
      values.dedupeKey === null
        ? await tx.insert(notifications).values(values).returning()
        : await tx
            .insert(notifications)
            .values(values)
            .onConflictDoNothing({
              target: [notifications.userId, notifications.dedupeKey],
              // The predicate of the PARTIAL index — without it Postgres will not match the
              // conflict with `uq_notifications_user_dedupe` and will fail on
              // «no unique or exclusion constraint matching».
              where: sql`${notifications.dedupeKey} IS NOT NULL`,
            })
            .returning()

    const row = rows[0]
    if (!row) {
      if (values.dedupeKey !== null) return null
      throw new Error('Failed to insert notification')
    }

    // Item 7a, AC1: the email enters the queue in the SAME transaction. Not a
    // discipline but a property: the event rolled back — and so did the notification,
    // and the email. An email about an event that did not happen is unacceptable exactly as
    // a notification about it is.
    //
    // The order matters: the queue row references the notification, so it
    // can appear only AFTER it — and only if it really
    // appeared (absorbed by idempotency it returned above as `null`, and
    // there will be no second email).
    if (input.skipEmail !== true) {
      await this.enqueueEmailInTx(tx, row.id, values.userId, values.type)
    }

    return this.mapNotification(row, 'active')
  }

  /**
   * Enqueue an email for an already inserted notification.
   *
   * **Has no right to break the event** — the same boundary as `refuse()`
   * (SR-H-1, security-review round 1, #664): the cost of an error in the CHANNEL is not equal to
   * the cost of an error in the event itself. A project must not stop being created
   * because the email queue is unavailable. The failure is loud —
   * `logger.error` plus a row in telemetry that reaches the digest.
   *
   * Unlike `refuse()`, a `try/catch` without a savepoint is enough here:
   * the whole producer path is ALREADY wrapped in a nested transaction
   * (`emitInTx`), and a Postgres error that would abort the event's transaction
   * is rolled back to its savepoint. A savepoint of its own would add a second
   * rollback round where the first already exists.
   */
  private async enqueueEmailInTx(
    tx: DrizzleTx,
    notificationId: string,
    userId: string,
    type: string,
  ): Promise<void> {
    try {
      // The channel setting is NOT read here — the sender checks it at the moment
      // of sending (§5 of the task, SPEC-H-2 / CR-H-2 / SR-M-2). Round 1 decided this
      // here, and a person who switched on the channel between the event and the sending
      // did not get the email: the row did not exist and had nowhere to appear.
      //
      // The recipient's state, conversely, is checked BOTH times: the archived
      // row is created already skipped (the cron will not get it at all), and
      // an archiving that happens later is caught by the sender.
      const [recipient] = await tx
        .select({ archivedAt: users.archivedAt })
        .from(users)
        .where(eq(users.id, userId))

      const decision = decideEnqueue(type, recipient?.archivedAt != null)

      await tx
        .insert(notificationEmails)
        .values({
          notificationId,
          userId,
          status: decision.status,
          // The row is ALWAYS created, even when no email will be sent: "no row"
          // does not answer why the employee did not get the email about X
          // (§1 of the task — `SKIPPED` + `skip_reason`).
          skipReason: decision.status === 'SKIPPED' ? decision.skipReason : null,
        })
        // One email per notification: a repeated enqueue does nothing rather than
        // produce a second email. The index `uq_notification_emails_notification`.
        .onConflictDoNothing({ target: notificationEmails.notificationId })
        .returning()
    } catch (err) {
      this.logger.error(
        `Failed to enqueue notification email (the event and its notification are NOT rolled back): ${
          err instanceof Error ? err.message : String(err)
        } [type=${type}]`,
      )
      this.report({
        source: 'API',
        message: 'Notification email not queued',
        route: '/api/notifications',
        userId,
        meta: { type },
      })
    }
  }

  /**
   * A notification has no right of veto over the event (SR-H-1, security-review
   * round 1).
   *
   * Five of the six producers call `createInTx` INSIDE the transaction of the
   * event itself — this is a deliberate choice: "a notification about an event that did not happen
   * is unacceptable". But the choice had a second half that nobody checked: while
   * this branch THREW, a failed data parse rolled back the transaction itself.
   * The senior could not refuse, because the refusal reason turned out to be
   * longer than the notification form's ceiling; the project was not created because of the length of
   * the title. The cost of an error in the description of the event equalled the cost of an error in the
   * event itself — disproportionately.
   *
   * Therefore: the record is skipped, the event lives. The skip is loud —
   * `logger.error` in the server console AND a row in the error telemetry, which
   * reaches the digest. A silently lost notification would be the other end of
   * the same stick.
   *
   * Returns `null` — the same answer as for a record absorbed by idempotency:
   * the caller need not distinguish "did not create because it is a duplicate" from
   * "did not create because the data has the wrong shape", but it must not crash.
   */
  private refuse(input: CreateNotificationInput, reason: string): null {
    this.logger.error(
      `Notification skipped (event not rolled back): ${reason} [type=${input.type} userId=${input.userId}]`,
    )
    this.report({
      source: 'API',
      message: `Notification skipped — ${reason}`,
      route: '/api/notifications',
      userId: input.userId,
      // Neither `title` nor `data` travels here: the digest goes into a separate
      // repository, and the data shape is already named by the type and the message.
      meta: { type: input.type, subjectType: input.subjectType ?? null },
    })
    return null
  }

  /**
   * The producer path as a whole — inside a NESTED transaction (SR-H-2,
   * security-review round 2).
   *
   * `refuse()` of round 1 removed the veto only from the DATA SHAPE: a failed `safeParse`
   * stopped throwing. Everything else on the producer path — resolving recipients,
   * building the payload, the `INSERT` itself — the veto still covered. At `fda3f11f` this was caught
   * by execution: a `TypeError` in the `createFromInterview` producer rolled back
   * the interview's transition to HIRED together with the creation of the project.
   *
   * Why a nested transaction and not just `try/catch`: a Postgres error
   * (for example, a lone surrogate in `jsonb` — SR-M-3) aborts the transaction ITSELF.
   * A JS catch does not revive it: any next query of the event fails with
   * «current transaction is aborted, commands ignored until end of transaction
   * `block`. A nested transaction in Drizzle is a `SAVEPOINT` (see
   * `node-postgres/session`: `savepoint spN` … `rollback to savepoint spN`), and
   * rolling back to it returns the event's transaction to a working state.
   *
   * The invariant "a notification about an event that did not happen is unacceptable" thereby
   * stays intact: the savepoint is nested INSIDE the event's transaction, so rolling back the event
   * still carries away the record too.
   */
  async emitInTx(tx: DrizzleTx, produce: (sp: DrizzleTx) => Promise<void>): Promise<void> {
    try {
      await tx.transaction(async (sp) => {
        await produce(sp)
      })
    } catch (err) {
      // SR-L-6 (security-review round 3, #664): the whole point of the seam — nothing on
      // the producer path may break the event. `produce()` already has
      // this property (see above); ITS HANDLER does not: until this fix
      // `logger.error` / `report()` ran outside `try`, and
      // a throw from there (for example, `this.telemetry` unreachable on a service
      // assembled by hand without DI) would fly into the event's transaction — the very
      // veto that `emitInTx` lifts for `produce()`. The observation has no
      // right to be louder than the event itself, so it has its own,
      // separate `try/catch`.
      try {
        // A trace, not only the text: the throw may happen BEFORE the payload is
        // assembled, when there is not yet a type or a recipient, and then
        // the only thing that names the broken producer is the stack.
        this.logger.error(
          `Notification producer path failed (event not rolled back): ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        )
        this.report({
          source: 'API',
          // To telemetry — the short form: the digest goes into a separate
          // repository, and the stack is not needed there, while `fingerprint` is computed from the
          // message.
          message: `Notification producer failed — ${String(err)}`,
          route: '/api/notifications',
        })
      } catch (handlerErr) {
        // There is nowhere further to fall: the event continues regardless of
        // what happened to the observation itself.
        this.logger.error(
          `Notification failure handler itself failed (observability lost, event not rolled back): ${
            handlerErr instanceof Error ? handlerErr.message : String(handlerErr)
          }`,
        )
      }
    }
  }

  /**
   * Failure telemetry — WITHOUT `await` (SR-L-4, security-review round 2).
   *
   * Both callers work from inside the open event transaction, and
   * `TelemetryErrorsService` writes through the same pool (`max: 10`). Waiting for a second
   * connection while holding the first under a transaction is the classic form of
   * a pool deadlock, should failures arrive in a batch. An observation channel has no right to
   * delay the event, so the record is released into the background, and its own
   * failure stays in the journal.
   */
  private report(payload: Parameters<TelemetryErrorsService['recordError']>[0]): void {
    void this.telemetry.recordError(payload).catch((err: unknown) => {
      this.logger.error(
        `Telemetry did not accept the notification failure: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  /**
   * The batch of recipients of one event. A separate method, not a loop on the producer's side,
   * because "who it goes to" is a property of the event, and keeping it
   * in one place is cheaper than repeating the loop in five modules.
   *
   * Rollback boundaries (SR-H-2, round 2). The batch runs INSIDE the same savepoint as
   * the rest of the producer path — so a database failure on one recipient
   * takes the whole batch, but not the event. A savepoint per recipient is not
   * introduced deliberately: the recipients of one event differ only by
   * identifier, and a payload that Postgres rejected for one it will reject
   * for all — the cost of splitting (a savepoint per row) would always be paid, while
   * it would help only in a case that by construction does not occur.
   */
  async createManyInTx(tx: DrizzleTx, inputs: CreateNotificationInput[]): Promise<void> {
    for (const input of inputs) {
      await this.createInTx(tx, input)
    }
  }

  /**
   * Header dropdown payload. Returns the N most-recent notifications for the
   * user (default 10, capped at 100) and a server-computed `unreadCount` that
   * drives the badge bubble. The unread count is intentionally derived from
   * the full set, not the paginated `items.length`, so the badge stays
   * accurate even when the dropdown caps at 10.
   */
  async listForUser(
    userId: string,
    opts: NotificationListFilters,
  ): Promise<NotificationsListResponse> {
    const limit = opts.limit ?? 10

    // Conditional where: when `unreadOnly` is set, also AND read_at IS NULL.
    // The partial index `idx_notifications_user_unread` covers this path.
    const where = opts.unreadOnly
      ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
      : eq(notifications.userId, userId)

    const rows = await this.db.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)

    // Unread count is always for the user globally, regardless of the filter.
    // The partial index makes this a constant-cost lookup at any list size.
    const unreadRows = await this.db.db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))

    const unreadCount = unreadRows[0]?.count ?? 0

    // §7.4. Computed HERE, not on each target page: there are five pages, and one
    // list, and the object's state is a property of the record at the moment of reading, and
    // not a property of the route.
    // The states arrive as a LIST in row order, not as a map keyed by
    // identifier: a map would require a fallback value for the case
    // "no state", which never occurs — and that fallback value would be
    // a branch that no test executes.
    const states = await this.resolveSubjectStates(userId, rows)

    return {
      items: rows.map((r, index) => this.mapNotification(r, states[index]!)),
      unreadCount,
    }
  }

  /**
   * Half of §7.4 WITHOUT queries — only the assembly of `SubjectRef[]` from the rows of the
   * notification. The decision and the queries live in `NotificationSubjectStateService`
   * (backlog 208): the same service that the cron uses to check currency
   * (`NotificationEmailCronService`) at the moment of sending — ONE resolver for the
   * popup and the email, not two that diverge.
   */
  private async resolveSubjectStates(
    userId: string,
    rows: (typeof notifications.$inferSelect)[],
  ): Promise<SubjectResolution[]> {
    const refs: SubjectRef[] = rows.map((r) => ({
      userId: r.userId,
      type: r.type,
      subjectType: (r.subjectType as NotificationSubjectType | null) ?? null,
      subjectId: r.subjectId ?? null,
      // QA-H-1 (round 3): the notification identifies the approval ROW, not its
      // description — see `approvalIdFromData`.
      approvalId: approvalIdFromData(r.data),
    }))
    return this.subjectStates.resolveMany(userId, refs)
  }

  /**
   * Mark a single notification as read. Throws 404 if missing or if the row
   * belongs to a different user — a uniform 404 avoids leaking notification
   * existence to other users (existence oracle, SEC-10).
   */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const row = await this.db.db.query.notifications.findFirst({
      where: eq(notifications.id, notificationId),
    })
    if (!row) throw apiError('NOTIFICATION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (row.userId !== userId) {
      // SEC-10: return 404 (not 403) to avoid leaking that the notification
      // exists but belongs to another user (existence oracle).
      throw apiError('NOTIFICATION_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    if (row.readAt) return // idempotent
    await this.db.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, notificationId))
  }

  /**
   * Mark every unread notification for `userId` as read. Used by the
   * "Mark all as read" footer button in the header dropdown. One UPDATE — no
   * reads required.
   */
  async markAllRead(userId: string): Promise<void> {
    await this.db.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  }

  /**
   * Hard-delete a single notification row. Used by the Trash icon in the
   * header bell dropdown. Ownership semantics:
   *   - 404 when the row does not exist
   *   - 404 (not 403) when the row belongs to a different user — avoids leaking
   *     existence (SEC-10 existence oracle).
   * (No soft delete — notifications are ephemeral, recreated by the system
   *  whenever the underlying event re-occurs.)
   */
  async delete(userId: string, notificationId: string): Promise<void> {
    const row = await this.db.db.query.notifications.findFirst({
      where: eq(notifications.id, notificationId),
    })
    if (!row) throw apiError('NOTIFICATION_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (row.userId !== userId) {
      // SEC-10: return 404 (not 403) to avoid leaking that the notification
      // exists but belongs to another user (existence oracle).
      throw apiError('NOTIFICATION_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    await this.db.db.delete(notifications).where(eq(notifications.id, notificationId))
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  /**
   * The four boolean DTO fields are derived from ONE state, and only here —
   * therefore "gone and archived at the same time" (or "withdrawn and already
   * decided at once" — ORCH-2, fix round 6, #664) is impossible by construction, not by
   * agreement.
   *
   * By a table rather than a pair of comparisons: five states and their flags are visible side by side, and
   * a state missing from the table breaks the parse at once, rather than turning
   * silently into "live". The parameter has no default on purpose — the caller must
   * say which state is meant (the mutation gate of round 5: substituting the default
   * value did not change a single test).
   */
  private static readonly SUBJECT_FLAGS: Record<
    SubjectResolution,
    {
      missing: boolean
      archived: boolean
      approvalSuperseded: boolean
      approvalDecided: boolean
    }
  > = {
    active: { missing: false, archived: false, approvalSuperseded: false, approvalDecided: false },
    archived: {
      missing: false,
      archived: true,
      approvalSuperseded: false,
      approvalDecided: false,
    },
    missing: { missing: true, archived: false, approvalSuperseded: false, approvalDecided: false },
    approvalSuperseded: {
      missing: false,
      archived: false,
      approvalSuperseded: true,
      approvalDecided: false,
    },
    approvalDecided: {
      missing: false,
      archived: false,
      approvalSuperseded: false,
      approvalDecided: true,
    },
  }

  private mapNotification(
    row: typeof notifications.$inferSelect,
    state: SubjectResolution,
  ): NotificationDto {
    // There is no explicit check for `undefined` here on purpose: the table covers all
    // five states, `computeSubjectState` breaks the parse on any other, and
    // access to a field of a missing record will fail by itself. A branch of "just in case" would be
    // a branch that no test executes (the mutation gate of round 5).
    const flags = NotificationsService.SUBJECT_FLAGS[state]
    return {
      id: row.id,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body ?? null,
      link: row.link ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      subjectType: (row.subjectType as NotificationSubjectType | null) ?? null,
      subjectId: row.subjectId ?? null,
      secondaryId: row.secondaryId ?? null,
      data: row.data ?? null,
      subjectMissing: flags.missing,
      subjectArchived: flags.archived,
      approvalSuperseded: flags.approvalSuperseded,
      approvalDecided: flags.approvalDecided,
    }
  }
}
