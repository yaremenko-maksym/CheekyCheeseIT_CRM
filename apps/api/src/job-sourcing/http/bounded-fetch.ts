import { SourceBlockedError, SourceRateLimitedError } from './source-errors'

export const DEFAULT_USER_AGENT =
  'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MIN_GAP_MS = 1000
/** Hard ceilings: a provider cannot opt out of the safety limits. */
const MAX_BYTES_CEILING = 10 * 1024 * 1024
const TIMEOUT_MS_CEILING = 60_000
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface BoundedFetchOptions {
  /**
   * Required. Validated on entry (public DNS names only), checked before every
   * hop — including each redirect target — and against the final `response.url`.
   */
  allowedHosts: readonly string[]
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** Default 2 MiB, ceiling 10 MiB. */
  maxBytes?: number
  /** Default 15 000 ms, ceiling 60 000 ms; bounds the body stream too. */
  timeoutMs?: number
  /** Per-host spacing between requests, default 1000 ms. */
  minGapMs?: number
}

const lastRequestAt = new Map<string, number>()

/**
 * Reserve the next slot for `host` BEFORE awaiting, so parallel callers to one
 * host get distinct, evenly spaced slots instead of all seeing the same
 * "last request" and firing together.
 */
async function throttle(host: string, minGapMs: number): Promise<void> {
  const last = lastRequestAt.get(host) ?? 0
  const wait = last + minGapMs - Date.now()
  lastRequestAt.set(host, Math.max(Date.now(), last + minGapMs))
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

export function __resetThrottleForTests(): void {
  lastRequestAt.clear()
}

/** Join streamed chunks into one buffer (no intermediate copies per chunk). */
function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// Lower-case DNS name with at least one dot; no scheme/port/path/wildcard.
const DNS_HOST = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost']

function assertValidAllowedHosts(allowedHosts: readonly string[]): void {
  if (allowedHosts.length === 0) throw new Error('invalid allowedHosts: empty list')
  for (const entry of allowedHosts) {
    const lastLabel = entry.slice(entry.lastIndexOf('.') + 1)
    const ok =
      DNS_HOST.test(entry) &&
      // IPv4 literal (all-numeric TLD) is not a name.
      /[a-z]/.test(lastLabel) &&
      entry !== 'localhost' &&
      !INTERNAL_SUFFIXES.some((suffix) => entry.endsWith(suffix))
    if (!ok) throw new Error(`invalid allowedHosts entry: ${JSON.stringify(entry)}`)
  }
}

function assertWithinCeiling(name: string, value: number, ceiling: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > ceiling) {
    throw new Error(`invalid ${name}: ${value} (must be 1..${ceiling})`)
  }
}

/**
 * HTTPS-only, exact host match, no userinfo, no port. The authority as written
 * must equal the parsed host byte-for-byte, so case tricks, a trailing dot,
 * `user@` prefixes and `:port` suffixes are all refused rather than normalised.
 */
function assertAllowed(rawUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('host not allowed')
  }
  const authority = /^https:\/\/([^/?#\\]*)/i.exec(rawUrl)?.[1]
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    authority !== parsed.host ||
    !allowedHosts.includes(parsed.host)
  ) {
    throw new Error('host not allowed')
  }
  return parsed.host
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

/**
 * SSRF-hardened text fetch for job-source providers. The response is UNTRUSTED:
 * size-capped (streamed, aborted at the cap), time-capped, throttled per host,
 * and host-pinned on EVERY hop — redirects are followed by hand so a foreign
 * target is refused before any request is made to it, and credentials/body are
 * never forwarded to a different host. 403 / 429 map to typed deliberate-stop
 * errors.
 */
export async function boundedFetchText(url: string, opts: BoundedFetchOptions): Promise<string> {
  assertValidAllowedHosts(opts.allowedHosts)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertWithinCeiling('maxBytes', maxBytes, MAX_BYTES_CEILING)
  assertWithinCeiling('timeoutMs', timeoutMs, TIMEOUT_MS_CEILING)
  const minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS

  let currentUrl = url
  let method: 'GET' | 'POST' = opts.method ?? 'GET'
  let body = opts.body
  let headers: Record<string, string> = {
    'user-agent': DEFAULT_USER_AGENT,
    ...lowercaseKeys(opts.headers ?? {}),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      const host = assertAllowed(currentUrl, opts.allowedHosts)
      await throttle(host, minGapMs)

      const response = await fetch(currentUrl, {
        method,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: 'manual',
        headers,
      })

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel()
        if (hop >= MAX_REDIRECTS) throw new Error(`${host} too many redirects`)
        const location = response.headers.get('location')
        if (!location) throw new Error(`${host} redirect without location`)
        let next: URL
        try {
          next = new URL(location, currentUrl)
        } catch {
          throw new Error('host not allowed')
        }
        // Refused here, BEFORE any request is made to the target.
        const nextHost = assertAllowed(next.href, opts.allowedHosts)
        const hostChanged = nextHost !== host
        if (
          hostChanged ||
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET'
          body = undefined
        }
        if (hostChanged) headers = { 'user-agent': DEFAULT_USER_AGENT }
        currentUrl = next.href
        continue
      }

      // Defence in depth: the final URL must still be on the allow-list. (A real
      // fetch always sets `url`; fall back to the already-validated request URL
      // for synthetic responses.)
      try {
        assertAllowed(response.url || currentUrl, opts.allowedHosts)
      } catch (err) {
        await response.body?.cancel()
        throw err
      }

      if (response.status === 403) {
        await response.body?.cancel()
        throw new SourceBlockedError(host, response.status)
      }
      if (response.status === 429) {
        await response.body?.cancel()
        throw new SourceRateLimitedError(host)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`${host} responded ${response.status}`)
      }

      // Cheap pre-check when the server is honest about the size; the streaming
      // check below is what enforces it when it is not.
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel()
        throw new Error(`${host} response too large: content-length ${declared} > ${maxBytes}`)
      }

      if (!response.body) return ''

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          received += value.byteLength
          if (received > maxBytes) {
            // Stop pulling bytes immediately — do not finish the download.
            await reader.cancel()
            throw new Error(`${host} response too large: exceeded ${maxBytes} bytes`)
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      return new TextDecoder('utf-8').decode(concatChunks(chunks, received))
    }
  } finally {
    clearTimeout(timer)
  }
}
