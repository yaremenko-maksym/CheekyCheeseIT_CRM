/**
 * fetchVacancies graceful-degradation — task-landing-seo-prerender.md AC1
 * ("API недоступен → ... билд НЕ падает; живая SPA догружает"). Pins the
 * behaviour change made in `lib/api.ts`: previously any failure THREW
 * (crashing the route's loader — TanStack Router's default error boundary
 * has no footer, which is exactly what made `scripts/prerender.mjs` hang
 * waiting for one when the API was down); now every failure mode resolves to
 * `[]` so `/` and `/careers` always render their existing, designed "0 open
 * roles" empty state instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchVacancies } from '@/lib/api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchVacancies', () => {
  it('returns the parsed list on a successful response', async () => {
    const payload = [
      {
        slug: 'senior-ml-engineer',
        title: 'Senior ML Engineer',
        domain: 'AI',
        seniority: 'SENIOR',
        employmentType: 'FULL_TIME',
        location: 'Remote',
        publishedAt: '2026-07-01T00:00:00.000Z',
        isFallback: false,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
    )

    await expect(fetchVacancies()).resolves.toEqual(payload)
  })

  it('degrades to [] on a network error (fetch rejects)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(fetchVacancies()).resolves.toEqual([])
  })

  it('degrades to [] on a non-2xx response (e.g. proxy 502 when the API is down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(fetchVacancies()).resolves.toEqual([])
  })

  it('degrades to [] on a malformed (schema-invalid) response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ not: 'an array' }), { status: 200 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(fetchVacancies()).resolves.toEqual([])
  })
})
