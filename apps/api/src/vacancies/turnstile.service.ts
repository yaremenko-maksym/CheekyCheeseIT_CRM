/**
 * TurnstileService — task-vacancies-api.
 *
 * Verifies a Cloudflare Turnstile token against
 * `https://challenges.cloudflare.com/turnstile/v0/siteverify` (form-encoded
 * POST). Used exclusively by the public vacancy-apply pipeline
 * (ApplicationsService.apply) as one of the anti-spam layers.
 *
 * Fetch pattern mirrors EtherscanService.fetchWithTimeout — AbortController
 * with a hard timeout so a slow/unreachable Cloudflare endpoint cannot hang
 * the request indefinitely.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Fetch timeout for the Turnstile siteverify call. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * Cloudflare's documented "always passes" test secret — used as the env
 * default for dev/CI. Never valid in production; see the dev-safety warning
 * in the constructor (mirrors EtherscanService's ETHERSCAN_API_KEY pattern).
 */
const DEV_DUMMY_SECRET = '1x0000000000000000000000000000000AA'

interface SiteverifyResponse {
  success: boolean
  ['error-codes']?: string[]
}

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name)
  private readonly secretKey: string

  constructor(private readonly config: ConfigService<Env, true>) {
    this.secretKey = this.config.get('TURNSTILE_SECRET_KEY', { infer: true })
    const nodeEnv = this.config.get('NODE_ENV', { infer: true })
    if (nodeEnv === 'production' && this.secretKey === DEV_DUMMY_SECRET) {
      this.logger.error(
        'TURNSTILE_SECRET_KEY is the dev dummy secret in production — the public ' +
          'vacancy-apply endpoint will accept ANY token. Configure a real secret.',
      )
    }
  }

  /**
   * Verifies a Turnstile token. Returns `true` only on an explicit
   * `success: true` from Cloudflare. ANY failure mode (network error,
   * timeout, non-2xx, `success: false`) resolves to `false` — the caller
   * (ApplicationsService) is responsible for turning that into a 400.
   *
   * PII note: never logs the token itself or the caller's email — only the
   * outcome + Cloudflare's error codes (non-PII).
   */
  async verify(token: string, remoteIp: string | undefined): Promise<boolean> {
    const body = new URLSearchParams({ secret: this.secretKey, response: token })
    if (remoteIp) body.set('remoteip', remoteIp)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        this.logger.warn(`Turnstile siteverify HTTP ${res.status}`)
        return false
      }
      const data = (await res.json()) as SiteverifyResponse
      if (!data.success) {
        this.logger.warn(`Turnstile verification failed: ${(data['error-codes'] ?? []).join(',')}`)
      }
      return data.success === true
    } catch (err) {
      this.logger.warn(`Turnstile siteverify request failed: ${(err as Error).message}`)
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}
