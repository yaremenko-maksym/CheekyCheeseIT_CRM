/**
 * Decisions of the email queue as pure functions, separate from the service and the cron.
 *
 * Why separate: the mutation gate runs no integration spec at all
 * (`.claude/rules/common/mutation-gate-integration-specs.md`), and a mistake
 * here is the most costly. "Whether to create a row" silently loses the only channel that
 * reaches a closed tab; "whether to send and where" sends an email to the wrong
 * person — including a dismissed one, to a personal address. Every function is checked by a
 * unit test, which the gate sees.
 *
 * **Two decision points, not one.** Enqueueing (`decideEnqueue`) knows
 * only the event type and whether the recipient is alive. Delivery (`decideDelivery`)
 * also knows the channel setting and the addresses — and it is that which decides whether
 * the email goes out. The task requires this (§5: "The sender checks the setting at the moment
 * of sending, not at enqueueing"), and the reason is not formal: between
 * the event and the sending up to fifteen seconds pass, and with retries — hours.
 * A person who enabled the channel within this window gets the email; one who disabled it does not.
 * A decision taken at enqueueing ignores both of these edits
 * silently.
 */
import {
  isActionRequiredNotificationType,
  isEmailChannelLocked,
  isNewNotificationType,
  type Locale,
  type NewNotificationType,
} from '@crm/shared'
import type { SubjectResolution } from './notification-subject-resolver'

/** Attempt ceiling. The sixth will not happen — the row goes to `FAILED`. */
export const MAX_EMAIL_ATTEMPTS = 5

/**
 * SR-M-1 / CR-M-1 (security-review + code-review round 1, PR #714). Three
 * frozen types (task-i18n-stage4-task6) got into `NEW_NOTIFICATION_TYPES`
 * in this very PR — and `isNewNotificationType()` below, before this exclusion, silently
 * enabled emails for them: `INVOICE_SIGN_REQUIRED` to the counterparty, `INVOICE_SIGNED`
 * to the admin, `VACANCY_APPLICATION` to each ADMIN/HR (the last one from an anonymous
 * public form). Registering a type in the notification registry and enabling a NEW
 * EXTERNAL delivery channel (email to a personal address) are different decisions
 * (`autonomy-levels.md`: external sending is outside A1); the email texts for these three
 * types have not passed copy review as emails (`notification-email-copy.ts`)
 * gives them only Ukrainian placeholders; Task 7 will migrate them).
 *
 * The email behaviour in THIS PR is exactly as on `origin/main`, where these three types
 * did not exist: the explicit list here decouples "there is an email" from
 * `isNewNotificationType()`, rather than relying on a side effect of registration.
 */
const NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE = new Set<NewNotificationType>([
  'INVOICE_SIGNED',
  'INVOICE_SIGN_REQUIRED',
  'VACANCY_APPLICATION',
])

/**
 * "The type has an email template" — an old type (predating the registry) does not either.
 *
 * A type predicate (`type is NewNotificationType`), not a plain `boolean`:
 * `decideDelivery` below narrows `type` by this call and passes it further to
 * `isEmailChannelLocked(type: NewNotificationType)` — a plain `boolean` would not
 * narrow the type, and the call below would stop compiling (the same narrow
 * contract that `isNewNotificationType` once held alone).
 */
function hasEmailTemplate(type: string): type is NewNotificationType {
  return isNewNotificationType(type) && !NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE.has(type)
}

/**
 * Why there is no email. Distinguishes "could not send" (`FAILED`) from "not
 * was supposed to be sent (`SKIPPED` + reason) — without this distinction the question
 * "why did the employee not receive the email about X" has no answer in the data
 * (SPEC-H-1 / CR-H-1 / SR-L-2).
 *
 * A copy of the `notification_email_skip_reason` type from `schema.ts` — deliberate and
 * under test: `notification-email-outbox.spec.ts` checks this list against
 * `notificationEmailSkipReasonEnum.enumValues`. Otherwise we would have to drag
 * drizzle into a module that deliberately knows nothing about the database.
 *
 * `STALE` (backlog 208) — the approval or contract the email is about has
 * ceased to be current between enqueueing and sending:
 * the offer was withdrawn or re-created, a counterparty's refusal settled it, or the contract is already
 * signed. Differs from `CHANNEL_OFF` in that it is not about the person's setting, and
 * from `LEGACY_TYPE` — in that the type has both a template and an object, but the object
 * no longer waits for a reply.
 */
