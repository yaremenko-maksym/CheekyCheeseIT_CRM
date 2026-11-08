/**
 * Email sender for the `notification_emails` queue — position 7a, AC2.
 *
 * Every fifteen seconds: take a batch of due rows, build an email from the
 * notification, send it via `ResendMailerService`, record the outcome.
 *
 * **Seam — `OutboxGateway`, not drizzle.** Everything the sender does with the database
 * is named as four operations (`claimDue` / `addressesFor` / `markSent` /
 * `markFailed` / `scheduleRetry`). This lets the unit test check BEHAVIOUR
 * ("after the fifth attempt the row is buried"), not the SQL shape: a mock of the
 * drizzle chain would go red on any rewrite of the same query, that is, it would
 * pin the implementation. The real SQL — `FOR UPDATE SKIP LOCKED` and the
 * partial-index predicate — is checked on a live Postgres in
 * `notification-email-delivery.integration.spec.ts`, because neither of these
 * can be proven by a mock by construction.
 *
 * **Claim is a lease, not a status.** `claimDue` in one statement moves
 * `next_attempt_at` forward and increments `attempts`, leaving the status QUEUED.
 * A process that crashes in the middle of an HTTP request leaves no rows stuck in an
 * intermediate state: the lease expires and the row returns to the queue
 * by itself, without a separate garbage collector.
 *
 * **HTTP — outside a transaction.** Keeping a transaction open for the duration of a request to a
 * third-party API means holding a pool connection for as long as the
 * foreign server takes to answer. The claim commits; sending happens after it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { isActionRequiredNotificationType } from '@crm/shared'
import type { Env } from '../config/env'
import { ResendMailerService } from '../contact/resend-mailer.service'
import { safeErrorReason } from '../contact/mailer-retry.util'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { stripCrlf } from '../common/strip-crlf'
import { renderNotificationEmail, type NotificationEmailSource } from './notification-email-copy'
import type { SubjectResolution } from './notification-subject-resolver'
import {
  decideDelivery,
  MAX_EMAIL_ATTEMPTS,
  type DeliveryContext,
  type SkipReason,
} from './notification-email-outbox'

/** How many rows are taken per pass. */
export const CLAIM_BATCH_SIZE = 20

/** A queue row together with the notification the email is built from. */
export interface ClaimedEmail {
  id: string
  userId: string
  /** The attempt count already incremented by the claim: 1 on the first pass. */
  attempts: number
  notification: NotificationEmailSource
}

/** Everything the sender needs from the database. The implementation is `OutboxRepository`. */
export interface OutboxGateway {
  claimDue(limit: number): Promise<ClaimedEmail[]>
  deliveryContextFor(userId: string, type: string): Promise<DeliveryContext>
  /**
   * The state of the email object — backlog 208. Called ONLY for types
   * that require action (`isActionRequiredNotificationType`, see `deliver()`
   * below); for informational and admin emails `deliver()` does not call this
   * method at all, using the same resolver as the popup
   * (`NotificationSubjectStateService.resolveOne`).
   */
  resolveSubjectState(
    userId: string,
    notification: NotificationEmailSource,
  ): Promise<SubjectResolution>
  markSent(id: string, email: string): Promise<void>
  markSkipped(id: string, reason: SkipReason): Promise<void>
  markFailed(id: string, reason: string): Promise<void>
  scheduleRetry(id: string, reason: string, attempts: number): Promise<void>
}

/**
 * A pass running longer than this is considered hung, and the next tick starts
 * work without waiting for it.
 *
 * Five minutes — with a margin above the longest possible pass: twenty
 * rows at a ten-second timeout per provider call give a bit over three minutes in the
 * worst case. Without this deadline the "running" flag becomes eternal because of one
 * hung `await` (SR-L-4): `finally` clears it, but if it does not —
 * the sender falls silent forever and silently, which for a channel that delivers "a decision
 * is waiting for you" is worse than two simultaneous passes.
 */
export const SWEEP_STUCK_AFTER_MS = 5 * 60_000

export const OUTBOX_GATEWAY = Symbol('OUTBOX_GATEWAY')

@Injectable()
export class NotificationEmailCronService {
  private readonly logger = new Logger(NotificationEmailCronService.name)
  private readonly frontendUrl: string
  /**
   * Where replies to the email go. The public mailbox, not the recipient's address
   * (SR-M-3): "replies to our emails go to the public mailbox" — the same
   * convention as the invitation (`personal-email-invite-mailer.service.ts`).
   * Round 1 put the reader's own personal address here, and replies went to them.
   */
  private readonly replyTo: string
  /** No key — warn ONCE, not four times a minute. */
  private warnedUnconfigured = false
  /**
   * When the current pass started, or `null` — there is no pass.
   *
   * A timestamp, not a flag: a flag answers only "is it running", and a hung
   * pass makes the answer eternal (SR-L-4). A timestamp also answers "for how long", and
   * it is cleared by ITS OWN pass — see `handleDue`.
   */
  private runningSince: number | null = null

