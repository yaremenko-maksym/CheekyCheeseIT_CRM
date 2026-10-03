/**
 * PersonalEmailInviteMailerService — task-user-emails-invite (spec §11, §12).
 *
 * Sends the "Access to CheekyCheeseIT CRM" invite email a PERSONAL `user_emails` row gets
 * at creation time (and again on an ADMIN resend — see
 * `UsersService.resendPersonalEmailInvite`). The copy lives in the `@crm/shared` catalog
 * (`EMAIL_INVITE_MESSAGES`, uk source + en) and is rendered in the INVITEE's locale
 * (`input.locale`), never the admin's. Reuses `ResendMailerService`
 * (task-landing-contact-and-hiring-strip) rather than a second HTTP client —
 * same `from`/reply-to config (`CONTACT_FROM_EMAIL` / `CONTACT_PUBLIC_EMAIL`),
 * no new env var.
 *
 * Retry policy mirrors `ContactService.sendWithRetry` exactly (2 attempts,
 * 500ms backoff) — the ONE difference from that service: a delivery failure
 * here does NOT throw upward. `ContactService` can afford to fail the HTTP
 * request it is answering (a visitor resubmits the form); `UsersService.
 * createUser` cannot — an admin creating an employee record must not have
 * that fail because an unrelated third-party mail API is down, and unlike a
 * public form submission, this failure is recoverable: the invite ROW and
 * its token already exist in the DB, so ADMIN can retry via
 * `resendPersonalEmailInvite` once the transient issue clears (task §5 is
 * this service's own safety net, not a coincidence). A failure is still
 * recorded via `TelemetryErrorsService` so it surfaces in the digest an
 * assistant reads, same as `ContactService`'s failure path.
 *
 * `RESEND_API_KEY` unset (dev, or prod before the key is provisioned) — same
 * no-op-detection contract `ResendMailerService.isConfigured` already
 * documents: this service logs + telemetry-records and returns, it does not
 * throw and does not block user creation. The invite row still exists, so an
 * admin can resend once a key is provisioned.
 *
 * copy-review PR #623 (COPY-M-1): `sendInvite` RETURNS whether delivery
 * actually succeeded (`false` on any exhausted-retry failure or missing API
 * key) instead of always resolving — a caller whose only user-visible signal
 * IS the send outcome (the resend-invite/change-personal-email toasts) must
 * not report "отправлено" when nothing left this process. `createUser`
 * deliberately still ignores the return value (see the comment above): user
 * creation itself must not fail on a mail-provider hiccup, and its own
 * response has no dedicated "was the invite email delivered" UI slot today.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createI18n, EMAIL_INVITE_MESSAGES as M, renderMessage, type Locale } from '@crm/shared'
import { renderEmailLayout } from '../common/email-layout'
import { emphasize, escapeHtml } from '../common/escape-html'
import type { Env } from '../config/env'
import { ResendMailerService } from '../contact/resend-mailer.service'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'

/** Mirrors ContactService.MAX_SEND_ATTEMPTS — "2 попытки с бэкоффом". */
const MAX_SEND_ATTEMPTS = 2
/** Mirrors ContactService.RETRY_BACKOFF_MS. */
const RETRY_BACKOFF_MS = 500

export interface SendInviteInput {
  to: string
  displayName: string
  /** Raw invite token — this is the ONLY place it is embedded into a URL. */
  rawToken: string
  /**
   * Locale of the INVITEE (`users.locale` of the person the mail is addressed to). Required: a
   * caller that forgets it fails typecheck instead of shipping the admin's or a default language.
   */
  locale: Locale
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

@Injectable()
export class PersonalEmailInviteMailerService {
  private readonly logger = new Logger(PersonalEmailInviteMailerService.name)
  private readonly frontendUrl: string
  private readonly apiUrl: string
  private readonly replyTo: string

  constructor(
    private readonly mailer: ResendMailerService,
    private readonly telemetry: TelemetryErrorsService,
    config: ConfigService<Env, true>,
  ) {
    this.frontendUrl = config.get('FRONTEND_URL', { infer: true })
    // The invite link points at the API directly (same pattern the login
    // page's own "Войти с Google" button already uses — see
    // apps/web/app/routes/login.tsx's `<a href="${API_URL}/auth/google">`)
    // — GET /api/auth/invite/:token immediately 302s to Google, no
    // frontend page needed for step 1 of the flow.
    this.apiUrl = `${this.frontendUrl.replace(/\/$/, '')}/api`
    this.replyTo = config.get('CONTACT_PUBLIC_EMAIL', { infer: true })
  }

