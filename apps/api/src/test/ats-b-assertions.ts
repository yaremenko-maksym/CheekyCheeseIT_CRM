import { expect } from 'vitest'
import type { FetchRequest } from '../job-sourcing/providers/reporting-provider'

/**
 * Assertions the four ATS B specs share (Task 3.4), kept in one place so the same rule is not
 * restated four times with four slightly different strengths. Lives in `src/test/` for the reason
 * `fake-collection-context.ts` does: it builds checks, and its mutants say nothing about whether an
 * adapter is tested.
 */

/** Headers whose presence on ANY request would mean the public/authorised line was crossed. */
const FORBIDDEN_HEADERS = [
  'authorization',
  'cookie',
  'x-careers-sites-token',
  'x-company-id',
] as const

/**
 * AC1 (public versus authorised): every request is plain HTTPS to a host the adapter owns, with no
 * userinfo, no authorised-integration path (`/spi/`), and no credential-bearing header. `allowedHeaders`
 * is what the adapter MAY send; anything else fails by name.
 */
export function expectOnlyPublicRequests(
  sent: readonly FetchRequest[],
  hostPattern: RegExp,
  allowedHeaders: readonly string[],
): void {
  for (const request of sent) {
    const url = new URL(request.url)
    expect(url.protocol, request.url).toBe('https:')
    expect(url.host, request.url).toMatch(hostPattern)
    expect(`${url.username}${url.password}`, request.url).toBe('')
    expect(url.pathname.toLowerCase(), request.url).not.toContain('/spi/')
    expect(request.url.toLowerCase(), request.url).not.toContain('token')
    const names = Object.keys(request.headers ?? {}).map((n) => n.toLowerCase())
    for (const forbidden of FORBIDDEN_HEADERS) expect(names).not.toContain(forbidden)
    expect(names.filter((n) => !allowedHeaders.includes(n))).toEqual([])
    expect(request.method ?? 'GET').toBe('GET')
    expect(request.body).toBeUndefined()
  }
}

/**
 * AC2 (non-leaking errors), asserted BY VALUE: none of the strings a response or an error could
 * have carried appears anywhere in the serialised batch.
 */
export function expectNoneOf(batch: unknown, values: readonly string[]): void {
  const text = JSON.stringify(batch)
  expect(text.length).toBeGreaterThan(0)
  for (const value of values) expect(text, `leaked ${value}`).not.toContain(value)
}
