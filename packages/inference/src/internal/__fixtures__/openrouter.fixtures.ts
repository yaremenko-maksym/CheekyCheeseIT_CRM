import { BODY_MARKER, type ProviderFixture } from './provider-fixture'

export const OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free'

/**
 * OpenRouter's error object `{ error: { code, message, metadata? } }`. The message wording of the
 * markers is UNVERIFIED until the 5.4c-5 smoke, except the 404 data-policy text (probe 2026-11-08).
 */
const orError = (code: number, message: string, metadata?: unknown): string =>
  JSON.stringify({ error: { code, message, ...(metadata === undefined ? {} : { metadata }) } })

export const OPENROUTER_FIXTURES: ProviderFixture[] = [
  {
    name: '401 key missing or invalid',
    status: 401,
    body: orError(401, `No auth credentials found ${BODY_MARKER}`),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '402 insufficient credits',
    status: 402,
    body: orError(402, BODY_MARKER),
    expected: { ok: false, code: 'CREDIT' },
  },
  {
    name: '403 with the error object is AUTH',
    status: 403,
    body: orError(403, BODY_MARKER),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 key limit is CREDIT',
    status: 403,
    body: orError(403, `Key limit exceeded ${BODY_MARKER}`),
    expected: { ok: false, code: 'CREDIT' },
  },
  {
    name: '403 moderation with metadata.reasons is REFUSED',
    status: 403,
    body: orError(403, BODY_MARKER, { reasons: ['x'], flagged_input: BODY_MARKER }),
    expected: { ok: false, code: 'REFUSED' },
  },
  {
    name: '403 HTML from an edge layer is TRANSPORT',
    status: 403,
    body: `<html><body>Forbidden ${BODY_MARKER}</body></html>`,
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '429 free-models-per-day is SPENT_DAY',
    status: 429,
    headers: { 'retry-after': '30' },
    body: orError(429, `Rate limit exceeded: free-models-per-day. ${BODY_MARKER}`),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 free-models-per-min is BUSY with retry-after',
    status: 429,
    headers: { 'retry-after': '7' },
    body: orError(429, `Rate limit exceeded: free-models-per-min. ${BODY_MARKER}`),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 7000 },
  },
  {
    name: '429 with neither marker is BUSY',
    status: 429,
    body: orError(429, BODY_MARKER),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 a longer token that only contains the marker is BUSY',
    status: 429,
    body: orError(429, `free-models-per-day-extended ${BODY_MARKER}`),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 page echo: the marker outside error.message is BUSY',
    status: 429,
    body: JSON.stringify({
      error: { code: 429, message: BODY_MARKER, metadata: { raw: 'free-models-per-day' } },
      page: 'free-models-per-day',
    }),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 page echo: a non-envelope body naming the marker is BUSY',
    status: 429,
    body: `<p>free-models-per-day ${BODY_MARKER}</p>`,
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '404 data policy is FLAG_REJECTED, before RETIRED',
    status: 404,
    body: orError(
      404,
      `No endpoints found matching your data policy (Free model publication). ${OPENROUTER_MODEL}`,
    ),
    expected: { ok: false, code: 'FLAG_REJECTED' },
  },
  {
    name: '404 naming the model without the data-policy text is RETIRED',
    status: 404,
    body: orError(404, `No endpoints found for ${OPENROUTER_MODEL}`),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '404 page echo of the data-policy text outside error.message is TRANSPORT',
    status: 404,
    body: JSON.stringify({
      error: { code: 404, message: BODY_MARKER },
      page: 'No endpoints found matching your data policy',
    }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '400 naming max_price is FLAG_REJECTED',
    status: 400,
    body: orError(400, `No endpoints found that satisfy max_price. ${BODY_MARKER}`),
    expected: { ok: false, code: 'FLAG_REJECTED' },
  },
  {
    name: '400 naming require_parameters is FLAG_REJECTED',
    status: 400,
    body: orError(400, `No endpoints support require_parameters ${BODY_MARKER}`),
    expected: { ok: false, code: 'FLAG_REJECTED' },
  },
  {
    name: '400 naming data_collection is FLAG_REJECTED',
    status: 400,
    body: orError(400, `Invalid provider.data_collection ${BODY_MARKER}`),
    expected: { ok: false, code: 'FLAG_REJECTED' },
  },
  {
    name: '400 a token that only contains a parameter name is TRANSPORT',
    status: 400,
    body: orError(400, `bad max_price_cap ${BODY_MARKER}`),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '400 page echo of a parameter name outside error.message is TRANSPORT',
    status: 400,
    body: JSON.stringify({ error: { code: 400, message: BODY_MARKER }, page: 'max_price' }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '503 no free endpoint up is BUSY',
    status: 503,
    body: orError(503, BODY_MARKER),
    expected: { ok: false, code: 'BUSY' },
  },
]
