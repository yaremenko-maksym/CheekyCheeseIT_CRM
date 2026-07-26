/**
 * ResendMailerService — task-landing-contact-and-hiring-strip.
 *
 * Thin wrapper around the Resend HTTP API (`POST
 * https://api.resend.com/emails`) — plain `fetch`, no `resend` npm SDK (task
 * §Провайдер: "БЕЗ новых npm-зависимостей"). Fetch/AbortController pattern
 * mirrors `TurnstileService.verify` / `GoogleIndexingService.fetchWithTimeout`.
 *
 * No-op-detection mode (mirrors `GoogleIndexingService`'s `RESEND_API_KEY`-
 * absent handling, NOT its fail-soft contract): when `RESEND_API_KEY` is
 * unset, the constructor logs ONE boot warning and `isConfigured` is
 * `false`. Unlike `GoogleIndexingService`, `send()` itself does NOT silently
 * no-op — `ContactService` checks `isConfigured` up front and returns a 503
 * before ever calling `send()`, so a caller that calls `send()` anyway (a
 * programming error) gets a loud thrown error, not a silently swallowed one.
 *
 * `send()` throws on ANY failure (non-2xx, network error, timeout) — retry/
 * backoff and the final-failure telemetry log are `ContactService`'s
 * responsibility (single retry policy for the one caller, not duplicated
 * here).
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'

const RESEND_API_URL = 'https://api.resend.com/emails'

/** Fetch timeout for the Resend send call — mirrors TurnstileService.FETCH_TIMEOUT_MS. */
const FETCH_TIMEOUT_MS = 10_000

/** Longest error-body slice kept in a thrown Error's message (avoid unbounded log lines). */
const ERROR_BODY_SNIPPET_MAX = 200

export interface SendEmailInput {
  to: string[]
  subject: string
  text: string
  html: string
  /** Sets the outgoing email's `Reply-To` — the visitor's own address, so an
   * ADMIN can reply directly from their inbox (task §Отправка). */
  replyTo: string
}

@Injectable()
export class ResendMailerService {
  private readonly logger = new Logger(ResendMailerService.name)
  private readonly apiKey: string | undefined
  private readonly fromEmail: string

  constructor(private readonly config: ConfigService<Env, true>) {
    this.apiKey = this.config.get('RESEND_API_KEY', { infer: true })
    this.fromEmail = this.config.get('CONTACT_FROM_EMAIL', { infer: true })

    if (!this.apiKey) {
      this.logger.warn(
        'RESEND_API_KEY is not configured — the public contact-form endpoint ' +
          '(POST /api/public/contact) will respond 503 with the CONTACT_PUBLIC_EMAIL ' +
          'fallback until a real key is provisioned.',
      )
    }
  }

  /** `true` once `RESEND_API_KEY` is provisioned — callers must check this before `send()`. */
  get isConfigured(): boolean {
    return Boolean(this.apiKey)
  }

  async send(input: SendEmailInput): Promise<void> {
    if (!this.apiKey) {
      // Defensive only — every real call site guards on `isConfigured` first
      // (ContactService returns 503 before ever reaching here).
      throw new Error('ResendMailerService.send() called while RESEND_API_KEY is not configured')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          reply_to: input.replyTo,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(
          `Resend API HTTP ${res.status}${body ? `: ${body.slice(0, ERROR_BODY_SNIPPET_MAX)}` : ''}`,
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
