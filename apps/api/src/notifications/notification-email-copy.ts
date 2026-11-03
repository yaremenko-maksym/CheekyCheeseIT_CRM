/**
 * Notification emails — position 7a, spec §11 ("Email texts") and §10
 * ("money notifications are disclosure"); i18n emails PR1: the RECIPIENT's language.
 *
 * Each phrase is a whole catalog message (`EMAIL_NOTIFICATION_MESSAGES` in
 * `@crm/shared`, explicit ids `email.notification.*`, `uk` is the source, `en` is the second
 * original in `.po`). The email is assembled IN THE RECIPIENT'S LOCALE (`users.locale`,
 * read by the cron at the moment of sending) through `createI18n(locale)` ON EVERY call:
 * no global `i18n.activate`, no module-level instance — the cron has many `await`s between emails,
 * and a global would switch the language midway through assembly. Nothing is glued together
 * from fragments: the variants "with the name / without" and "base / project share" are
 * separate whole messages that the caller chooses.
 *
 * The text is NOT stored in the database (§7.1): editing wording must not be a data edit.
 * The stored notification `title`/`body` strings are DATA, not the catalog:
 * for a type the template does not know, they are printed as-is in both locales.
 *
 * The rule that all thirteen obey, and which `notification-email-copy.spec.ts` checks mechanically
 * (in both locales):
 *
 * **the email names the OBJECT (project, team, contract, vacancy) and names
 * neither people nor figures.**
 *
 * The first half is from §11: the subjects there literally contain a "{name}" placeholder, and without the
 * object's name the reader does not understand what the email is about. The second is from §10: the email goes
 * to a PERSONAL mailbox, outside our perimeter, so neither an amount, nor a percentage, nor a colleague's
 * name travels there. All of that is opened by the button, in the CRM.
 *
 * The other §11 rules, each reflected in a test:
 *   - **one button** (Open and Decline side by side would mean a refusal
 *     could be given without going in — and we need a trace in the system with a reason);
 *   - **no thanks, no polite framing** (a transactional email that says thank you reads like
 *     a newsletter and lands in "Promotions");
 *   - **a single uniform prefix "Request to …" (in the uk locale: the matching Ukrainian prefix)** on everything that requires
 *     a reply — it signals that this is an offer, not a completed fact, before
 *     the email is opened;
 *   - **in an email about a share change the second line removes the alarm** — the
 *     previous share stays in force; the new one takes effect only after consent.
 *
 * Layout — the SHARED frame `common/email-layout.ts`, the same object from which
 * the invitation is assembled (`personal-email-invite-mailer.service.ts`): "emails
 * from us look like one sender, which the mailbox learns" (§12).
 *
 * **Glossary.** The object of a money decision is called a SHARE — that is what
 * the popup, `/pending`, the profile and `CONTEXT.md` call it (where "drop percentage" is listed under
 * `_Avoid_`). The earlier Russian exception for the word "percent" in a request about a PROJECT share
 * did not survive the migration: in a language where the glossary term is mandatory,
 * the exception has no basis (A1 assumption of the plan; copy-reviewer may dispute it).
 */
import type { I18n } from '@lingui/core'
import {
  ACTION_LABELS,
  createI18n,
  EMAIL_NOTIFICATION_MESSAGES as M,
  formatDay,
  sourceAlertParams,
  isActionRequiredNotificationType,
  isNewNotificationType,
  MISC_MESSAGES,
  notificationDataSchemaFor,
  notificationHref,
  NOTIFICATION_TITLE_MESSAGES,
  renderMessage,
  type Locale,
  type NewNotificationType,
  type NotificationDataByType,
  type NotificationSubjectType,
} from '@crm/shared'
import { renderEmailLayout } from '../common/email-layout'
import { escapeHtml } from '../common/escape-html'
import { stripCrlf } from '../common/strip-crlf'

/**
 * The screen where the request can be ANSWERED (position 7c, #667).
 *
 * The email link for the three types that require action leads here, not to the object:
 * `/projects/:id` has no confirmation buttons, and an email titled "Request to add
 * a project" would lead the reader to a place where there is nothing to answer (SPEC-H-3 / CR-H-4).
 */
const PENDING_PATH = '/pending'

/** The notification row in the scope the email needs. */
export interface NotificationEmailSource {
  type: string
  title: string
  body: string | null
  link: string | null
  subjectType: NotificationSubjectType | null
  subjectId: string | null
  data: unknown
}

export interface RenderedNotificationEmail {
  subject: string
  text: string
  html: string
  /** The absolute address of the single button. */
  buttonHref: string
  buttonLabel: string
}

