import { SourceBlockedError, SourceRateLimitedError } from '../../http/source-errors'
import { isRunFenced } from '../../ownership/run-ownership'
import {
  type CollectionContext,
  type CollectionErrorCode,
  collectionCodeOf,
  type FetchRequest,
  type MeterReservation,
  type RequestReport,
  type ReservationResolution,
  type StopReason,
} from '../reporting-provider'

/*
 * One metered request of a hand-written list + detail adapter (moved out of
 * `smartrecruiters.provider.ts` unchanged, so Next Level Jobs reuses it rather than a copy).
 */

export interface Failure {
  code: CollectionErrorCode
  message: string
  status: number | null
}

export type Fetched =
  | {
      ok: true
      status: number
      bodyText: string
      /** Lowercased header names; the production context passes none (`{}`). */
      headers: Readonly<Record<string, string>>
      startedAt: Date
      cost: RequestReport['cost']
    }
  | { ok: false; stop: StopReason }

/** The real transport's plain error for any other non-2xx: `<host> responded <status>`. */
const TRANSPORT_STATUS = /^\S+ responded (\d{3})$/

/**
 * A throw out of the transport, as a failure. A ban or a rate limit is a REFUSAL by the host, not a
 * network blip: it must not wear `TRANSIENT_NETWORK`, which a retry policy would act on.
 */
export function failureOfThrown(error: unknown, aborted: boolean): Failure {
  if (error instanceof SourceBlockedError) {
    return {
      code: 'ACCESS_POLICY',
      message: `provider answered HTTP ${error.status}`,
      status: error.status,
    }
  }
  if (error instanceof SourceRateLimitedError) {
    return { code: 'RATE_LIMIT', message: 'provider answered HTTP 429', status: 429 }
  }
  const message = error instanceof Error ? error.message : 'the request failed'
  // T7: a refusal of the production context already names its cause (NOT_MARKED_SENT, ...).
  const coded = collectionCodeOf(error)
  if (coded !== null) return { code: coded, message, status: null }
  // No match gives NaN, which `classify` answers with UPSTREAM, never a ban.
  const status = Number(TRANSPORT_STATUS.exec(message)?.[1])
  if (classify(status) === 'ACCESS_POLICY') {
    return { code: 'ACCESS_POLICY', message: `provider answered HTTP ${status}`, status }
  }
  return { code: aborted ? 'CANCELLED' : 'TRANSIENT_NETWORK', message, status: null }
}

/** HTTP status -> our code, from the STATUS and never the body. */
export function classify(status: number): CollectionErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 403 || status === 451) return 'ACCESS_POLICY'
  if (status === 429) return 'RATE_LIMIT'
  return 'UPSTREAM'
}

/** Where a metered request's report goes: the adapter's own `report`, which redacts and pushes. */
export type ReportRequest = (
  at: number,
  url: string,
  status: number | null,
  startedAt: Date,
  cost: RequestReport['cost'],
  error: Failure | null,
) => void

