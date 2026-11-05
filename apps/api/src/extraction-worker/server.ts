import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ExtractionPort, RouteStatePort, RouterEvent } from '@crm/inference'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { z } from 'zod'
import { stripContacts } from '../job-sourcing/structuring/contact-strip'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { smallDoseFor } from '../job-sourcing/structuring/small-dose-table'
import {
  EXTRACTION_TABLE_VERSION,
  extractBodySchema,
  healthFlags,
  preflightBodySchema,
} from './schema'

/** The one fixed preflight request: the caller sends nothing, so nothing of its can reach a route. */
export const PREFLIGHT_INPUT = 'Reply with the JSON object {"ok": true} and nothing else.'
const PREFLIGHT_INSTRUCTION = 'You are a health check. Answer exactly as asked.'
const preflightReplySchema = z.object({ ok: z.literal(true) }).strict()

/** A log line carries codes and counts only — never the secret, a key, input or model text (AC9). */
export type WorkerLogLine = { event: string } & Record<string, string | number | boolean | object>

export type WorkerEvent = RouterEvent | { type: 'INPUT_CONTACTS_STRIPPED'; count: number }

export type ExtractionWorkerOptions = {
  secret: string
  /** Defaults to the version of the module this image was built with. */
  tableVersion?: string
  routeState: RouteStatePort
  log: (line: WorkerLogLine) => void
  /** The router adapters, built with the worker's own event sink. */
  buildPorts: (onEvent: (e: RouterEvent) => void) => {
    extract: ExtractionPort
    preflight: ExtractionPort
  }
}

const BODY_LIMIT_BYTES = 1024 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * The extraction worker (ADR §2.4): the only process that holds provider keys. It answers two
 * routes, builds every request itself from the checked-in extraction module, and takes from the
 * caller nothing but the input text and the table version.
 */
export function buildExtractionWorker(opts: ExtractionWorkerOptions): FastifyInstance {
  const tableVersion = opts.tableVersion ?? EXTRACTION_TABLE_VERSION
  const expected = digest(`Bearer ${opts.secret}`)
  const callEvents = new AsyncLocalStorage<WorkerEvent[]>()
  const ports = opts.buildPorts((e) => {
    callEvents.getStore()?.push(e)
    opts.log({ event: 'ROUTER', ...e })
  })

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES })

  const refuse = (reply: FastifyReply, status: number, error: string) => {
    opts.log({ event: 'REFUSED', status })
    return reply.code(status).send({ error })
  }

  app.removeAllContentTypeParsers()
  const json = app.getDefaultJsonParser('error', 'error')
  // An empty JSON body is "no body": `preflight` takes nothing, `extract` refuses it in its schema.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) =>
    body === '' ? done(null, undefined) : json(req, body, done),
  )

  // Before the body is read: an unauthenticated caller costs nothing and reaches nothing.
  app.addHook('onRequest', async (req, reply) => {
    const given = digest(req.headers.authorization ?? '')
    if (!timingSafeEqual(given, expected)) return refuse(reply, 401, 'UNAUTHORIZED')
  })

  app.setNotFoundHandler((_req, reply) => refuse(reply, 404, 'NOT_FOUND'))
  // Fixed bodies only: a parser or route error message may quote the input.
  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status === 415) return refuse(reply, 415, 'UNSUPPORTED_MEDIA_TYPE')
    if (status >= 400 && status < 500) return refuse(reply, 400, 'BAD_REQUEST')
    return refuse(reply, 500, 'INTERNAL')
  })

  /** Runs one route call with its own event list and a signal tied to the client connection. */
  async function call(
    reply: FastifyReply,
    events: WorkerEvent[],
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<WorkerEvent[]> {
    const controller = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort()
    })
    await callEvents.run(events, () => run(controller.signal))
    return events
  }

  app.post('/extract', async (req, reply) => {
    const body = extractBodySchema.safeParse(req.body)
    if (!body.success) return refuse(reply, 400, 'BAD_REQUEST')
    if (body.data.tableVersion !== tableVersion) {
      return refuse(reply, 409, 'TABLE_VERSION_MISMATCH')
    }
    // The second strip (§2.4): the worker does not trust the API's strip to have run.
    const stripped = stripContacts(body.data.input)
    const count = Object.values(stripped.removed).reduce((a, b) => a + b, 0)
    const events: WorkerEvent[] = []
    if (count > 0) {
      events.push({ type: 'INPUT_CONTACTS_STRIPPED', count })
      opts.log({ event: 'INPUT_CONTACTS_STRIPPED', count })
    }
    let result: unknown
    await call(reply, events, async (signal) => {
      result = await ports.extract.extract({
        input: stripped.text,
        instruction: EXTRACTION_SYSTEM_PROMPT,
        schema: modelReplySchema,
        smallDose: smallDoseFor(),
        signal,
      })
    })
    return { result, events, health: healthFlags(opts.routeState.snapshot()) }
  })

  app.post('/preflight', async (req, reply) => {
    if (!preflightBodySchema.safeParse(req.body).success) {
      return refuse(reply, 400, 'BAD_REQUEST')
    }
    let ok = false
    const events = await call(reply, [], async (signal) => {
      const r = await ports.preflight.extract({
        input: PREFLIGHT_INPUT,
        instruction: PREFLIGHT_INSTRUCTION,
        schema: preflightReplySchema,
        signal,
      })
      ok = r.ok
    })
    return { ok, events, health: healthFlags(opts.routeState.snapshot()) }
  })

  return app
}