interface RenderOptions {
  /** The CRM root without a trailing slash (`FRONTEND_URL`). */
  frontendUrl: string
  /**
   * The RECIPIENT's language. Required and without a default: a forgetful caller must fail
   * typecheck rather than silently send `uk`. The renderer builds `createI18n(locale)` itself,
   * so a foreign activated instance cannot be passed to it.
   */
  locale: Locale
}

/** Email body: one or two lines. The second exists only where it removes the alarm. */
interface Body {
  subject: string
  lines: string[]
}

/**
 * Title and lines per event type.
 *
 * Each function receives ALREADY parsed data of its own shape. Parsing happens in the
 * caller (`renderNotificationEmail`), so that an unparseable row
 * degrades to the generic view instead of breaking the send: the email invites to the CRM, and
 * losing the only channel that reaches a closed tab is costlier than
 * sending an email without the project name.
 */
const BODIES: {
  [K in NewNotificationType]: (d: NotificationDataByType[K], i18n: I18n) => Body
} = {
  TRANSACTION_ADDED: (d, i18n) => ({
    // The project name — from the 24th character, not the 35th (COPY-L-2): in the inbox list
    // on a phone about forty characters are visible, and the thing that tells two such emails apart
    // is exactly what gets cut off.
    subject:
      d.projectName === null
        ? renderMessage(i18n, M.transactionAddedSubject)
        : renderMessage(i18n, M.transactionAddedSubjectProject, { projectName: d.projectName }),
    lines: [renderMessage(i18n, M.transactionAddedLine)],
  }),

  TRANSACTION_STATUS_CHANGED: (d, i18n) => ({
    // The status is neither an amount nor a percentage, and it is the one thing the email is
    // read for. Hiding it would mean sending an email that says "something happened".
    //
    // The actor is NOT named (COPY-H-2): income validation is done by the accountant OR the admin
    // (`@Roles('ADMIN', 'ACCOUNTANT')` on `PATCH :id/validate`), and the `data`
    // of this type has no actor at all.
    subject:
      d.status === 'VALIDATED'
        ? renderMessage(i18n, M.statusValidatedSubject)
        : renderMessage(i18n, M.statusRejectedSubject),
    lines:
      d.status === 'VALIDATED'
        ? [renderMessage(i18n, M.sharedAmountAndDetailsLine)]
        : [renderMessage(i18n, M.statusRejectedLine)],
  }),

  TEAM_MEMBER_ADDED: (d, i18n) => ({
    // The body does NOT restate the subject (COPY-M-1): a person who opens the email and
    // learns nothing new is taught not to open the next ones.
    subject: renderMessage(i18n, M.teamMemberAddedSubject, { teamName: d.teamName }),
    lines: [renderMessage(i18n, M.teamMemberAddedLine)],
  }),

  PROJECT_MEMBER_ADDED: (d, i18n) => ({
    subject: renderMessage(i18n, M.projectMemberAddedSubject, { projectName: d.projectName }),
    lines: [renderMessage(i18n, M.projectMemberAddedLine)],
  }),

  TEAM_NEW_MEMBER: (d, i18n) => ({
    // The newcomer's name stays in the CRM: the email does not name people (§10 — we keep
    // what goes to a personal mailbox to a minimum).
    subject: renderMessage(i18n, M.teamNewMemberSubject, { teamName: d.teamName }),
    lines: [renderMessage(i18n, M.teamNewMemberLine)],
  }),

  PROJECT_CONFIRM_REQUIRED: (d, i18n) => ({
    subject: renderMessage(i18n, M.projectConfirmSubject, { projectName: d.projectName }),
    lines: [
      renderMessage(i18n, M.projectConfirmLine1, { projectName: d.projectName }),
      renderMessage(i18n, M.projectConfirmLine2),
    ],
  }),

  SHARE_CONFIRM_REQUIRED: (d, i18n) => {
    // The share kind decides, not only the project name: the data shape allows a pair
    // "BASE + the surviving name", and if we read one name, a base proposal
    // would be presented as a project one. ANY of two reasons is enough to do without
    // the name (`scope === 'BASE'` OR `projectName === null`): the subject "for project «»" is
    // garbage.
    const projectName = d.scope === 'BASE' ? null : d.projectName
    return {
      subject:
        projectName === null
          ? renderMessage(i18n, M.shareConfirmSubjectBase)
          : renderMessage(i18n, M.shareConfirmSubjectProject, { projectName }),
      lines: [
        projectName === null
          ? renderMessage(i18n, M.shareConfirmLine1Base)
          : renderMessage(i18n, M.shareConfirmLine1Project, { projectName }),
        // §11: "Without this, the person who sees the subject decides that something of theirs
        // has changed".
        renderMessage(i18n, M.shareConfirmLine2),
      ],
    }
  },

  DOCUMENT_SIGN_REQUIRED: (_d, i18n) => ({
    // §11 proposed "{document type} for {period}", but the period is absent from the data:
    // the producer puts `documentKind: 'EMPLOYEE_CONTRACT'`
    // (`employee-contracts.service.ts`) — an employee contract has no period.
    // A colon with a single word after it reads as an unfinished template (COPY-L-4),
    // so the slot was removed, but the uniform "Request to …" prefix
    // was kept: it is what signals that a reply is awaited.
    subject: renderMessage(i18n, M.documentSignSubject),
    lines: [renderMessage(i18n, M.documentSignLine)],
  }),

  APPROVAL_CONFIRMED: (d, i18n) => ({
    subject: renderMessage(i18n, M.approvalConfirmedSubject),
    lines: [acceptedLine(d.subjectKind, d.subjectTitle, i18n)],
  }),

  APPROVAL_REJECTED: (d, i18n) => ({
    subject: renderMessage(i18n, M.approvalRejectedSubject),
    // The refusal reason lives in the CRM: these are a specific person's words about money,
    // and there is no reason to send them to a personal mailbox (§10).
    lines: [
      rejectedLine(d.subjectKind, d.subjectTitle, i18n),
      renderMessage(i18n, M.approvalReasonLine),
    ],
  }),

  // Invoices and vacancies: emails do not go to a personal mailbox
  // (`notification-email-outbox.ts`, `LEGACY_TYPE`), but `BODIES` must carry an entry
  // for every `NewNotificationType`, and a direct call to the renderer must work.
  // §10/§11: no PII, no figures — a vacancy title is the object's name, not a person.
  INVOICE_SIGNED: (_d, i18n) => ({
    subject: renderMessage(i18n, M.invoiceSignedSubject),
    lines: [renderMessage(i18n, M.sharedDetailsLine)],
  }),

  INVOICE_SIGN_REQUIRED: (_d, i18n) => ({
    subject: renderMessage(i18n, M.invoiceSignRequiredSubject),
    lines: [renderMessage(i18n, M.sharedAmountAndDetailsLine)],
  }),

  VACANCY_APPLICATION: (d, i18n) => ({
    subject: renderMessage(i18n, M.vacancyApplicationSubject, { vacancyTitle: d.vacancyTitle }),
    lines: [renderMessage(i18n, M.sharedDetailsLine)],
  }),

  // U5a, ADMIN only (the producer's recipient rule). The only types whose email carries more than
  // the object name: source ids and counts are operational data for ADMINs, with no person and no
  // URL in them.
  SOURCE_HEALTH_ALERT: (d, i18n) => ({
    subject: renderMessage(i18n, M.sourceAlertSubject, { source: d.sourceName }),
    lines: [
      renderMessage(i18n, M.sourceAlertLine, sourceAlertParams(d, i18n.locale as Locale)),
      renderMessage(i18n, M.sharedDetailsLine),
    ],
  }),

  SOURCE_HEALTH_WEEKLY_REPORT: (d, i18n) => ({
    subject: renderMessage(i18n, M.sourceWeeklySubject),
    lines: [
      renderMessage(i18n, M.sourceWeeklyHeadLine, {
        weekStart: formatDay(d.weekStart, i18n.locale as Locale),
      }),
      ...d.sources.map((s) => {
        const params = {
          source: s.name,
          state: s.state,
          // A zero is not a fact worth a clause in a healthy source's line.
          // Stryker disable next-line StringLiteral: the ICU select branches only on 'yes'; 'no' and '' both take `other` and render byte-identical text in uk and en (checked with renderMessage).
          hasChanges: s.transitions > 0 ? 'yes' : 'no',
          transitions: s.transitions,
          runs: s.runs,
          requests: s.requests,
          megabytes: Math.round(s.bytes / 100_000) / 10,
        }
        return s.freshnessP50Min === null || s.freshnessP90Min === null
          ? renderMessage(i18n, M.sourceWeeklyLineUnmeasured, params)
          : renderMessage(i18n, M.sourceWeeklyLineMeasured, {
              ...params,
              p50: s.freshnessP50Min,
              p90: s.freshnessP90Min,
            })
      }),
    ],
  }),
}

