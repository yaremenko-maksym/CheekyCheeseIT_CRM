import { BODY_MARKER, type ProviderFixture } from './provider-fixture'

export const GROQ_MODEL = 'openai/gpt-oss-20b'

/** Groq's documented error object (errors page): `{ error: { message, type } }`. */
const groqError = (type = 'invalid_request_error'): string =>
  JSON.stringify({ error: { message: BODY_MARKER, type } })

const DAY_MS = 24 * 60 * 60 * 1000

export const GROQ_FIXTURES: ProviderFixture[] = [
  {
    name: '401 key missing or invalid',
    status: 401,
    body: groqError(),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 with the documented error object',
    status: 403,
    body: groqError('permission_error'),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 HTML from an edge layer',
    status: 403,
    body: `<html><body>Forbidden ${BODY_MARKER}</body></html>`,
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '403 Google envelope is foreign on Groq',
    status: 403,
    body: JSON.stringify({ error: { code: 403, message: BODY_MARKER, status: 'PERMISSION_DENIED' } }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '429 per-day requests: remaining-requests exactly 0',
    status: 429,
    headers: { 'x-ratelimit-remaining-requests': '0', 'retry-after': '30' },
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 per-minute tokens with retry-after',
    status: 429,
    headers: {
      'x-ratelimit-remaining-requests': '812',
      'x-ratelimit-remaining-tokens': '0',
      'retry-after': '7',
    },
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 7000 },
  },
  {
    name: '429 per-day tokens carries no marker: BUSY',
    status: 429,
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 remaining-requests "0 " is not exactly 0',
    status: 429,
    headers: { 'x-ratelimit-remaining-requests': '0 ', 'retry-after': '12' },
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 12000 },
  },
  {
    name: '429 remaining-requests "00" is not exactly 0',
    status: 429,
    headers: { 'x-ratelimit-remaining-requests': '00' },
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 retry-after over 24 h is clamped',
    status: 429,
    headers: { 'retry-after': '999999' },
    body: groqError('rate_limit_exceeded'),
    expected: { ok: false, code: 'BUSY', retryAfterMs: DAY_MS },
  },
  {
    name: '429 retry-after 0 is a zero pause',
    status: 429,
    headers: { 'retry-after': '0' },
    body: '',
    expected: { ok: false, code: 'BUSY', retryAfterMs: 0 },
  },
  ...['NaN', '-5', '1.5', '', '5 ', ' 5', '5x', 'Infinity', '9'.repeat(400)].map(
    (value): ProviderFixture => ({
      name: `429 hostile retry-after ${JSON.stringify(value.slice(0, 12))} is absent`,
      status: 429,
      headers: { 'retry-after': value },
      body: groqError('rate_limit_exceeded'),
      expected: { ok: false, code: 'BUSY' },
    }),
  ),
  {
    // The documented message is redacted to the marker: classification never reads it.
    name: '400 best-effort schema mismatch',
    status: 400,
    body: groqError(),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '404 error code model_not_found (reconstruction, UNVERIFIED shape)',
    status: 404,
    body: JSON.stringify({
      error: { message: BODY_MARKER, type: 'invalid_request_error', code: 'model_not_found' },
    }),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '404 message naming the requested model (reconstruction, UNVERIFIED shape)',
    status: 404,
    body: JSON.stringify({
      error: { message: `The model ${GROQ_MODEL} does not exist`, type: 'invalid_request_error' },
    }),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '404 naming another model retires nothing',
    status: 404,
    body: JSON.stringify({
      error: { message: 'The model openai/gpt-oss-120b does not exist', type: 'x' },
    }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '404 without a message or code retires nothing',
    status: 404,
    body: JSON.stringify({ error: { type: 'not_found' } }),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '404 bare page (a wrong base URL) retires nothing',
    status: 404,
    body: `<html>Not Found ${GROQ_MODEL}</html>`,
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '498 flex tier at capacity',
    status: 498,
    body: groqError(),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '503 overloaded',
    status: 503,
    body: groqError('server_error'),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '500 server error',
    status: 500,
    body: groqError('server_error'),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '402 insufficient credit (no provider documents one; generic row)',
    status: 402,
    body: groqError(),
    expected: { ok: false, code: 'CREDIT' },
  },
]
