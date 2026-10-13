export const DEFAULT_TIMEOUT_MS = 60000
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}>

export type BoundedResult =
  | { kind: 'ok'; status: number; text: string }
  | { kind: 'rate_limited'; status: number }
  | { kind: 'timeout' }
  | { kind: 'transport'; status?: number; text?: string }

export interface BoundedRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  maxBytes: number
  allowLoopbackHttp?: boolean
  fetchImpl?: FetchLike
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

type BodyRead = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'aborted' }

function isUrlAllowed(rawUrl: string, allowLoopbackHttp: boolean): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && allowLoopbackHttp && LOOPBACK_HOSTS.has(parsed.hostname)
}

/** Reads the body, counting bytes; cancels the stream as soon as `maxBytes` is exceeded. */
async function readBounded(
  response: Awaited<ReturnType<FetchLike>>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyRead> {
  const { body } = response
  if (body === null) {
    const text = await response.text()
    return new TextEncoder().encode(text).byteLength > maxBytes
      ? { kind: 'too_large' }
      : { kind: 'text', text }
  }

  const reader = body.getReader()
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const step = await Promise.race([reader.read(), aborted])
    if (step === 'aborted') {
      await reader.cancel().catch(() => undefined)
      return { kind: 'aborted' }
    }
    if (step.done) break
    received += step.value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { kind: 'too_large' }
    }
    text += decoder.decode(step.value, { stream: true })
  }
  return { kind: 'text', text: text + decoder.decode() }
}

export async function boundedRequest(opts: BoundedRequestOptions): Promise<BoundedResult> {
  if (!isUrlAllowed(opts.url, opts.allowLoopbackHttp === true)) return { kind: 'transport' }

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const response = await fetchImpl(opts.url, {
      ...(opts.method !== undefined && { method: opts.method }),
      ...(opts.headers !== undefined && { headers: opts.headers }),
      ...(opts.body !== undefined && { body: opts.body }),
      signal: controller.signal,
    })
    const { status } = response

    if (status === 429) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: 'rate_limited', status }
    }

    const read = await readBounded(response, opts.maxBytes, controller.signal)
    if (read.kind === 'aborted') return { kind: 'timeout' }
    if (status < 200 || status >= 300) {
      return read.kind === 'text'
        ? { kind: 'transport', status, text: read.text }
        : { kind: 'transport', status }
    }
    if (read.kind === 'too_large') return { kind: 'transport', status }
    return { kind: 'ok', status, text: read.text }
  } catch {
    return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'transport' }
  } finally {
    clearTimeout(timer)
  }
}