type ApprovalSubjectKind = 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE'

/** A pair of whole sentences: with the object's name and without it (the snapshot did not store it). */
interface ApprovalPair {
  titled: typeof M.acceptedProject
  untitled: typeof M.acceptedProjectUntitled
}

/**
 * Two emails to the admin — TWO maps of sentences and two entries (`acceptedLine` /
 * `rejectedLine`), not a single function with a decision parameter.
 *
 * This is done for observability, and it is not a guess: a parameter of two values
 * produces a mutant that cannot be killed by construction. The branch
 * `decision === 'ACCEPTED' ? … : …` gives the same string for ANY
 * non-`'ACCEPTED'` value, so the literal `'REJECTED'` at the call site could be
 * replaced with an empty string, and no test would notice — the mutation gate reported exactly
 * that. The entries stay two; the difference is carried by the map itself.
 *
 * Each sentence is a WHOLE catalog message: the earlier gluing of fragments
 * ("in the project" + "X" …) was replaced by choosing a ready phrase, because a fragment
 * cannot be translated separately from the sentence it is inserted into.
 *
 * The employee is not named (the same rule as everywhere); the decision's OBJECT is named —
 * that is how the admin understands which of their proposals is meant.
 * The verb got its object (COPY-M-3): one accepts the PROPOSAL, while "accepted
 * the project" in this domain means "approved the project as a whole", which
 * is done by the admin, not by the person who was invited to the project.
 */
