import { BODY_MARKER, type ProviderFixture } from './provider-fixture'

export const CLOUDFLARE_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
/** A synthetic account id: 32 lower-case hex characters, no real account. */
export const CLOUDFLARE_ACCOUNT = '0123456789abcdef0123456789abcdef'

/** Cloudflare's v4 API envelope (errors page): `{ success: false, errors: [{ code, message }] }`. */
const v4Error = (code: number): string =>
  JSON.stringify({ success: false, errors: [{ code, message: BODY_MARKER }], messages: [] })

export const CLOUDFLARE_FIXTURES: ProviderFixture[] = [
  {
    name: '401 token missing or invalid',
    status: 401,
    body: v4Error(10000),
    expected: { ok: false, code: 'AUTH' },
  },
  {
    name: '403 Workers Paid required (5035) is not read as AUTH',
    status: 403,
    body: v4Error(5035),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '410 model deprecated (5028) in the v4 envelope',
    status: 410,
    body: v4Error(5028),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '410 with the plain text the run endpoint sent (prod log, PR #1370)',
    status: 410,
    body: `AiError: Model has been deprecated ${BODY_MARKER}`,
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '410 with no body',
    status: 410,
    body: '',
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '404 invalid model id (3042) does not name the model: a wrong URL',
    status: 404,
    body: v4Error(3042),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
  {
    name: '404 with an OpenAI-shaped error naming the model',
    status: 404,
    body: JSON.stringify({ error: { message: `The model ${CLOUDFLARE_MODEL} does not exist` } }),
    expected: { ok: false, code: 'RETIRED' },
  },
  {
    name: '429 daily free allocation used (3036)',
    status: 429,
    body: v4Error(3036),
    expected: { ok: false, code: 'SPENT_DAY' },
  },
  {
    name: '429 out of capacity (3040) with retry-after',
    status: 429,
    headers: { 'retry-after': '5' },
    body: v4Error(3040),
    expected: { ok: false, code: 'BUSY', retryAfterMs: 5000 },
  },
  {
    name: '429 code 3036 outside the errors list is not a spent day',
    status: 429,
    body: JSON.stringify({ error: { code: 3036, message: BODY_MARKER } }),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 code 3036 as a string is not a spent day',
    status: 429,
    body: JSON.stringify({ success: false, errors: [{ code: '3036' }] }),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 the Groq day header is foreign on Cloudflare',
    status: 429,
    headers: { 'x-ratelimit-remaining-requests': '0' },
    body: '',
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '429 HTML from an edge layer',
    status: 429,
    body: `<html>${BODY_MARKER} 3036</html>`,
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '503 is BUSY',
    status: 503,
    body: v4Error(3040),
    expected: { ok: false, code: 'BUSY' },
  },
  {
    name: '500 is TRANSPORT',
    status: 500,
    body: v4Error(3043),
    expected: { ok: false, code: 'TRANSPORT', responded: true },
  },
]
