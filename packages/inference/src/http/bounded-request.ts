export const DEFAULT_TIMEOUT_MS = 60000
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    redirect?: 'error'
  },
) => Promise<{
  status: number
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
  headers?: HeaderReader
}>

/** The one method of the platform `Headers` the classifier reads. */
export type HeaderReader = { get(name: string): string | null }

export type BoundedResult =
  | { kind: 'ok'; status: number; text: string }
  | { kind: 'rate_limited'; status: number; text?: string; headers?: HeaderReader }
  /** `aborted` marks the caller's `signal`, never the timer (SR-L-38): an abort is not a timeout. */
  | { kind: 'timeout'; aborted?: true }
  /** `tooLarge` marks a 2xx whose body exceeded `maxBytes`. */
  | { kind: 'transport'; status?: number; text?: string; tooLarge?: true }

export interface BoundedRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  maxBytes: number
  allowLoopbackHttp?: boolean
  /**
   * Plain HTTP to loopback or the one package-constant local runtime host. Set only by the
   * router's local leaf; `allowLoopbackHttp` (and so `LOCAL_MODEL_URL`) is not widened.
   */
  allowLocalRuntimeHttp?: boolean
  /** On a 429, read the bounded body and keep the headers instead of discarding them. */
  readRateLimitDetails?: boolean
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The container name of the CRM's own model runtime on the worker's private network (ADR §3.3). */
export const LOCAL_MODEL_RUNTIME_HOST = 'crm-model-runtime'

type BodyRead = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'aborted' }

function isUrlAllowed(
  rawUrl: string,
  allowLoopbackHttp: boolean,
  allowLocalRuntimeHttp: boolean,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  if (allowLocalRuntimeHttp && parsed.hostname === LOCAL_MODEL_RUNTIME_HOST) return true
  return (allowLoopbackHttp || allowLocalRuntimeHttp) && LOOPBACK_HOSTS.has(parsed.hostname)
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
  if (
    !isUrlAllowed(opts.url, opts.allowLoopbackHttp === true, opts.allowLocalRuntimeHttp === true)
  ) {
    return { kind: 'transport' }
  }
  const { signal } = opts
  if (signal?.aborted === true) return { kind: 'timeout', aborted: true }

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)
  const stopped = (): BoundedResult =>
    signal?.aborted === true ? { kind: 'timeout', aborted: true } : { kind: 'timeout' }
  try {
    const response = await fetchImpl(opts.url, {
      ...(opts.method !== undefined && { method: opts.method }),
      ...(opts.headers !== undefined && { headers: opts.headers }),
      ...(opts.body !== undefined && { body: opts.body }),
      signal: controller.signal,
      // A 3xx must never escape the HTTPS/loopback allow-policy: it becomes a transport failure.
      redirect: 'error',
    })
    const { status } = response

    if (status === 429 && opts.readRateLimitDetails !== true) {
      await response.body?.cancel().catch(() => undefined)
      return { kind: 'rate_limited', status }
    }

    const read = await readBounded(response, opts.maxBytes, controller.signal)
    if (read.kind === 'aborted') return stopped()
    if (status === 429) {
      return {
        kind: 'rate_limited',
        status,
        ...(read.kind === 'text' && { text: read.text }),
        ...(response.headers !== undefined && { headers: response.headers }),
      }
    }
    if (status < 200 || status >= 300) {
      return read.kind === 'text'
        ? { kind: 'transport', status, text: read.text }
        : { kind: 'transport', status }
    }
    if (read.kind === 'too_large') return { kind: 'transport', status, tooLarge: true }
    return { kind: 'ok', status, text: read.text }
  } catch {
    return controller.signal.aborted ? stopped() : { kind: 'transport' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