  constructor(
    @Inject(OUTBOX_GATEWAY) private readonly outbox: OutboxGateway,
    private readonly mailer: ResendMailerService,
    private readonly telemetry: TelemetryErrorsService,
    config: ConfigService<Env, true>,
  ) {
    // `{ infer: true }` — a hint to the TYPES (`ConfigService<Env, true>` derives the
    // value type from the key). It has no effect on execution at all: `get()`
    // returns the same value with `{}`, with `{ infer: false }`, and without a second
    // argument at all. There is nothing to test this with — no observable difference
    // exists; the key's NAME itself is under test (the settings stub in the spec
    // answers only `FRONTEND_URL`).
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: `infer` is a compiler hint with no observable runtime behaviour
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true })
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: same — `infer` does not change execution
    this.replyTo = config.get('CONTACT_PUBLIC_EMAIL', { infer: true })
  }

  /**
   * Fifteen seconds — a compromise between "the email arrives while the person is still
   * looking at their mail" and the cost of an empty query on the index. A query on the
   * partial index over an empty queue is a single index page.
   */
  @Cron('*/15 * * * * *')
  async handleDue(): Promise<void> {
    const startedAt = Date.now()
    if (this.runningSince !== null) {
      if (startedAt - this.runningSince < SWEEP_STUCK_AFTER_MS) return
      // Five minutes — not "probably still running" but "something did not release it".
      // Loud, because a silent sender looks exactly like
      // an empty queue.
      this.logger.warn(
        `Previous notification email sweep has not finished in ${SWEEP_STUCK_AFTER_MS / 60_000} minutes — starting a new one`,
      )
    }
    this.runningSince = startedAt
    try {
      await this.drainOnce()
    } catch (err: unknown) {
      // An unhandled failure in a `@Cron` handler silently kills the scheduler
      // for ALL crons of the process — the same argument as for
      // `TelemetryRetentionCronService` and `VacanciesRetentionCronService`.
      this.logger.error(
        `Notification email sweep failed — retrying on the next tick${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    } finally {
      // Clears ONLY its own marker. Otherwise a hung pass, reaching `finally`
      // after its marker was replaced, would open the road for a third simultaneous one —
      // that is, curing a hang would multiply passes.
      if (this.runningSince === startedAt) this.runningSince = null
    }
  }

  /** One pass. Separate from `handleDue` — so that a test does not wait for the scheduler. */
  async drainOnce(): Promise<void> {
    if (!this.mailer.isConfigured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true
        this.logger.warn(
          'RESEND_API_KEY is not set — notification emails are piling up in notification_emails and are not being sent. ' +
            'Rows stay QUEUED with zero attempts and will go out as soon as the key appears.',
        )
      }
      // Not a single attempt: the row is NOT taken, `attempts` does not grow, and the ceiling of
      // five attempts is not spent on a missing key.
      return
    }

    const batch = await this.outbox.claimDue(CLAIM_BATCH_SIZE)
    for (const item of batch) {
      await this.deliver(item)
    }
  }

  private async deliver(item: ClaimedEmail): Promise<void> {
    // The recipient's state and setting are read HERE, at the moment of sending,
    // not at enqueueing (§5 of the task). Between the event and this
    // row up to fifteen seconds have passed, and with retries — hours: the person
    // may have been dismissed, and the channel switched on or off.
    const context = await this.outbox.deliveryContextFor(item.userId, item.notification.type)
    // The OBJECT's currency — backlog 208, by the same device as the channel
    // setting: read here, not at enqueueing, because the proposal
    // could have gone stale in this very window. Only for the three types requiring
    // action (`isActionRequiredNotificationType`) — an email about a FACT that happened
    // (informational and admin types) does not go stale because the
    // object it reports on later disappeared or was archived: the same
    // principle by which the popup does not hide an archived team's card, but
    // marks it as archived.
    const subjectState = isActionRequiredNotificationType(item.notification.type)
      ? await this.outbox.resolveSubjectState(item.userId, item.notification)
      : undefined
    let decision: ReturnType<typeof decideDelivery>
    try {
      decision = decideDelivery(item.notification.type, { ...context, subjectState })
    } catch (err: unknown) {
      // SR-L-1: `decideDelivery` throws if for an action-required type
      // `subjectState` did not arrive defined — this is a CALLER error
      // (the current gateway always supplies it, see the condition above; the exception is a
      // defensive last line for the case that an `OutboxGateway` implementation
      // someday gets it wrong). The row goes to `FAILED`, rather than being swallowed
      // silently and leaving the pass with a remainder of the batch: without this catch the
      // exception would fly out of `deliver()` and cut short
      // the unprocessed rows of the current pass until the next tick.
      const reason = err instanceof Error ? err.message : 'unknown'
      await this.outbox.markFailed(item.id, reason)
      this.logger.error(`decideDelivery failed for id=${item.id}: ${reason}`)
      // SR-L-3: the same terminal trace as "gave up after N attempts"
      // below — without it this `FAILED` branch does not reach the digest, and the owner
      // learns of it only by reading `notification_emails` by hand (§7.2). Neither
      // the address nor the email text: the reason is already PII-free (see `decideDelivery`),
      // and `type` is one of `ACTION_REQUIRED_NOTIFICATION_TYPES`.
      void this.telemetry
        .recordError({
          source: 'API',
          message: 'Notification email failed before send (decideDelivery)',
          route: '/api/notifications',
          meta: { reason, type: item.notification.type },
        })
        .catch((e: unknown) => {
          this.logger.error(
            `Telemetry rejected a delivery failure: ${e instanceof Error ? e.message : String(e)}`,
          )
        })
      return
    }
    if (!decision.send) {
      await this.outbox.markSkipped(item.id, decision.skipReason)
      this.logSkip(item.id, decision.skipReason)
      return
    }
    // `stripCrlf` on the recipient address too (SR-L-7, security-review PR #673
    // round 2) — not only on `subject`/`reply_to`. The address comes from
    // `user_emails.email` (`varchar`, no CHECK constraint); the shape is
    // guaranteed only by request parsing, and data can reach the database bypassing it
    // (the same argument by which `decideDelivery` keeps a last line of defence for
    // `emailEnabled`). The value is reused both for sending and for
    // `markSent` — the delivery journal stores exactly what was actually sent.
    const to = stripCrlf(decision.to)

    // The language — of THIS row's recipient, read at the moment of sending together with the archive and
    // the address (`deliveryContextFor`). The renderer builds its own `createI18n(locale)` per call:
    // in the cron there are many `await`s between emails, and a global activation would switch the language
    // midway through assembling a neighbouring email.
    const mail = renderNotificationEmail(item.notification, {
      frontendUrl: this.frontendUrl,
      locale: context.locale,
    })

    try {
      await this.mailer.send({
        to: [to],
        // `stripCrlf` on everything that goes into the email's HEADER — the same control
        // and the same reason as in `contact.service.ts` (SR-M-1): the project name
        // comes from user input, where a line break is allowed by
        // validation, while a header assembled from two lines lets an attacker
        // inject an extra one. The email body does not need this: a line break
        // there is legal and harmless.
        subject: stripCrlf(mail.subject),
        text: mail.text,
        html: mail.html,
        // The reply to the email goes to the PUBLIC mailbox, like the invitation's
        // (SR-M-3). Putting the reader's own address here would mean their
        // reply goes to them, and the personal address would additionally travel in the header
        // of the outgoing email.
        replyTo: stripCrlf(this.replyTo),
      })
      await this.outbox.markSent(item.id, to)
    } catch (err: unknown) {
      const reason = safeErrorReason(err)
      if (item.attempts >= MAX_EMAIL_ATTEMPTS) {
        await this.outbox.markFailed(item.id, reason)
        this.logger.error(
          `Email undelivered after ${MAX_EMAIL_ATTEMPTS} attempts: ${reason} [id=${item.id}]${dbErrorLogSuffix(err)}`,
        )
        // Giving up is an event for the digest: the person did not learn about what they
        // should have. Neither the address nor the text goes there.
        void this.telemetry
          .recordError({
            source: 'API',
            message: 'Notification email gave up after retries',
            route: '/api/notifications',
            meta: { reason, type: item.notification.type },
          })
          .catch((e: unknown) => {
            this.logger.error(
              `Telemetry rejected a delivery failure: ${e instanceof Error ? e.message : String(e)}`,
            )
          })
        return
      }
      await this.outbox.scheduleRetry(item.id, reason, item.attempts)
      this.logger.warn(
        `Email not sent (attempt ${item.attempts}/${MAX_EMAIL_ATTEMPTS}): ${reason} [id=${item.id}]${dbErrorLogSuffix(err)}`,
      )
    }
  }

  /**
   * The trace of a skip in the journal — one line and one level for all five
   * reasons.
   *
   * `warn`, not `error`: the routine outcome (dismissed, switched off by the person, a type without
   * an email, the object is stale), and splitting levels by reason would mean
   * creating a second rule next to `skip_reason` that would diverge from it
   * at the first new reason. Whoever needs the breakdown reads the column, not the level.
   * journal row. There is no address in the row: only the identifier of the queue row,
   * as in every other row of this file.
   */
  private logSkip(id: string, reason: SkipReason): void {
    this.logger.warn(`Email skipped (${reason}) [id=${id}]`)
  }
}
