import { z } from 'zod'
import { INFERENCE_ERROR_CODES } from '../contracts/errors'
import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '../contracts/extraction'
import {
  boundedRequestToExtractionWorker,
  DEFAULT_MAX_BYTES,
  type FetchLike,
} from '../http/bounded-request'

const MAX_REPLY_EVENTS = 100

// `exactOptional`: JSON has no `undefined`, and the port's types are exact-optional.
const usageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative().exactOptional(),
    localMs: z.number().nonnegative().exactOptional(),
  })
  .strict()

/**
 * The worker's reply, untrusted (ADR §2.4): the data is parsed again with the caller's schema.
 * Built per adapter, not at load: a broken schema then fails its adapter, not the whole module.
 */
const buildReplySchema = () =>
  z
    .object({
      result: z.discriminatedUnion('ok', [
        z
          .object({ ok: z.literal(true), data: z.unknown(), usage: usageSchema.exactOptional() })
          .strict(),
        z
          .object({
            ok: z.literal(false),
            code: z.enum(INFERENCE_ERROR_CODES),
            usage: z.object({ localMs: z.number().nonnegative() }).strict().exactOptional(),
          })
          .strict(),
      ]),
      events: z.array(z.looseObject({ type: z.string() })).max(MAX_REPLY_EVENTS),
      health: z
        .object({
          modelListStale: z.boolean(),
          failedJobs: z.array(z.enum(['daily', 'chain'])),
        })
        .strict(),
    })
    .strict()

/** What the worker reports besides the answer: its events and the §5.3 health flags. */
export type ExtractionWorkerReply = Pick<
  z.infer<ReturnType<typeof buildReplySchema>>,
  'events' | 'health'
>

export type ExtractionWorkerAdapterConfig = {
  /** The worker on its private network, e.g. `http://crm-extraction-worker:3100`. */
  baseUrl: string
  secret: string
  /** `EXTRACTION_TABLE_VERSION` of this image; a mismatch is refused by the worker. */
  tableVersion: string
  timeoutMs: number
  /** Mandatory: the events and health flags are recorded on the DB side (§2.4, §5.3). */
  onReply: (reply: ExtractionWorkerReply) => void
  fetchImpl?: FetchLike
}

/**
 * The collection side's `ExtractionPort` (ADR §2.4): sends the input and the table version only.
 * The caller's instruction, schema and small dose never cross; the worker builds its own request
 * from the same checked-in module. Any refused, failed or malformed call is `PROVIDER_ERROR`. A
 * failure code the router delivered passes through, because §5.4 decides the record by it; only
 * `RATE_LIMITED`, which §5.4 has no row for, becomes `PROVIDER_ERROR`. The caller's abort closes the
 * connection and answers `TIMEOUT`, as the router does. Events and health are recorded as soon as
 * the reply envelope parses, whatever the answer turns out to be. Never throws.
 */
export function createExtractionWorkerAdapter(
  config: ExtractionWorkerAdapterConfig,
): ExtractionPort {
  const replySchema = buildReplySchema()
  return {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      const failed: ExtractionResult<T> = { ok: false, code: 'PROVIDER_ERROR' }
      const res = await boundedRequestToExtractionWorker({
        url: `${config.baseUrl}/extract`,
        method: 'POST',
        headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: req.input, tableVersion: config.tableVersion }),
        timeoutMs: config.timeoutMs,
        maxBytes: DEFAULT_MAX_BYTES,
        signal: req.signal,
        fetchImpl: config.fetchImpl,
      })
      if (res.kind === 'timeout') return res.aborted ? { ok: false, code: 'TIMEOUT' } : failed
      if (res.kind !== 'ok') return failed
      let body: unknown
      try {
        body = JSON.parse(res.text)
      } catch {
        // `body` stays undefined, which the reply schema refuses.
      }
      const parsed = replySchema.safeParse(body)
      if (!parsed.success) return failed
      const { result, events, health } = parsed.data
      try {
        config.onReply({ events, health })
      } catch {
        // The sink's failure is the caller's to observe; it never turns an answer into a throw.
      }
      if (!result.ok) {
        // §5.4 has no row for RATE_LIMITED and the router never answers it publicly.
        return result.code === 'RATE_LIMITED' ? { ...result, code: 'PROVIDER_ERROR' } : result
      }
      const data = req.schema.safeParse(result.data)
      if (!data.success) return failed
      return { ok: true, data: data.data, ...(result.usage && { usage: result.usage }) }
    },
  }
}