export const SKIP_REASONS = [
  'NO_ADDRESS',
  'USER_ARCHIVED',
  'CHANNEL_OFF',
  'LEGACY_TYPE',
  'STALE',
] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/**
 * How long to wait before the next attempt after the `attempt`-th failure.
 *
 * `min(2^attempts, 60)` minutes — the task's §2 verbatim: 2/4/8/16/32/60. Two
 * minutes at the first failure, not one: the typical failure here is a provider `429` or
 * a 500, and a retry after one minute would mean five attempts in five minutes,
 * that is, five failures instead of one. The ceiling is needed so that the fifth
 * attempt happens within the same working day.
 */
export function backoffMs(attempt: number): number {
  const minute = 60_000
  return Math.min(minute * 2 ** attempt, 60 * minute)
}

/** What to do with an outbox row at the moment a notification is written. */
export type EnqueueDecision =
  | { status: 'QUEUED' }
  | { status: 'SKIPPED'; skipReason: Extract<SkipReason, 'LEGACY_TYPE' | 'USER_ARCHIVED'> }

/**
 * Whether to create an outbox row, and in what state.
 *
 * The row is ALWAYS created — the only question is the status. "No row" does not
 * answer why no email was sent: `SKIPPED` and `skip_reason` exist precisely to answer that
 * (§1 of the task).
 *
 * This function does not accept the channel setting and must not — see
 * the file header.
 */
export function decideEnqueue(type: string, recipientArchived: boolean): EnqueueDecision {
  // Order of reasons: a type with NO email at all (legacy types predating the registry,
  // and — SR-M-1/CR-M-1, PR #714 — the three frozen types of this PR, which HAVE popup text
  // but no approved EMAIL template yet, see `hasEmailTemplate` above) never raises the
  // "who is the recipient" question. There is neither a template nor a setting for it,
  // and the trace "emails are not due for this type" is more precise
  // than a trace about the person's state.
  if (!hasEmailTemplate(type)) return { status: 'SKIPPED', skipReason: 'LEGACY_TYPE' }
  if (recipientArchived) return { status: 'SKIPPED', skipReason: 'USER_ARCHIVED' }
  return { status: 'QUEUED' }
}

export interface AddressRow {
  email: string
  kind: 'WORK' | 'PERSONAL'
}

/** Everything about the recipient that is needed at the moment of sending. */
export interface DeliveryContext {
  /** `users.archived_at IS NOT NULL` — that is, the person has been dismissed. */
  archived: boolean
  addresses: readonly AddressRow[]
  /**
   * The record of THIS type's setting if the person changed it; `null` — no record.
   *
   * No record means "emails are sent": a default of "disabled" would mean that the
   * subsystem does not work for anyone until every person opens their
   * settings. Three states (`true` / `false` / no record) do not collapse into
   * two: "switched it on myself" and "never touched it" behave the same today, but
   * they must be distinguishable in the data, so that changing the default does not overwrite someone else's
   * choice.
   */
  emailEnabled: boolean | null
  /**
   * The state of the email object, computed by the SAME resolver as the popup
   * (`computeSubjectState` / `NotificationSubjectStateService`) — backlog 208.
   *
   * `undefined` means "not checked": for informational and admin types
   * (§7.2, "a fact-notification email does not degrade") the calling cron does not call the
   * resolver at all, and this function must skip them just as before —
   * an email about a fact that has occurred does not go stale because the fact itself was later
   * deleted. For the three types that require action
   * (`isActionRequiredNotificationType`) the caller must substitute here
   * the real resolver answer; `'active'` is the only value at which
   * the email still goes out.
   */
  subjectState?: SubjectResolution | undefined
  /**
   * The RECIPIENT's language at the moment of sending (`users.locale`; garbage and "no user"
   * yield `uk`). `decideDelivery` does not read it — the field is needed only by email renderers,
   * and cannot influence the decision "whether to send and where" (pinned by a test).
   */
  locale: Locale
}

export type SendDecision = { send: true; to: string } | { send: false; skipReason: SkipReason }