/** A `metered(at, request, notFoundIsAnAnswer)` bound to one attempt and its request cap. */
export function createMeteredFetch(
  ctx: CollectionContext,
  maxRequests: number,
  report: ReportRequest,
): (
  at: number,
  request: FetchRequest,
  notFoundIsAnAnswer: boolean,
  redirectIsAnAnswer?: boolean,
  goneIsAnAnswer?: boolean,
) => Promise<Fetched> {
  let requestsMade = 0
  /**
   * ONE metered request. Reserve before any I/O, reconcile on every path out (the `finally`), cap
   * and cancel and deadline checked first. On any refusal or failure the report is already pushed
   * and `{ ok: false, stop }` is returned; on a response the CALLER pushes the report, because
   * only it knows whether the body was usable. `notFoundIsAnAnswer` lets a detail's 404 through;
   * `redirectIsAnAnswer` lets an unfollowed 3xx through (a `followRedirects: false` request);
   * `goneIsAnAnswer` lets a detail's 410 through (the posting is gone, as with a 404). A list,
   * sitemap or robots request never sets it: there a 410 stays an UPSTREAM failure.
   */
  async function metered(
    at: number,
    request: FetchRequest,
    notFoundIsAnAnswer: boolean,
    redirectIsAnAnswer = false,
    goneIsAnAnswer = false,
  ): Promise<Fetched> {
    const startedAt = ctx.now()
    const refuse = (failure: Failure, why: StopReason, cost: RequestReport['cost'] = null) => {
      report(at, request.url, failure.status, startedAt, cost, failure)
      return { ok: false, stop: why } as const
    }
    if (requestsMade >= maxRequests) {
      return refuse(
        {
          code: 'PAGE_CAP',
          message: `the attempt reached its ${maxRequests}-request bound`,
          status: null,
        },
        'PAGE_CAP',
      )
    }
    if (ctx.signal.aborted) {
      return refuse(
        { code: 'CANCELLED', message: 'the run was cancelled before this request', status: null },
        'CANCELLED',
      )
    }
    if (ctx.now().getTime() >= ctx.deadline.getTime()) {
      return refuse(
        {
          code: 'DEADLINE',
          message: 'the attempt deadline passed before this request',
          status: null,
        },
        'ERROR',
      )
    }
    const reservation: MeterReservation | null = await ctx.meter.reserve('REQUEST', 1)
    if (reservation === null) {
      return refuse(
        { code: 'COST_STOP', message: 'the meter refused a reservation', status: null },
        'COST_STOP',
      )
    }
    const cost = { unit: reservation.unit, amount: reservation.amount }
    // T7 (ADR "markSent: its home", CR-H-1): SENT is COMMITTED, awaited, immediately before the
    // request leaves -- the store releases only cost it can prove unsent. A rejection means the
    // request was NOT sent: the reservation is released, except when the executor is fenced out
    // (RUN_FENCED), where a reconcile would be refused too and the run's settlement releases it.
    try {
      await ctx.meter.markSent(reservation)
    } catch (error) {
      if (isRunFenced(error)) {
        return refuse(
          {
            code: 'RUN_FENCED',
            message: 'the request was not sent: the run is fenced out',
            status: null,
          },
          'ERROR',
        )
      }
      const releaseNote = await ctx.meter.reconcile(reservation, 'RELEASED').then(
        () => '',
        () => ' (nor released)',
      )
      return refuse(
        {
          code: 'PERSISTENCE',
          message: `the request was not sent, its reservation could not be marked sent${releaseNote}: ${error instanceof Error ? error.message : 'the meter failed'}`,
          status: null,
        },
        'ERROR',
      )
    }
    requestsMade += 1
    // From here the request may have left the process, so a failure cannot claim it was unused.
    let resolution: ReservationResolution = 'UNCERTAIN'
    let answer:
      | {
          response: {
            status: number
            bodyText: string
            headers: Readonly<Record<string, string>>
          }
        }
      | { failure: Failure }
    try {
      const fetched = await ctx.fetchText(request)
      resolution = 'USED'
      answer = {
        response: { status: fetched.status, bodyText: fetched.bodyText, headers: fetched.headers },
      }
    } catch (error) {
      const failure = failureOfThrown(error, ctx.signal.aborted)
      // A refusal is an answer: the request reached the host, so the reservation was used.
      if (failure.code === 'ACCESS_POLICY' || failure.code === 'RATE_LIMIT') resolution = 'USED'
      answer = { failure }
    }
    // Every path out of the try above reaches this line, so the reservation is always resolved.
    const unreconciled: Failure | null = await ctx.meter.reconcile(reservation, resolution).then(
      () => null,
      (error: unknown) => ({
        code: 'PERSISTENCE' as const,
        message: `the reservation could not be reconciled: ${error instanceof Error ? error.message : 'the meter failed'}`,
        status: null,
      }),
    )
    if ('failure' in answer) {
      return refuse(
        answer.failure,
        answer.failure.code === 'CANCELLED' ? 'CANCELLED' : 'ERROR',
        cost,
      )
    }
    if (unreconciled !== null) return refuse(unreconciled, 'ERROR', cost)
    const { response } = answer
    const code = classify(response.status)
    const answered =
      (notFoundIsAnAnswer && response.status === 404) ||
      (goneIsAnAnswer && response.status === 410) ||
      // A 2xx has no code, so `< 400` alone admits exactly the unfollowed 3xx.
      (redirectIsAnAnswer && response.status < 400)
    if (code !== null && !answered) {
      return refuse(
        { code, message: `provider answered HTTP ${response.status}`, status: response.status },
        'ERROR',
        cost,
      )
    }
    return {
      ok: true,
      status: response.status,
      bodyText: response.bodyText,
      headers: response.headers,
      startedAt,
      cost,
    }
  }
  return metered
}