const ACCEPTED: Record<ApprovalSubjectKind, ApprovalPair> = {
  PROJECT: { titled: M.acceptedProject, untitled: M.acceptedProjectUntitled },
  PROJECT_SHARE: { titled: M.acceptedProjectShare, untitled: M.acceptedProjectShareUntitled },
  // A base share has no name by construction: both branches are the same sentence.
  BASE_SHARE: { titled: M.acceptedBaseShare, untitled: M.acceptedBaseShare },
}

const REJECTED: Record<ApprovalSubjectKind, ApprovalPair> = {
  PROJECT: { titled: M.rejectedProject, untitled: M.rejectedProjectUntitled },
  PROJECT_SHARE: { titled: M.rejectedProjectShare, untitled: M.rejectedProjectShareUntitled },
  BASE_SHARE: { titled: M.rejectedBaseShare, untitled: M.rejectedBaseShare },
}

function approvalLine(
  pairs: Record<ApprovalSubjectKind, ApprovalPair>,
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  const pair = pairs[subjectKind]
  return subjectTitle === null
    ? renderMessage(i18n, pair.untitled)
    : renderMessage(i18n, pair.titled, { subjectTitle })
}

function acceptedLine(
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  return approvalLine(ACCEPTED, subjectKind, subjectTitle, i18n)
}

function rejectedLine(
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
  i18n: I18n,
): string {
  return approvalLine(REJECTED, subjectKind, subjectTitle, i18n)
}

/**
 * The email button label. Informational types take the same label as the popup
 * (`ACTION_LABELS` — one dictionary for both channels; there is no separate copy in the email);
 * the admin's decision emails distinguish the kind of object: USER — a decision on the
 * employee's base share (profile), otherwise — a project; everything else — the common
 * generic "Open" label (in both locales).
 */
function emailActionLabelFor(
  type: string,
  subjectType: NotificationSubjectType,
  i18n: I18n,
): string {
  if (type === 'APPROVAL_CONFIRMED' || type === 'APPROVAL_REJECTED') {
    return renderMessage(
      i18n,
      subjectType === 'USER'
        ? MISC_MESSAGES.actionApprovalProfile
        : MISC_MESSAGES.actionApprovalProject,
    )
  }
  if (
    type === 'TRANSACTION_ADDED' ||
    type === 'TRANSACTION_STATUS_CHANGED' ||
    type === 'TEAM_MEMBER_ADDED' ||
    type === 'PROJECT_MEMBER_ADDED' ||
    type === 'TEAM_NEW_MEMBER'
  ) {
    return renderMessage(i18n, ACTION_LABELS[type])
  }
  // An unregistered (legacy) type with an object address — the generic "Open".
  return renderMessage(i18n, MISC_MESSAGES.open)
}

/**
 * The email button — the route via `notificationHref` (a pure function, the locale does not
 * know), the label via `emailActionLabelFor`. The structure is exactly as before: NOT
 * the registry's `notificationActions()` — that one prefers `link` for legacy types over the
 * `subjectType/subjectId` pair, and would change addresses (pinned by the structural
 * `buttonHref` pins in the spec).
 */
