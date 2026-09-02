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

  async sendInvite(input: SendInviteInput): Promise<void> {
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
      return
    }

    const link = `${this.apiUrl}/auth/invite/${input.rawToken}`
    const subject = 'Доступ к CRM CheekyCheeseIT'
    const displayName = escapeHtml(input.displayName)

    // Spec §11 rules, verbatim: one button, no thank-you/pleasantries, last
    // line is a protective disclaimer (not politeness) — see the module doc
    // and the task file's own quote of the owner-approved copy. Table-based
    // layout + inline styles — spec §12: "Почтовые клиенты — не браузеры".
    const html = `<!DOCTYPE html>
<html lang="ru">
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px 32px;">
              <p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#18181b;">
                ${displayName}, этот адрес указан как ваш личный email в CRM CheekyCheeseIT.
              </p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:24px;color:#18181b;">
                Перейдите по ссылке и войдите через Google, чтобы использовать этот адрес для входа.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:#18181b;">
                    <a href="${link}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:bold;">Войти в CRM</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0 0;font-size:13px;line-height:20px;color:#71717a;">
                Если письмо пришло по ошибке, не переходите по ссылке.
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
      `${input.displayName}, этот адрес указан как ваш личный email в CRM CheekyCheeseIT.`,
      '',
      'Перейдите по ссылке и войдите через Google, чтобы использовать этот адрес для входа:',
      link,
      '',
      'Если письмо пришло по ошибке, не переходите по ссылке.',
    ].join('\n')

    await this.sendWithRetry({ to: [input.to], subject, text, html, replyTo: this.replyTo })
  }

  private async sendWithRetry(input: {
    to: string[]
    subject: string
    text: string
    html: string
    replyTo: string
  }): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await this.mailer.send(input)
        return
      } catch (err) {
        lastError = err
        this.logger.warn(
          `sendInvite(): Resend send attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS)
        }
      }
    }

    // PII note: never log the recipient address — only the failure reason
    // and the fixed route string, mirroring ContactService.sendWithRetry.
    await this.telemetry.recordError({
      source: 'API',
      message: 'Personal-email invite delivery failed after retries',
      route: '/api/users',
      meta: { reason: lastError instanceof Error ? lastError.message : String(lastError) },
    })
    // Deliberately swallowed — see module doc for why this must not throw.
  }
}
