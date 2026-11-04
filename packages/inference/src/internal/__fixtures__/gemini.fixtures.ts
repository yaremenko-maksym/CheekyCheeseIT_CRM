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
    name: '403 envelope past the bounded read is not read',
    status: 403,
    body: JSON.stringify({ pad: 'x'.repeat(2000), ...envelope(403, 'PERMISSION_DENIED') }),
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
]
