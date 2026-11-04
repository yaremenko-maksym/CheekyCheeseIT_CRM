import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { HttpStatus } from '@nestjs/common'
import { z } from 'zod'
import { apiError } from '../../common/api-error'

/**
 * r5 Task 6.2 — the opaque queue cursors: `base64url(json).base64url(hmac)`.
 *
 * Checked in two steps, BOTH before any data SQL:
 *   `parseCursor`          shape and integrity, no clock: anything forged, truncated or of another
 *                          kind is `JOB_QUEUE_CURSOR_MALFORMED` (400);
 *   `assertCursorCurrent`  expiry and the request signature (actor + scope + policy + filters): a
 *                          genuine cursor that no longer fits is `JOB_QUEUE_REFRESH_REQUIRED`.
 *
 * A cursor is NOT a grant. It only says where to resume; each page re-applies the visibility
 * predicate of the scope resolved for THAT request, and another actor's cursor is refused outright.
 */
const SIGNATURE = z.string().min(1).max(64)
const EXPIRES = z.number().int().nonnegative()

const listCursor = z
  .object({
    t: z.literal('L'),
    g: z.string().uuid(),
    k: z.number().int().nonnegative(),
    s: SIGNATURE,
    e: EXPIRES,
  })
  .strict()

const continuationCursor = z
  .object({
    t: z.enum(['SRC', 'SEN']),
    g: z.string().uuid(),
    k: z.string().uuid(),
    s: SIGNATURE,
    e: EXPIRES,
  })
  .strict()

const cursorSchema = z.discriminatedUnion('t', [listCursor, continuationCursor])

export type ListCursor = z.infer<typeof listCursor>
export type ContinuationCursor = z.infer<typeof continuationCursor>
export type QueueCursor = z.infer<typeof cursorSchema>

const mac = (body: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(`job-queue-cursor.v1.${body}`).digest()

export function signCursor(payload: QueueCursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${mac(body, secret).toString('base64url')}`
}

const malformed = () => apiError('JOB_QUEUE_CURSOR_MALFORMED', HttpStatus.BAD_REQUEST)

/** The verified payload of a cursor of kind `kind`; any other token is a 400. */
export function parseCursor<K extends QueueCursor['t']>(
  token: string,
  kind: K,
  secret: string,
): Extract<QueueCursor, { t: K }> {
  const [body, signature, ...rest] = token.split('.')
  if (body === undefined || signature === undefined || rest.length > 0) throw malformed()
  const given = Buffer.from(signature, 'base64url')
  const expected = mac(body, secret)
  // `timingSafeEqual` throws on a length mismatch; Buffer decoding is lenient, so also compare the text.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw malformed()
  if (signature !== expected.toString('base64url')) throw malformed()
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw malformed()
  }
  const parsed = cursorSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.t !== kind) throw malformed()
  return parsed.data as Extract<QueueCursor, { t: K }>
}

/** Expired, or issued for another actor / scope / policy / filter set: refresh, grant nothing. */
export function assertCursorCurrent(cursor: QueueCursor, signature: string, now: Date): void {
  if (cursor.e * 1000 <= now.getTime() || cursor.s !== signature) throw refreshRequired()
}

export const refreshRequired = () => apiError('JOB_QUEUE_REFRESH_REQUIRED', HttpStatus.CONFLICT)

/** A short, stable digest of a request's identifying parts (JSON-encoded, so parts cannot run together). */
export function requestSignature(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 22)
}
