import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ExtractionPort, RouteStatePort, RouterEvent } from '@crm/inference'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { z } from 'zod'
import { stripContacts } from '../job-sourcing/structuring/contact-strip'
import { modelReplySchema } from '../job-sourcing/structuring/extraction-result-guard'
import { EXTRACTION_SYSTEM_PROMPT } from '../job-sourcing/structuring/prompt-envelope'
import { smallDoseFor } from '../job-sourcing/structuring/small-dose-table'
import { EXTRACTION_TABLE_VERSION } from './link-contract'
import { resumeWriteInput, writeResume } from './resume-write'
import {
  MAX_WORKER_INPUT_CHARS,
  extractBodySchema,
  healthFlags,
  preflightBodySchema,
  resumeWriteBodySchema,
  VISUAL_CHECK_BODY_LIMIT,
  visualCheckBodySchema,
} from './schema'
import { checkVisual } from './visual-check'

/** The one fixed preflight request: the caller sends nothing, so nothing of its can reach a route. */
const PREFLIGHT_INPUT = 'Reply with the JSON object {"ok": true} and nothing else.'
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

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * The extraction worker (ADR §2.4): the only process that holds provider keys. It answers four
 * routes and builds every request itself from checked-in prompts and schemas: `/extract` takes the
 * input text and the table version, `/preflight` takes nothing, `/resume-write` takes the task, the
 * caller-redacted facts payload and the gate feedback lines, `/visual-check` takes rendered pages.
 */
export function buildExtractionWorker(opts: ExtractionWorkerOptions): FastifyInstance {
  const tableVersion = opts.tableVersion ?? EXTRACTION_TABLE_VERSION
  const expected = digest(`Bearer ${opts.secret}`)
  const callEvents = new AsyncLocalStorage<WorkerEvent[]>()
  const ports = opts.buildPorts((e) => {
    callEvents.getStore()?.push(e)
    opts.log({ event: 'ROUTER', ...e })
  })

  // Fastify's defaults are the policy: no logger (AC9) and a 1 MiB body limit.
  const app = Fastify()

  const refuse = (reply: FastifyReply, status: number, error: string) => {
    opts.log({ event: 'REFUSED', status })
    return reply.code(status).send({ error })
  }

  app.removeAllContentTypeParsers()
  // Fastify's own default poisoning policy: a `__proto__` or `constructor.prototype` key is an error.
  // Stryker disable next-line StringLiteral: equivalent — secure-json-parse reads an empty action as its default, 'error'
  const json = app.getDefaultJsonParser('error', 'error')
  // An empty JSON body is "no body": `preflight` takes nothing, `extract` refuses it in its schema.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) =>
    body === '' ? done(null, undefined) : json(req, body.toString(), done),
  )

  // Before the body is read: an unauthenticated caller costs nothing and reaches nothing.
  app.addHook('onRequest', async (req, reply) => {
    const given = req.headers.authorization
    if (given === undefined || !timingSafeEqual(digest(given), expected)) {
      return refuse(reply, 401, 'UNAUTHORIZED')
    }
  })

  app.setNotFoundHandler((_req, reply) => refuse(reply, 404, 'NOT_FOUND'))
  // Fixed bodies only: a parser or route error message may quote the input.
  app.setErrorHandler((err: { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status === 415) return refuse(reply, 415, 'UNSUPPORTED_MEDIA_TYPE')
    if (status < 500) return refuse(reply, 400, 'BAD_REQUEST')
    return refuse(reply, 500, 'INTERNAL')
  })

  /** Runs one route call with its own event list and a signal tied to the client connection. */
  function call<T>(
    reply: FastifyReply,
    events: WorkerEvent[],
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    // After a sent reply the call is over, so the abort is a no-op there.
    reply.raw.on('close', () => controller.abort())
    // 'close' fires once: a client gone during the body read, check or strip never fires it here.
    if (reply.raw.destroyed) controller.abort()
    return callEvents.run(events, () => run(controller.signal))
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
    const result = await call(reply, events, (signal) =>
      ports.extract.extract({
        input: stripped.text,
        instruction: EXTRACTION_SYSTEM_PROMPT,
        schema: modelReplySchema,
        smallDose: smallDoseFor(),
        signal,
      }),
    )
    return { result, events, health: healthFlags(opts.routeState.snapshot()) }
  })

  // The caller redacts every field before it builds `payload` (R16); the worker logs no text of it.
  app.post('/resume-write', async (req, reply) => {
    const body = resumeWriteBodySchema.safeParse(req.body)
    // The port cuts a longer input without a word, so an input over the cap is refused, not cut.
    if (
      !body.success ||
      resumeWriteInput(body.data.payload, body.data.feedback).length > MAX_WORKER_INPUT_CHARS
    ) {
      return refuse(reply, 400, 'BAD_REQUEST')
    }
    const { task, payload, feedback } = body.data
    // Stryker disable next-line ArrayDeclaration: equivalent — this reply carries no events, so the list is never read
    const result = await call(reply, [], (signal) => writeResume(ports.extract, body.data, signal))
    opts.log({
      event: 'RESUME_WRITE',
      task,
      payloadChars: payload.length,
      feedbackCount: feedback.length,
      outcome: result.kind === 'ok' ? 'OK' : result.reason,
    })
    return result
  })

  // Pages arrive rendered from the placeholder copy (R18); no image byte, prompt or model text is logged.
  app.post('/visual-check', { bodyLimit: VISUAL_CHECK_BODY_LIMIT }, async (req, reply) => {
    const body = visualCheckBodySchema.safeParse(req.body)
    if (!body.success) return refuse(reply, 400, 'BAD_REQUEST')
    const { pages } = body.data
    // Stryker disable next-line ArrayDeclaration: equivalent — this reply carries no events, so the list is never read
    const result = await call(reply, [], (signal) => checkVisual(ports.extract, pages, signal))
    opts.log({
      event: 'VISUAL_CHECK',
      pages: pages.length,
      findings: result.kind === 'ok' ? result.findings.length : 0,
      outcome: result.kind === 'ok' ? 'OK' : result.reason,
    })
    return result
  })

  app.post('/preflight', async (req, reply) => {
    if (!preflightBodySchema.safeParse(req.body).success) {
      return refuse(reply, 400, 'BAD_REQUEST')
    }
    const events: WorkerEvent[] = []
    const r = await call(reply, events, (signal) =>
      ports.preflight.extract({
        input: PREFLIGHT_INPUT,
        instruction: PREFLIGHT_INSTRUCTION,
        schema: preflightReplySchema,
        signal,
      }),
    )
    return { ok: r.ok, events, health: healthFlags(opts.routeState.snapshot()) }
  })

  return app
}
