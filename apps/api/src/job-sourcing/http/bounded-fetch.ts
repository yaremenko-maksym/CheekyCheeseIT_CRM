import { SourceBlockedError, SourceRateLimitedError } from './source-errors'

export const DEFAULT_USER_AGENT =
  'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MIN_GAP_MS = 1000

export interface BoundedFetchOptions {
  /** Required. Checked before the request AND against the final `response.url`. */
  allowedHosts: readonly string[]
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** Default 2 MiB. */
  maxBytes?: number
  /** Default 15 000 ms; bounds the body stream too, not just the headers. */
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

/** HTTPS-only + exact host match; anything unparseable is refused. */
function assertAllowed(rawUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('host not allowed')
  }
  if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.host)) {
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
 * size-capped (streamed, aborted at the cap), time-capped, host-pinned across
 * redirects, throttled per host. 403 / 429 map to typed deliberate-stop errors.
 */
export async function boundedFetchText(url: string, opts: BoundedFetchOptions): Promise<string> {
  const host = assertAllowed(url, opts.allowedHosts)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  await throttle(host, opts.minGapMs ?? DEFAULT_MIN_GAP_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...lowercaseKeys(opts.headers ?? {}) },
    })

    // A redirect may have landed anywhere — re-check the final URL and drop the
    // body unread. (A real fetch always sets `url`; fall back to the requested,
    // already-validated URL for synthetic responses.)
    try {
      assertAllowed(response.url || url, opts.allowedHosts)
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
  } finally {
    clearTimeout(timer)
  }
}
