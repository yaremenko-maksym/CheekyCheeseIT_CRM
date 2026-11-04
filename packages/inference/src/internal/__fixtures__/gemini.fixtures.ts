import { BODY_MARKER, type ProviderFixture } from './provider-fixture'

export const GEMINI_MODEL = 'gemini-2.5-flash'

const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure'
const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo'
const DAY_MS = 24 * 60 * 60 * 1000

/** The Google API error envelope (AIP-193); detail values per 5.4c-0 §7 (secondary sources). */
const envelope = (code: number, status: string, details?: unknown[]) => ({
  error: { code, message: BODY_MARKER, status, ...(details !== undefined && { details }) },
})

const quota = (quotaId: string) => ({
  '@type': QUOTA_FAILURE,
  violations: [
    {
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId,
      quotaDimensions: { location: 'global', model: '<model-id>' },
    },
  ],
})
const retry = (retryDelay: string) => ({ '@type': RETRY_INFO, retryDelay })

const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'
const PER_MINUTE = 'GenerateContentInputTokensPerModelPerMinute-FreeTier'

const tooManyRequests = (details?: unknown[]) =>
  JSON.stringify(envelope(429, 'RESOURCE_EXHAUSTED', details))

export const GEMINI_FIXTURES: ProviderFixture[] = [
  {
    name: '429 per-day quota id',
    status: 429,
    body: tooManyRequests([quota(PER_DAY), retry('55s')]),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 per-day quota id after another violation detail',
    status: 429,
    body: tooManyRequests([retry('55s'), quota(PER_MINUTE), quota(PER_DAY)]),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 per-day, envelope wrapped in a list (compat shape UNVERIFIED)',
    status: 429,
    body: JSON.stringify([envelope(429, 'RESOURCE_EXHAUSTED', [quota(PER_DAY)])]),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 per-day as the second violation of one QuotaFailure',
    status: 429,
    body: tooManyRequests([
      {
        '@type': QUOTA_FAILURE,
        violations: [{ quotaId: PER_MINUTE }, { quotaId: PER_DAY }],
      },
    ]),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 retryDelay with two fractional digits',
    status: 429,
    body: tooManyRequests([retry('1.25s')]),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 1250 },
  },
  {
    name: '429 per-minute quota id with retryDelay',
    status: 429,
    body: tooManyRequests([quota(PER_MINUTE), retry('55s')]),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 55000 },
  },
  {
    name: '429 fractional retryDelay',
    status: 429,
    body: tooManyRequests([retry('1.5s')]),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 1500 },
  },
  {
    name: '429 retryDelay over 24 h is clamped',
    status: 429,
    body: tooManyRequests([retry('999999s')]),
    expected: { ok: false, code: 'BUSY', retryAfterMs: DAY_MS },
  },
  {
    name: '429 envelope without details',
    status: 429,
    body: tooManyRequests(),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 non-JSON body',
    status: 429,
    body: `quota exceeded per day ${BODY_MARKER}`,
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 Groq day header means nothing on Gemini',
    status: 429,
    headers: { 'x-ratelimit-remaining-requests': '0', 'retry-after': '9' },
    body: tooManyRequests([quota(PER_MINUTE)]),
    expected: { ok: false, code: 'BUSY' },
  },
  ...['NaN', '-5s', '5', '5sx', 'x5s', '1.s', '.5s', '5ms', `${'9'.repeat(400)}s`].map(
    (value): ProviderFixture => ({
      name: `429 hostile retryDelay ${JSON.stringify(value.slice(0, 12))} is absent`,
      status: 429,
      body: tooManyRequests([quota(PER_MINUTE), retry(value)]),
      expected: { ok: false, code: 'BUSY' },
    }),
  ),
  {
    name: '403 PERMISSION_DENIED envelope (project denied)',
    status: 403,
    body: JSON.stringify(envelope(403, 'PERMISSION_DENIED')),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 PERMISSION_DENIED wrapped in a list',
    status: 403,
    body: JSON.stringify([envelope(403, 'PERMISSION_DENIED')]),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 envelope with another status',
    status: 403,
    body: JSON.stringify(envelope(403, 'UNAUTHENTICATED')),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 HTML from an edge layer',
    status: 403,
    body: `<html>403 Forbidden PERMISSION_DENIED ${BODY_MARKER}</html>`,
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 empty body',
    status: 403,
    body: '',
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 foreign JSON',
    status: 403,
    body: JSON.stringify({ blocked: true, reason: BODY_MARKER }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 Groq-shaped error object is foreign on Gemini',
    status: 403,
    body: JSON.stringify({ error: { message: BODY_MARKER, type: 'invalid_request_error' } }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 envelope after 2000 characters of other fields (whole body parsed)',
    status: 403,
    body: JSON.stringify({ pad: 'x'.repeat(2000), ...envelope(403, 'PERMISSION_DENIED') }),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '429 pretty-printed with three violations, longer than 2000 characters (CR-M-1)',
    status: 429,
    body: JSON.stringify(
      envelope(429, 'RESOURCE_EXHAUSTED', [
        quota(PER_MINUTE),
        quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
        quota('GenerateContentInputTokensPerModelPerMinute-FreeTier-2'),
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [
            { description: '<redacted>', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' },
          ],
        },
        quota(PER_DAY),
        retry('55s'),
      ]),
      null,
      2,
    ),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 per-day without error.status',
    status: 429,
    body: JSON.stringify({ error: { details: [quota(PER_DAY)] } }),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '404 naming a longer id that starts with the requested one retires nothing',
    status: 404,
    body: JSON.stringify({
      error: {
        code: 404,
        message: `models/${GEMINI_MODEL}-lite is not found`,
        status: 'NOT_FOUND',
      },
    }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '404 envelope naming the requested model (reconstruction, UNVERIFIED shape)',
    status: 404,
    body: JSON.stringify({
      error: { code: 404, message: `models/${GEMINI_MODEL} is not found`, status: 'NOT_FOUND' },
    }),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '401 unauthenticated',
    status: 401,
    body: JSON.stringify(envelope(401, 'UNAUTHENTICATED')),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '503 unavailable',
    status: 503,
    body: JSON.stringify(envelope(503, 'UNAVAILABLE')),
    expected: { ok: false, code: 'BUSY' },
  },
  // SR-M-64: a body can echo request content, so a marker counts only in its one designated field.
  ...(
    [
      ['in error.message', { error: { message: PER_DAY, status: 'RESOURCE_EXHAUSTED' } }],
      ['in error.status', { error: { status: PER_DAY } }],
      ['at the top level', { quotaId: PER_DAY, error: {} }],
      [
        'in quotaMetric',
        {
          error: {
            details: [
              {
                '@type': QUOTA_FAILURE,
                violations: [{ quotaMetric: PER_DAY, quotaId: PER_MINUTE }],
              },
            ],
          },
        },
      ],
      [
        'in a non-QuotaFailure detail',
        { error: { details: [{ '@type': RETRY_INFO, quotaId: PER_DAY, retryDelay: 'x' }] } },
      ],
      [
        'in a Help link',
        {
          error: {
            details: [
              { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: PER_DAY }] },
            ],
          },
        },
      ],
      ['in a QuotaFailure outside error.details', { details: [quota(PER_DAY)], error: {} }],
    ] as const
  ).map(([where, body]): ProviderFixture => ({
    name: `429 per-day marker ${where} is not a marker`,
    status: 429,
    body: JSON.stringify(body),
    expected: { ok: false, code: 'BUSY' },
  })),
  ...(
    [
      ['at the top level', { retryDelay: '55s', error: { details: [quota(PER_MINUTE)] } }],
      ['in error', { error: { retryDelay: '55s', details: [quota(PER_MINUTE)] } }],
      ['in a QuotaFailure', { error: { details: [{ ...quota(PER_MINUTE), retryDelay: '55s' }] } }],
      ['in a RetryInfo outside error.details', { details: [retry('55s')], error: {} }],
    ] as const
  ).map(([where, body]): ProviderFixture => ({
    name: `429 retryDelay ${where} is not a pause`,
    status: 429,
    body: JSON.stringify(body),
    expected: { ok: false, code: 'BUSY' },
  })),
  {
    name: '429 per-day envelope as the second list element is not read',
    status: 429,
    body: JSON.stringify([
      { note: BODY_MARKER },
      envelope(429, 'RESOURCE_EXHAUSTED', [quota(PER_DAY)]),
    ]),
    expected: { ok: false, code: 'BUSY' },
  },
  ...(
    [
      [
        'in error.message',
        { error: { code: 403, message: 'PERMISSION_DENIED', status: 'FORBIDDEN' } },
      ],
      [
        'in error.details',
        {
          error: {
            code: 403,
            status: 'UNKNOWN',
            details: [{ reason: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' }],
          },
        },
      ],
      ['at the top level', { status: 'PERMISSION_DENIED', error: { code: 403 } }],
      ['as a nested error', { error: { error: { status: 'PERMISSION_DENIED' } } }],
    ] as const
  ).map(([where, body]): ProviderFixture => ({
    name: `403 PERMISSION_DENIED ${where} is not AUTH`,
    status: 403,
    body: JSON.stringify(body),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  })),
  ...(
    [
      ['in error.status', { error: { code: 404, status: GEMINI_MODEL } }],
      [
        'in error.details',
        { error: { code: 404, details: [{ message: GEMINI_MODEL, code: 'model_not_found' }] } },
      ],
      ['at the top level', { message: GEMINI_MODEL, code: 'model_not_found', error: {} }],
    ] as const
  ).map(([where, body]): ProviderFixture => ({
    name: `404 model id or model_not_found ${where} retires nothing`,
    status: 404,
    body: JSON.stringify(body),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  })),
]