function emailAction(
  source: NotificationEmailSource,
  i18n: I18n,
): { href: string; label: string } | null {
  if (source.subjectType !== null && source.subjectId !== null) {
    return {
      href: notificationHref(source.subjectType, source.subjectId),
      label: emailActionLabelFor(source.type, source.subjectType, i18n),
    }
  }
  // Stryker disable next-line ConditionalExpression: at this point `source.link` is only ever `null` or a string. Forcing this branch always-true when `source.link` is null returns `{ href: null, label: <open> }`, and the caller's own `action?.href ?? '/'` / `action?.href == null ? <open CRM> : ...` fallbacks make that byte-identical to returning `null` here (see the spec case where a button without a link is labelled "Open the CRM") — no observable difference either way.
  if (source.link !== null) {
    return { href: source.link, label: renderMessage(i18n, MISC_MESSAGES.open) }
  }
  return null
}

/**
 * Build an email from a notification row in the recipient's language.
 *
 * Never returns `null`: a type the template does not know, and data of an unexpected
 * shape, produce an email from the stored title and link. Sending is a
 * channel, not a retelling of the event; silently not sending is worse than sending
 * a shorter one.
 */
export function renderNotificationEmail(
  source: NotificationEmailSource,
  opts: RenderOptions,
): RenderedNotificationEmail {
  const root = opts.frontendUrl.replace(/\/$/, '')
  // A fresh instance for each email — no shared state between recipients.
  const i18n = createI18n(opts.locale)

  // The three types that require a reply lead to `/pending` — the screen where a reply can
  // actually be given (task, item 4 and "Orchestrator clarifications"; SPEC-H-3 / CR-H-4).
  // Round 1 called `notificationActions()` without distinguishing and got a path to the
  // OBJECT: for `PROJECT_CONFIRM_REQUIRED` that is `/projects/:id`, where there are no
  // confirmation buttons at all, and for `DOCUMENT_SIGN_REQUIRED` — `/onboarding`.
  //
  // The label is "Respond to the request" (COPY-L-5): "Open the project" on a button
  // leading to the list of requests would name something other than what opens.
  const action = isActionRequiredNotificationType(source.type)
    ? { href: PENDING_PATH, label: renderMessage(i18n, M.sharedRespondButton) }
    : emailAction(source, i18n)
  // The button is one, and there is always somewhere for it to lead: the object is 15 seconds old, and
  // the "object no longer exists" state is not something the email can catch by construction. The root
  // of the CRM is the fallback for an old type without a stored link.
  const buttonHref = `${root}${action?.href ?? '/'}`
  const buttonLabel =
    action?.href == null ? renderMessage(i18n, M.sharedOpenCrmButton) : action.label

  const body = composeBody(source, i18n)

  return {
    // `stripCrlf`: the subject goes into the email's HEADER, and the object name comes from
    // user input, where `z.string().max(255)` allows a line break
    // (SR-M-1, the same guard and the same reason as in
    // `contact.service.ts`). The body does not need it — a line break there
    // is legal.
    subject: stripCrlf(body.subject),
    // The button label before the address (COPY-L-1): in html the reader sees
    // the label, in text — a bare address, and a single label makes the text version
    // equally clear.
    text: [...body.lines, '', `${buttonLabel}: ${buttonHref}`].join('\n'),
    html: renderEmailLayout({
      blocks: body.lines.map((line, i) => ({
        html: escapeHtml(line),
        // The last line is indented more — it separates the text from the button.
        spaceAfter: i === body.lines.length - 1 ? 24 : 16,
      })),
      button: { href: buttonHref, label: buttonLabel },
      lang: opts.locale,
    }),
    buttonHref,
    buttonLabel,
  }
}

function composeBody(source: NotificationEmailSource, i18n: I18n): Body {
  if (isNewNotificationType(source.type)) {
    const parsed = notificationDataSchemaFor(source.type).safeParse(source.data)
    if (parsed.success) {
      const build = BODIES[source.type] as (d: unknown, i18n: I18n) => Body
      return build(parsed.data, i18n)
    }
    // The data shape changed, but the row stayed old. The type's title
    // is neutral by construction (`NOTIFICATION_TITLE_MESSAGES`), so it
    // is safe both as a subject and as the single line.
    return {
      subject: renderMessage(i18n, NOTIFICATION_TITLE_MESSAGES[source.type]),
      lines: [renderMessage(i18n, M.sharedDetailsLine)],
    }
  }
  // A type the template does not yet know: the stored `title`/`body` are DATA,
  // printed as-is in any locale; the common placeholder comes from the catalog.
  return {
    subject: source.title,
    lines: [source.body ?? renderMessage(i18n, M.sharedDetailsLine)],
  }
}
