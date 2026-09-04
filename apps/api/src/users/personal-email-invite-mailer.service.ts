/**
 * PersonalEmailInviteMailerService — task-user-emails-invite (spec §11, §12).
 *
 * Sends the "Доступ к CRM CheekyCheeseIT" invite email a PERSONAL
 * `user_emails` row gets at creation time (and again on an ADMIN resend —
 * see `UsersService.resendPersonalEmailInvite`). Reuses `ResendMailerService`
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Escapes the one piece of admin-entered free text this template
 * interpolates (`displayName`) — same defense `ContactService.escapeHtml`
 * applies to the visitor's message, for the same reason: it lands in an
 * HTML body viewed in a real mail client.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
    const subject = 'Доступ к CRM CheekyCheeseIT'
    // copy-review PR #623 (COPY-L-2): the DB carries the full legal display
    // name (often Latin-script, e.g. "Oleksiy Kovalenko") — greeting by the
    // full name in a Russian-language email reads as a mail-merge. First
    // whitespace-separated token only; falls back to the whole string for a
    // single-word name (never empty — `displayName` is required at creation).
    // Stryker disable next-line Regex: only `[0]` (everything BEFORE the first whitespace match) is ever read — `/\s+/` vs `/\s/` locate the identical first-match position for any input, so no test could ever distinguish them; verified by hand against "Oleksiy   Kovalenko" (multiple internal spaces) — both regexes give `[0] === "Oleksiy"`.
    const rawFirstName = input.displayName.trim().split(/\s+/)[0] ?? input.displayName
    const firstName = escapeHtml(rawFirstName)

    // Spec §11 rules, verbatim: one button, no thank-you/pleasantries, last
    // line is a protective disclaimer (not politeness) — see the module doc
    // and the task file's own quote of the owner-approved copy. Table-based
    // layout + inline styles — spec §12: "Почтовые клиенты — не браузеры".
    // copy-review PR #623 (COPY-H-1/M-4/M-5/M-9): button names the actual
    // outcome ("Подтвердить адрес", not "Войти в CRM" — the link does not
    // mint a session, see AuthController.googleCallback's invite branch);
    // body states the cost of doing nothing (COPY-M-4); the disclaimer is
    // full body weight + bold, not the smallest/palest text on the page
    // (COPY-M-5); outer table is `width="100%" max-width:480px` with a
    // viewport meta tag so a mobile client scales it instead of forcing a
    // horizontal scrollbar (COPY-M-9, measured at 320px).
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px 32px;">
              <p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#18181b;">
                ${firstName}, этот адрес добавили в CRM CheekyCheeseIT как ваш личный.
              </p>
              <p style="margin:0 0 4px 0;font-size:16px;line-height:24px;color:#18181b;">
                Подтвердите его — тогда входить можно будет и с рабочего адреса, и с этого.
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Пока не подтвердите, вход работает только по рабочему.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${link}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Подтвердить адрес</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0 0;font-size:16px;line-height:24px;color:#18181b;">
                Если письмо пришло по ошибке, <strong>не переходите по ссылке</strong>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

    const text = [
      `${rawFirstName}, этот адрес добавили в CRM CheekyCheeseIT как ваш личный.`,
      '',
      'Подтвердите его — тогда входить можно будет и с рабочего адреса, и с этого.',
      'Пока не подтвердите, вход работает только по рабочему.',
      '',
      link,
      '',
      'Если письмо пришло по ошибке, не переходите по ссылке.',
    ].join('\n')

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
