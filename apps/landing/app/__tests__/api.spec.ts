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
import { fetchVacancies, fetchVacancyHreflangExcludes, submitContact } from '@/lib/api'

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
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: null,
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

/**
 * task-landing-i18n.md round-4 "дорезка" — the public API only ever reports
 * `isFallback` for the ONE `?locale=` a request asked about (server-side
 * resolution), so this fetches the PUBLISHED list once per non-`en` locale
 * and reads each one's own `isFallback` flag for the target slug — see
 * `lib/api.ts`'s module doc for why. Each test stubs `fetch` to branch on the
 * `?locale=` query string, matching how `fetchVacancies(locale)` actually
 * builds its URL.
 */
describe('fetchVacancyHreflangExcludes', () => {
  const SLUG = 'senior-ml-engineer'

  function vacancyEntry(isFallback: boolean) {
    return {
      slug: SLUG,
      title: 'Senior ML Engineer',
      domain: 'AI',
      seniority: 'SENIOR',
      employmentType: 'FULL_TIME',
      location: 'Remote',
      publishedAt: '2026-07-01T00:00:00.000Z',
      isFallback,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
    }
  }

  function stubFetchByLocale(
    isFallbackByLocale: Partial<Record<'uk' | 'ru' | 'es' | 'pt', boolean>>,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const locale = new URL(url, 'http://localhost').searchParams.get('locale')
        const isFallback = locale
          ? isFallbackByLocale[locale as 'uk' | 'ru' | 'es' | 'pt']
          : undefined
        const body = isFallback === undefined ? [] : [vacancyEntry(isFallback)]
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
      }),
    )
  }

  it('excludes nothing when every non-en locale has a real translation (isFallback: false everywhere)', async () => {
    stubFetchByLocale({ uk: false, ru: false, es: false, pt: false })
    await expect(fetchVacancyHreflangExcludes(SLUG)).resolves.toEqual([])
  })

  it('excludes exactly the locales where isFallback is true, keeps the rest', async () => {
    stubFetchByLocale({ uk: true, ru: false, es: true, pt: false })
    await expect(fetchVacancyHreflangExcludes(SLUG)).resolves.toEqual(['uk', 'es'])
  })

  it('excludes every non-en locale when none have a translation', async () => {
    stubFetchByLocale({ uk: true, ru: true, es: true, pt: true })
    await expect(fetchVacancyHreflangExcludes(SLUG)).resolves.toEqual(['uk', 'ru', 'es', 'pt'])
  })

  it('conservatively excludes a locale whose list does not contain this slug at all', async () => {
    // ru's list is missing the slug entirely (e.g. not yet propagated) —
    // treated the same as isFallback: true, never silently assumed translated.
    stubFetchByLocale({ uk: false, es: false, pt: false })
    await expect(fetchVacancyHreflangExcludes(SLUG)).resolves.toEqual(['ru'])
  })

  it('conservatively excludes a locale whose list fetch fails outright (network error)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const locale = new URL(url, 'http://localhost').searchParams.get('locale')
        if (locale === 'ru') return Promise.reject(new TypeError('fetch failed'))
        return Promise.resolve(new Response(JSON.stringify([vacancyEntry(false)]), { status: 200 }))
      }),
    )
    await expect(fetchVacancyHreflangExcludes(SLUG)).resolves.toEqual(['ru'])
  })
})

/**
 * submitContact — task-landing-contact-and-hiring-strip.md. Only the network/
 * status-mapping contract is covered here (mirrors `submitApplication`'s own
 * shape); the component's field-validation/state-machine is covered by
 * `contact-form.spec.tsx`.
 */
describe('submitContact', () => {
  const PAYLOAD = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    message: 'We would like to discuss a new project.',
    turnstileToken: 'tok-123',
    website: '',
  }

  it('posts JSON to /api/public/contact and resolves ok:true on 2xx', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: RequestInit) => {
        capturedUrl = url
        capturedInit = init
        return Promise.resolve(new Response(null, { status: 201 }))
      }),
    )

    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: true })
    expect(capturedUrl).toBe('/api/public/contact')
    expect(capturedInit?.method).toBe('POST')
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    expect(JSON.parse(capturedInit?.body as string)).toEqual(PAYLOAD)
  })

  it('maps 429 to errorKind "rate-limited"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'rate-limited' })
  })

  it('maps 503 (Resend not configured) to errorKind "unavailable"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'unavailable' })
  })

  it('maps 502 (no ADMIN recipients / send failed after retries) to errorKind "unavailable"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'unavailable' })
  })

  it('maps 400 (Zod field validation) to errorKind "validation"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 400 })))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'validation' })
  })

  // review round 1 MED-2 — 422 (Turnstile verification failure) is a
  // DISTINCT errorKind from 400 (Zod field validation) — see
  // `ContactService.submit()`'s `UnprocessableEntityException`.
  it('maps 422 (Turnstile verification failure) to errorKind "turnstile", NOT "validation"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 422 })))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'turnstile' })
  })

  it('maps a network error (fetch throws) to errorKind "network"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(submitContact(PAYLOAD)).resolves.toEqual({ ok: false, errorKind: 'network' })
  })
})