/**
 * Whether the email goes out, and to which address — a decision at the moment of sending.
 *
 * The order of reasons runs from strongest to weakest, and each rung
 * is pinned by a test:
 *
 * 1. **archived** — dismissal. `JwtAuthGuard` already revokes access for such a
 *    person, and the email is the only channel that still REACHES them
 *    (SR-H-1). It overrides everything: the reason "dismissed" explains the missing email,
 *    "no address" does not.
 * 2. **legacy type** — there is no email at all (neither template nor setting).
 * 3. **stale** (backlog 208) — the object the email is about no longer awaits
 *    a reply: the approval was withdrawn or decided, the contract is already signed. Earlier
 *    the channel setting — an email about an event that did not happen is unacceptable
 *    regardless of whether the channel is enabled (§7.2).
 * 4. **channel off** — the person decided so (AC6). Differs from "no address"
 *    in that it requires nobody's intervention.
 * 5. **no address** — the only reason that signals a gap in the data
 *    and requires administrator action.
 */
export function decideDelivery(type: string, ctx: DeliveryContext): SendDecision {
  if (ctx.archived) return { send: false, skipReason: 'USER_ARCHIVED' }
  // SR-M-1/CR-M-1 (PR #714): same `hasEmailTemplate` gate as `decideEnqueue` —
  // see its doc comment above `NOTIFICATION_TYPES_WITHOUT_EMAIL_TEMPLATE`.
  if (!hasEmailTemplate(type)) return { send: false, skipReason: 'LEGACY_TYPE' }
  if (isActionRequiredNotificationType(type)) {
    // SR-L-1 (PR #678, round 2): for an action-required type `subjectState`
    // MUST arrive defined — the only caller able to omit it
    // (the cron) already always passes it via
    // `isActionRequiredNotificationType` in `deliver()`. Here `undefined` is
    // not "not checked" (as for informational types) but an error of the CALLER:
    // a fail-loud throw, not a silent `SKIPPED/STALE` — an email lost to a bug must not
    // be indistinguishable in the data from an email about a nonexistent approval
    // (`decideDelivery` does not disguise one as the other). The cron catches this
    // exception and moves the row to `FAILED` with the error text in
    // `last_error` (no PII — the message names only the notification type
    // ).
    if (ctx.subjectState === undefined) {
      throw new Error(
        `decideDelivery: subjectState is required for action-required type "${type}" but was not passed`,
      )
    }
    if (ctx.subjectState !== 'active') {
      return { send: false, skipReason: 'STALE' }
    }
  }
  // A locked type ignores the record entirely — §3: "emails about confirmations and
  // signatures cannot be switched off… otherwise the process silently stops". Such a record does not
  // pass request parsing, but it can reach the database bypassing the API (by hand,
  // by migration, by a prior version), and the last line of defence is here.
  if (ctx.emailEnabled === false && !isEmailChannelLocked(type)) {
    return { send: false, skipReason: 'CHANNEL_OFF' }
  }
  const to = pickEmailAddress(ctx.addresses)
  if (to === null) return { send: false, skipReason: 'NO_ADDRESS' }
  return { send: true, to }
}

/**
 * Where to send: the personal address if there is one, otherwise the work address.
 *
 * The personal one is preferred regardless of `verified_at` — the spec's §5 on the personal
 * address states it plainly: "the address exists, emails go to it, but you cannot sign in with
 * it." Verification opens the SIGN-IN, not the mailbox.
 *
 * The cost of an error in the address is limited by the construction of the email: it contains neither
 * amounts, nor percentages, nor names (§10, `notification-email-copy.ts`), so
 * a typo reveals only the fact "there is a request for you in the CRM".
 */
export function pickEmailAddress(rows: readonly AddressRow[]): string | null {
  // There is no second check of this kind here, and this is not carelessness.
  //
  // `user_email_kind` has exactly two values, and the personal one was singled out by the row above —
  // so any remaining row is a work one, and `kind === 'WORK'` would be
  // a condition that cannot be false. The mutation gate showed exactly this: "always true" there is
  // indistinguishable from the check itself, and there is no way to suppress ONLY this half —
  // `disable next-line` silences the second one too, which the
  // test does catch.
  //
  // The invariant "exactly two kinds" is not held up by a comment: `notification-email-outbox.spec.ts`
  // checks it directly against `userEmailKindEnum`. If someone adds a
  // third kind, the test goes red here and the address choice must be rewritten
  // deliberately, rather than discovering an email about money that went to the wrong place.
  return rows.find((r) => r.kind === 'PERSONAL')?.email ?? rows[0]?.email ?? null
}
