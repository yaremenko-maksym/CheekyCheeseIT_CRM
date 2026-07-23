/**
 * GoogleIndexingService — task-google-indexing-api.
 *
 * Pushes near-instant (re)indexing signals to Google for vacancy JobPosting
 * pages via the Google Indexing API
 * (`POST https://indexing.googleapis.com/v3/urlNotifications:publish`).
 * Google officially supports this endpoint ONLY for JobPosting-marked pages
 * — that is exactly what apps/landing's `/careers/<slug>/` pages carry.
 *
 * Auth: a Google service-account server-to-server OAuth flow — sign a short-
 * lived JWT (RS256) asserting the `indexing` scope, exchange it for an
 * access token at Google's token endpoint, then call `urlNotifications:publish`
 * with that bearer token. Implemented with only `node:crypto` (RS256 signing
 * via `createSign`) + the global `fetch` — no `googleapis` dependency (it is
 * a heavy SDK and this is the ONLY Google API surface the project touches;
 * see version-pins.md — no new deps without explicit approval).
 *
 * Fail-soft CONTRACT (never violate this): `notifyUpdated` / `notifyDeleted`
 * NEVER reject and NEVER throw. Every failure mode (missing credentials,
 * network error, timeout, non-2xx from Google) is caught internally, logged,
 * and swallowed. Callers (VacanciesService, VacanciesRetentionCronService)
 * can therefore `await` these calls directly, inline with the DB commit,
 * with no extra try/catch at the call site — a slow/unreachable Google API
 * can never roll back or block a vacancy status transition. There is no
 * retry queue for a missed notification; the weekly refresh cron
 * (VacanciesRetentionCronService.handleWeeklyIndexingRefresh) re-notifies
 * every PUBLISHED vacancy and self-heals anything that was missed.
 *
 * No-op mode: when `GOOGLE_INDEXING_SA_EMAIL` / `GOOGLE_INDEXING_SA_KEY_B64`
 * are not both configured (the default in dev/CI), the service logs ONE
 * warning at construction and every notify call becomes an immediate no-op
 * — no network call, no error. Production deploys that skip provisioning
 * real credentials simply lose the "instant" part of indexing (Google will
 * still discover published vacancies eventually via normal crawling), they
 * never lose the ability to publish/close vacancies.
 */
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createSign } from 'node:crypto'
import type { Env } from '../config/env'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const PUBLISH_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish'
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing'

/** Fetch timeout for BOTH the OAuth token exchange and the publish call (task §1). */
const FETCH_TIMEOUT_MS = 5_000

/** JWT assertion lifetime — Google requires <= 1 hour; matches the token TTL below. */
const JWT_TTL_SECONDS = 3_600

/** Refresh the cached access token this many seconds before its real expiry. */
const TOKEN_REFRESH_SKEW_SECONDS = 60

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

interface CachedToken {
  accessToken: string
  /** `Date.now()`-comparable epoch millis. */
  expiresAtMs: number
}

interface TokenResponse {
  access_token: string
  expires_in: number
}

/**
 * Signs a Google service-account JWT assertion (RS256) for the
 * server-to-server OAuth flow. Exported as a standalone pure function
 * (rather than a private method) so it is directly unit-testable: given a
 * throwaway RSA keypair, a test can verify the returned JWT's signature with
 * the matching PUBLIC key without going through the service's fetch/env
 * plumbing.
 */
export function signIndexingJwt(
  saEmail: string,
  privateKeyPem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: saEmail,
    scope: INDEXING_SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + JWT_TTL_SECONDS,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(privateKeyPem)
  return `${signingInput}.${base64url(signature)}`
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

@Injectable()
export class GoogleIndexingService {
  private readonly logger = new Logger(GoogleIndexingService.name)
  private readonly saEmail: string | undefined
  private readonly privateKeyPem: string | undefined
  private readonly enabled: boolean
  private cachedToken: CachedToken | null = null

  constructor(private readonly config: ConfigService<Env, true>) {
    const email = this.config.get('GOOGLE_INDEXING_SA_EMAIL', { infer: true })
    const keyB64 = this.config.get('GOOGLE_INDEXING_SA_KEY_B64', { infer: true })
    this.saEmail = email || undefined
    this.privateKeyPem = keyB64 ? Buffer.from(keyB64, 'base64').toString('utf8') : undefined
    this.enabled = Boolean(this.saEmail && this.privateKeyPem)

    if (!this.enabled) {
      this.logger.warn(
        'GOOGLE_INDEXING_SA_EMAIL / GOOGLE_INDEXING_SA_KEY_B64 not configured — ' +
          'Google Indexing API notifications are disabled (no-op). Vacancy publish/' +
          'close still works; Google will discover changes via normal crawling instead ' +
          'of near-instant notification.',
      )
    }
  }

  /** Notify Google that `url` was created/updated (task: DRAFT/CLOSED → PUBLISHED, weekly refresh). */
  async notifyUpdated(url: string): Promise<void> {
    await this.notify(url, 'URL_UPDATED')
  }

  /** Notify Google that `url` should be removed from the index (task: PUBLISHED → CLOSED). */
  async notifyDeleted(url: string): Promise<void> {
    await this.notify(url, 'URL_DELETED')
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async notify(url: string, type: IndexingNotificationType): Promise<void> {
    if (!this.enabled) return
    try {
      const accessToken = await this.getAccessToken()
      const res = await this.fetchWithTimeout(PUBLISH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ url, type }),
      })
      if (!res.ok) {
        this.logger.warn(`Google Indexing API ${type} HTTP ${res.status} for ${url}`)
      }
    } catch (err: unknown) {
      // Fail-soft contract (see file header) — NEVER rethrow. A Google outage
      // must never block a vacancy status transition.
      this.logger.warn(
        `Google Indexing API ${type} failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** In-memory cached access token, refreshed a minute before real expiry. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.accessToken
    }
    if (!this.saEmail || !this.privateKeyPem) {
      // Guarded by `this.enabled` at every call site — defensive only.
      throw new Error('Google Indexing SA credentials not configured')
    }

    const assertion = signIndexingJwt(this.saEmail, this.privateKeyPem)
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    })
    const res = await this.fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      throw new Error(`Google OAuth token exchange failed: HTTP ${res.status}`)
    }
    const data = (await res.json()) as TokenResponse
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAtMs: now + (data.expires_in - TOKEN_REFRESH_SKEW_SECONDS) * 1000,
    }
    return data.access_token
  }

  /** AbortController-guarded fetch — mirrors EtherscanService.fetchWithTimeout / TurnstileService.verify. */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
