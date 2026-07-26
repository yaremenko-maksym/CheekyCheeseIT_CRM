/**
 * ContactService — task-landing-contact-and-hiring-strip.
 *
 * Owns the public, unauthenticated "Start a project" contact-form pipeline
 * (`POST /api/public/contact`, owner decision §1-2 in the task file). Fail-
 * fast order — mirrors `ApplicationsService.apply`'s documented pipeline:
 * rate-limit is enforced at the controller (`@RelaxableThrottle`, not here)
 * → honeypot → Zod field validation → Turnstile → Resend-configured check →
 * ADMIN recipient lookup → sanitize → send (with retry) → 502 + telemetry
 * log on final failure.
 *
 * The submitted request is NEVER persisted to the database (owner decision
 * #2) — this service's only durable side effect is a `telemetry_errors` row
 * on a delivery failure (via `TelemetryErrorsService`), so an assistant can
 * notice repeated failures; the submission content itself only ever reaches
 * the outgoing email.
 *
 * Security-critical (this endpoint sends real email — see task file
 * "Особое внимание"):
 *   - `stripCrlf` removes `\r`/`\n` from every value that lands in an email
 *     HEADER-adjacent field (`subject`, the visible `name`/`company`/`email`
 *     lines, and `replyTo`) — defense against header-injection even though
 *     Resend's API is JSON (not raw SMTP), because unsanitized `\r\n` inside
 *     a JSON string value would still let a submitter smuggle extra header-
 *     looking lines into however Resend's backend composes the raw message.
 *   - `escapeHtml` escapes every user-controlled value embedded in the HTML
 *     body — the visitor's own `message` free text is the highest-risk
 *     field (arbitrary length, arbitrary content) and is ALWAYS run through
 *     it before interpolation, so it can never inject markup into an
 *     ADMIN's mail client.
 */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import { contactRequestSchema } from '@crm/shared'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { users } from '../database/schema'
import { TelemetryErrorsService } from '../telemetry/telemetry-errors.service'
import { TurnstileService } from '../vacancies/turnstile.service'
import { ResendMailerService, type SendEmailInput } from './resend-mailer.service'

/** "2 попытки с бэкоффом" (task §Ретрай) — first send + ONE retry. */
const MAX_SEND_ATTEMPTS = 2
/** Backoff before the single retry attempt. */
const RETRY_BACKOFF_MS = 500

function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name)
  private readonly publicEmail: string

  constructor(
    private readonly db: DatabaseService,
    private readonly turnstile: TurnstileService,
    private readonly mailer: ResendMailerService,
    private readonly telemetry: TelemetryErrorsService,
    config: ConfigService<Env, true>,
  ) {
    this.publicEmail = config.get('CONTACT_PUBLIC_EMAIL', { infer: true })
  }

  /**
   * @param rawFields the parsed JSON request body, still `unknown` shape —
   *   the honeypot MUST be read from this raw value before
   *   `contactRequestSchema.parse()` (see the honeypot comment below), same
   *   ordering constraint as `ApplicationsService.apply`.
   * @param remoteIp `req.ip` — passed straight through to Turnstile's
   *   `remoteip` verification param, never logged.
   */
  async submit(rawFields: unknown, remoteIp: string | undefined): Promise<{ ok: true }> {
    const raw =
      rawFields !== null && typeof rawFields === 'object'
        ? (rawFields as Record<string, unknown>)
        : {}

    // ---- 1. Honeypot — raw check BEFORE schema validation ----
    // A bot that fills the honeypot gets a fake success so it never learns
    // which check tripped it (mirrors ApplicationsService.apply §1).
    const honeypot = raw['website']
    if (typeof honeypot === 'string' && honeypot.length > 0) {
      this.logger.warn('submit(): honeypot field non-empty — mimicking success')
      return { ok: true }
    }

    // ---- 2. Validate ----
    const fields = contactRequestSchema.parse(rawFields)

    // ---- 3. Turnstile ----
    const turnstileOk = await this.turnstile.verify(fields.turnstileToken, remoteIp)
    if (!turnstileOk) {
      throw new BadRequestException('Проверка Turnstile не пройдена')
    }

    // ---- 4. RESEND_API_KEY not provisioned yet — graceful degrade ----
    if (!this.mailer.isConfigured) {
      throw new ServiceUnavailableException(
        `Форма отправки временно недоступна — напишите нам на ${this.publicEmail}`,
      )
    }

    // ---- 5. Recipients: every ADMIN user ----
    const admins = await this.db.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.role, 'ADMIN'))
    if (admins.length === 0) {
      this.logger.error(
        'submit(): no ADMIN recipients found in DB — cannot deliver contact request',
      )
      throw new BadGatewayException(
        `Не удалось отправить заявку — напишите нам на ${this.publicEmail}`,
      )
    }
    const recipients = admins.map((a) => a.email)

    // ---- 6. Sanitize + compose (see module doc security notes) ----
    const name = stripCrlf(fields.name)
    const company = fields.company ? stripCrlf(fields.company) : undefined
    const email = stripCrlf(fields.email)
    const subject = stripCrlf(`Заявка с сайта — ${name}${company ? `, ${company}` : ''}`)

    const text = [
      `Имя: ${name}`,
      company ? `Компания: ${company}` : null,
      `Email: ${email}`,
      '',
      fields.message,
    ]
      .filter((line): line is string => line !== null)
      .join('\n')

    const html = [
      `<p><strong>Имя:</strong> ${escapeHtml(name)}</p>`,
      company ? `<p><strong>Компания:</strong> ${escapeHtml(company)}</p>` : '',
      `<p><strong>Email:</strong> ${escapeHtml(email)}</p>`,
      '<p><strong>Сообщение:</strong></p>',
      `<p>${escapeHtml(fields.message).replace(/\n/g, '<br />')}</p>`,
    ]
      .filter(Boolean)
      .join('\n')

    // ---- 7. Send (with retry) ----
    await this.sendWithRetry({ to: recipients, subject, text, html, replyTo: email })

    return { ok: true }
  }

  /**
   * `MAX_SEND_ATTEMPTS` attempts with a fixed backoff between them. On total
   * failure: log via `TelemetryErrorsService` (so a repeated-delivery-
   * failure shows up in the telemetry digest an assistant reads — task
   * §Ретрай) then throw 502 with the same visitor-facing fallback copy as
   * every other failure mode in this service.
   */
  private async sendWithRetry(input: SendEmailInput): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await this.mailer.send(input)
        return
      } catch (err) {
        lastError = err
        this.logger.warn(
          `submit(): Resend send attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(RETRY_BACKOFF_MS)
        }
      }
    }

    // PII note: never log the visitor's name/email/message — only the
    // Resend failure reason (non-PII) and the fixed route string.
    await this.telemetry.recordError({
      source: 'API',
      message: 'Contact form email delivery failed after retries',
      route: '/api/public/contact',
      meta: { reason: lastError instanceof Error ? lastError.message : String(lastError) },
    })

    throw new BadGatewayException(
      `Не удалось отправить заявку — напишите нам на ${this.publicEmail}`,
    )
  }
}