  /**
   * Returns `true` when the mail was actually handed off to Resend
   * successfully, `false` on every other outcome (no API key configured, or
   * every retry attempt failed) — see the module doc (COPY-M-1) for why the
   * caller needs this instead of a bare `Promise<void>`.
   */
  async sendInvite(input: SendInviteInput): Promise<boolean> {
    if (!this.mailer.isConfigured) {
      this.logger.warn(
        `sendInvite(): RESEND_API_KEY not configured — invite token was created but no email was sent (use "resend invite" once a key is provisioned)`,
      )
      await this.telemetry.recordError({
        source: 'API',
        message: 'Personal-email invite not sent — RESEND_API_KEY not configured',
        route: '/api/users',
        meta: {},
      })
      return false
    }

    const link = `${this.apiUrl}/auth/invite/${input.rawToken}`
    // The INVITEE's locale (`users.locale` of the person this mail is addressed to), passed in
    // by the caller — never the admin's request locale. Per-call instance: no global
    // `i18n.activate`, nothing stored on the service, so two invites in flight cannot bleed.
    const i18n = createI18n(input.locale)
    const subject = renderMessage(i18n, M.subject)
    // copy-review PR #623 (COPY-L-2): the DB carries the full legal display
    // name (often Latin-script, e.g. "Oleksiy Kovalenko") — greeting by the
    // full name reads as a mail-merge. First whitespace-separated token only;
    // falls back to the whole string for a single-word name (never empty —
    // `displayName` is required at creation).
    // Stryker disable next-line Regex: only `[0]` (everything BEFORE the first whitespace match) is ever read — `/\s+/` vs `/\s/` locate the identical first-match position for any input, so no test could ever distinguish them; verified by hand against "Oleksiy   Kovalenko" (multiple internal spaces) — both regexes give `[0] === "Oleksiy"`.
    const firstName = input.displayName.trim().split(/\s+/)[0] ?? input.displayName

    // Every sentence is ONE whole catalog message (no fragments assembled here). The name is user
    // input: the greeting is rendered as plain text first (ICU does not escape params), then the
    // WHOLE rendered sentence is escaped for the HTML twin; the text twin and subject use the raw
    // string.
    const greeting = renderMessage(i18n, M.greeting, { firstName })
    const line1 = renderMessage(i18n, M.confirmLine1)
    const line2 = renderMessage(i18n, M.confirmLine2)
    const buttonLabel = renderMessage(i18n, M.button)
    const warning = renderMessage(i18n, M.footerWarning)
    const footer = renderMessage(i18n, M.footer, { warning })

    // Spec §11 rules, verbatim: one button, no thank-you/pleasantries, last
    // line is a protective disclaimer (not politeness). Table-based layout +
    // inline styles — spec §12: "Почтовые клиенты — не браузеры".
    // copy-review PR #623 (COPY-H-1/M-4/M-5/M-9): the button names the actual
    // outcome (the link does not mint a session, see AuthController.
    // googleCallback's invite branch); the body states the cost of doing
    // nothing (COPY-M-4); the disclaimer is full body weight + bold, not the
    // palest text on the page (COPY-M-5); outer table is `width="100%"
    // max-width:480px` with a viewport meta tag (COPY-M-9).
    // The frame is shared (`common/email-layout.ts`) with the notification emails
    // (SPEC-M-2, spec-review PR #673).
    //
    // `escapeHtml` on every rendered sentence (SR-L-8): catalog text and the invitee's name both
    // go through it, so no raw string reaches the HTML. The one markup spot — `<strong>` on the
    // warning phrase inside the footer — is `emphasize`, which escapes both sides itself.
    const html = renderEmailLayout({
      lang: input.locale,
      blocks: [
        { html: escapeHtml(greeting), spaceAfter: 16 },
        {
          html: escapeHtml(line1),
          // Четыре, а не шестнадцать: эта строка и следующая — одна мысль,
          // разбитая на две для читаемости.
          spaceAfter: 4,
        },
        { html: escapeHtml(line2), spaceAfter: 24 },
      ],
      button: { href: link, label: buttonLabel },
      // Защитная оговорка, а не вежливость (§11) — полным весом и жирным (COPY-M-5, PR #623).
      footer: emphasize(footer, warning),
    })

    const text = [greeting, '', line1, line2, '', link, '', footer].join('\n')

    return this.sendWithRetry({ to: [input.to], subject, text, html, replyTo: this.replyTo })
  }

  private async sendWithRetry(input: {
    to: string[]
    subject: string
    text: string
    html: string
    replyTo: string
  }): Promise<boolean> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await this.mailer.send(input)
        return true
      } catch (err) {
        lastError = err
        // LOW-3 (security-review PR #623 round 4): `err.message` can echo
        // back Resend's own response body, which sometimes quotes the
        // rejected recipient address — see `safeErrorReason`'s doc below.
        // The per-attempt WARN line is exactly the same leak channel as the
        // telemetry record two catches down, just to a different sink.
        this.logger.warn(
          `sendInvite(): Resend send attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${safeErrorReason(err)}`,
        )
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS)
        }
      }
    }

    // PII note (LOW-3, security-review PR #623 round 4): `lastError.message`
    // can echo back the value Resend rejected — e.g. its own validation
    // error quotes the malformed recipient address, which is exactly the
    // PII this file otherwise never logs (ContactService.sendWithRetry's own
    // rule, mirrored here). Record a fixed, non-quoting reason instead of
    // the raw message — the failure is still visible in the digest an
    // assistant reads, just without echoing anything the provider sent back.
    await this.telemetry.recordError({
      source: 'API',
      message: 'Personal-email invite delivery failed after retries',
      route: '/api/users',
      meta: { reason: safeErrorReason(lastError) },
    })
    // Deliberately swallowed — see module doc for why this must not throw.
    return false
  }
}

/**
 * LOW-3 (security-review PR #623 round 4): `ResendMailerService.send`
 * throws a plain `Error` whose `.message` is `Resend API HTTP <status>: <body
 * snippet>` (`resend-mailer.service.ts`) — the body snippet is Resend's OWN
 * error text, which for a malformed/rejected recipient sometimes quotes that
 * address back. Neither log sink in this file is allowed to carry PII
 * (module doc, mirroring `ContactService`), so this extracts ONLY the
 * `HTTP <status>` prefix when the message has that shape — useful enough to
 * tell "bad request" from "provider down" apart in the digest — and falls
 * back to the error's constructor name (e.g. `TypeError` for a network
 * failure) otherwise. Never returns anything from `.message` itself.
 */
function safeErrorReason(err: unknown): string {
  if (err instanceof Error) {
    const statusMatch = /^Resend API HTTP (\d+)/.exec(err.message)
    if (statusMatch) return `Resend API HTTP ${statusMatch[1]}`
    return err.constructor.name
  }
  return 'unknown'
}
