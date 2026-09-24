import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { API_ERROR_MESSAGES } from '@crm/shared'
import {
  getAxiosStatus,
  getApiErrorCode,
  getApiErrorMessage,
  getUserFacingErrorMessage,
  stripQueryString,
  translateZodMessage,
  GENERIC_HTTP_REASON_PHRASES,
} from './axios-utils'

// security-review round 2, MED-2: one consistent policy — never log a
// query string anywhere (console OR telemetry), since it can carry PII
// just like a response body can.
describe('stripQueryString', () => {
  it('removes the query string, keeping only the path', () => {
    expect(stripQueryString('/users?email=vasya@example.com')).toBe('/users')
  })

  it('leaves a path with no query string untouched', () => {
    expect(stripQueryString('/documents')).toBe('/documents')
  })

  it('handles multiple query params and a fragment-like trailing "?"', () => {
    expect(stripQueryString('/documents?ownerId=abc&category=RECEIPT')).toBe('/documents')
    expect(stripQueryString('/documents?')).toBe('/documents')
  })

  it('returns "?" for undefined (no url on the config)', () => {
    expect(stripQueryString(undefined)).toBe('?')
  })
})

describe('getAxiosStatus', () => {
  it('returns status from axios-like error', () => {
    const err = { response: { status: 404 } }
    expect(getAxiosStatus(err)).toBe(404)
  })

  it('returns undefined for non-axios error', () => {
    expect(getAxiosStatus(new Error('fail'))).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(getAxiosStatus(null)).toBeUndefined()
  })
})

describe('getApiErrorMessage', () => {
  it('extracts string message from axios response.data.message', () => {
    const err = {
      response: { data: { message: 'Зарплата уже створена' } },
      message: 'Request failed with status code 400',
    }
    expect(getApiErrorMessage(err)).toBe('Зарплата уже створена')
  })

  it('joins array message from axios response.data.message', () => {
    const err = {
      response: { data: { message: ['Field A is required', 'Field B too short'] } },
      message: 'Request failed with status code 400',
    }
    expect(getApiErrorMessage(err)).toBe('Field A is required. Field B too short')
  })

  it('falls back to err.message when no response', () => {
    const err = new Error('Network Error')
    expect(getApiErrorMessage(err)).toBe('Network Error')
  })

  it('falls back to err.message when response.data.message absent', () => {
    const err = { response: { data: {} }, message: 'Request failed with status code 500' }
    expect(getApiErrorMessage(err)).toBe('Request failed with status code 500')
  })

  it('falls back to default string when error is unknown shape', () => {
    expect(getApiErrorMessage(null)).toBe('Сталася помилка. Спробуйте ще раз.')
  })

  it('falls back to default string for plain string error', () => {
    expect(getApiErrorMessage('oops')).toBe('Сталася помилка. Спробуйте ще раз.')
  })

  // ZodExceptionFilter shape: { statusCode, message: "Validation failed", errors: [{path, message}] }
  it('formats ZodExceptionFilter errors[] with string path (real filter output)', () => {
    const err = {
      response: {
        data: {
          statusCode: 400,
          message: 'Validation failed',
          errors: [{ path: 'salaryMonth', message: 'Format YYYY-MM' }],
        },
      },
      message: 'Request failed with status code 400',
    }
    const result = getApiErrorMessage(err)
    expect(result).toContain('salaryMonth')
    expect(result).toContain('Format YYYY-MM')
  })

  it('formats multiple ZodExceptionFilter errors joined with semicolon', () => {
    const err = {
      response: {
        data: {
          statusCode: 400,
          message: 'Validation failed',
          errors: [
            { path: 'amount', message: 'Expected number' },
            { path: 'receiverId', message: 'Invalid uuid' },
          ],
        },
      },
      message: 'Request failed with status code 400',
    }
    const result = getApiErrorMessage(err)
    expect(result).toContain('amount')
    expect(result).toContain('Expected number')
    expect(result).toContain('receiverId')
    expect(result).toContain('Invalid uuid')
  })

  it('accepts array path in errors[] (defensive — path is string in real filter)', () => {
    const err = {
      response: {
        data: {
          errors: [{ path: ['nested', 'field'], message: 'Required' }],
        },
      },
      message: 'Request failed with status code 400',
    }
    const result = getApiErrorMessage(err)
    expect(result).toContain('nested.field')
    expect(result).toContain('Required')
  })

  it('errors[] takes priority over message field', () => {
    const err = {
      response: {
        data: {
          message: 'Validation failed',
          errors: [{ path: 'salaryMonth', message: 'Format YYYY-MM' }],
        },
      },
      message: 'Request failed with status code 400',
    }
    const result = getApiErrorMessage(err)
    // Should show field detail, not the generic "Validation failed"
    expect(result).not.toBe('Validation failed')
    expect(result).toContain('salaryMonth')
  })
})

// task-i18n-stage4-task4 (Step 9) — ZodExceptionFilter's per-issue shape now
// carries `code` for a migrated schema and plain `message` for one not yet
// migrated, IN THE SAME response. `getApiErrorMessage` must translate the
// former through the catalog and pass the latter through unchanged.
describe('getApiErrorMessage — mixed migrated/legacy ZodExceptionFilter issues (task-i18n-stage4-task4)', () => {
  beforeAll(() => {
    // Empty catalog on purpose — `ZOD_ERROR_MESSAGES[code].message` (the uk
    // source text) is what `i18n._` falls back to when the id isn't in the
    // loaded catalog, same pattern `catalog.spec.ts`/the envelope tests above
    // rely on. Only an ACTIVATED locale is required.
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('translates a migrated field (code) and keeps prose for a non-migrated one, in the same response', () => {
    const err = {
      response: {
        data: {
          message: 'Validation failed',
          errors: [
            { path: 'bankUahRnokpp', code: 'RNOKPP_FORMAT' },
            { path: 'email', message: 'Некорректный email' },
          ],
        },
      },
    }
    // fix-round 1 (COPY-M-9): a migrated issue (code present) no longer gets
    // the raw API field name prefixed — the translated text already names
    // the field ("Введіть 10 цифр РНОКПП"). The `path:` prefix survives ONLY
    // for the legacy (code-less) issue.
    expect(getApiErrorMessage(err)).toBe('Введіть 10 цифр РНОКПП; email: Некорректный email')
  })

  it('falls back to the message field when code is present but unknown (defensive — should not happen from a real filter)', () => {
    const err = {
      response: {
        data: {
          errors: [{ path: 'x', code: 'NOT_A_REAL_CODE', message: 'fallback text' }],
        },
      },
    }
    expect(getApiErrorMessage(err)).toBe('x: fallback text')
  })

  it('does NOT prefix the path for a migrated (coded) issue, even standalone', () => {
    const err = {
      response: {
        data: {
          errors: [{ path: 'walletUsdtErc20', code: 'USDT_ADDRESS_FORMAT' }],
        },
      },
    }
    const result = getApiErrorMessage(err)
    expect(result).not.toContain('walletUsdtErc20:')
    expect(result).toBe('Адреса USDT ERC-20 має починатися з 0x і містити 42 символи')
  })
})

// fix-round 2 (SR-M-4/COPY-H-4): `zodErrorBadRequest`
// (`apps/api/src/common/zod-error-exception.ts`) builds its envelope at the
// TOP level — `{ statusCode, code, message }`, no `errors[]` wrapper — for a
// server-side caller that throws BEFORE Zod's own `.parse()` boundary.
// `apiErrorEnvelopeSchema`'s `code` enum (a DIFFERENT registry) never
// matches a Zod code, so priority 0 in `getApiErrorMessage` doesn't catch
// this body either — `extractBackendMessage`'s new priority-1.5 branch is
// the only thing that can.
describe('getApiErrorMessage / getUserFacingErrorMessage — zodErrorBadRequest top-level code envelope (fix-round 2, SR-M-4/COPY-H-4)', () => {
  beforeAll(() => {
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('translates a zodErrorBadRequest top-level code through the catalog (getApiErrorMessage)', () => {
    const err = {
      response: {
        data: {
          statusCode: 400,
          code: 'RECEIPT_REQUIRED',
          message: 'A receipt is required — attach a file or a link',
        },
      },
    }
    expect(getApiErrorMessage(err)).toBe('Чек обов’язковий — додайте файл або посилання')
  })

  it('translates a zodErrorBadRequest top-level code through the catalog (getUserFacingErrorMessage)', () => {
    const err = {
      isAxiosError: true,
      response: {
        data: {
          statusCode: 400,
          code: 'SENDER_RECEIVER_SAME',
          message: 'Sender and receiver cannot be the same',
        },
      },
    }
    expect(getUserFacingErrorMessage(err)).toBe('Відправник і отримувач не можуть збігатися')
  })

  it('falls through to response.data.message when the top-level code is not one of ours (defensive)', () => {
    const err = {
      response: {
        data: { statusCode: 400, code: 'NOT_A_REAL_CODE', message: 'fallback text' },
      },
    }
    expect(getApiErrorMessage(err)).toBe('fallback text')
  })

  it('is unaffected by an errors[]-shaped envelope (priority 1 still wins over the top-level code branch)', () => {
    const err = {
      response: {
        data: {
          message: 'Validation failed',
          errors: [{ path: 'bankUahRnokpp', code: 'RNOKPP_FORMAT' }],
          // A stray top-level `code` should never be reached while errors[]
          // has usable parts — pins the branch ORDER, not just its presence.
          code: 'SENDER_RECEIVER_SAME',
        },
      },
    }
    expect(getApiErrorMessage(err)).toBe('Введіть 10 цифр РНОКПП')
  })
})

describe('translateZodMessage', () => {
  beforeAll(() => {
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('translates a zod.<CODE> message through the catalog', () => {
    expect(translateZodMessage('zod.RNOKPP_FORMAT')).toBe('Введіть 10 цифр РНОКПП')
  })

  it('passes through a message that is not one of our codes, unchanged', () => {
    expect(translateZodMessage('Invalid input: expected number, received string')).toBe(
      'Invalid input: expected number, received string',
    )
  })

  it('passes through a zod.-prefixed string that is NOT a real code, unchanged (defensive)', () => {
    expect(translateZodMessage('zod.NOT_A_REAL_CODE')).toBe('zod.NOT_A_REAL_CODE')
  })

  /**
   * mutation-gate closure (fix-round 2, CI-5): same class as
   * `zodErrorFallbackText`'s own pinning test (`zod-errors.spec.ts`) and
   * `zodErrorBadRequest`'s (`zod-error-exception.spec.ts`) — a message with
   * no `zod.` prefix at all passes through unchanged EITHER because the
   * early-return actually ran, OR — if `startsWith('zod.')` were mutated
   * away (forced `false`, or its `'zod.'` literal blanked to `''`) —
   * because `message.slice(4)` happened not to collide with a real code,
   * so neither existing "non-coded" test above can tell the two apart.
   * This message is built so a BROKEN early-return slices its first 4
   * characters off into `RECEIPT_REQUIRED` — a REAL code — and would
   * translate it instead of returning the plain string below.
   */
  it("a non-coded message whose 4th-character-onward slice collides with a real code still passes through unchanged (pins the actual startsWith('zod.') check)", () => {
    const message = 'abcdRECEIPT_REQUIRED'
    expect(message.startsWith('zod.')).toBe(false)
    expect(translateZodMessage(message)).toBe(message)
  })

  it("returns undefined for null/undefined input — matches @tanstack/react-form's validator return convention", () => {
    expect(translateZodMessage(null)).toBeUndefined()
    expect(translateZodMessage(undefined)).toBeUndefined()
  })
})

// task-i18n-stage2-task5: priority 0 — a response body matching the API
// error envelope (`apiErrorEnvelopeSchema`) translates by `code`, through
// the Lingui catalog, BEFORE any of the prose-based priorities above run.
describe('getApiErrorMessage — API error envelope (task-i18n-stage2-task5)', () => {
  beforeAll(() => {
    // Real catalog content doesn't matter here — `API_ERROR_MESSAGES`
    // descriptors carry their own `message` fallback, which Lingui uses
    // when the id isn't in the loaded catalog (see `catalog.spec.ts`'s
    // identical pattern). What's required is an ACTIVATED locale — `i18n._`
    // throws otherwise.
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('translates an API error envelope by code via the catalog', () => {
    const err = {
      response: {
        status: 403,
        data: { statusCode: 403, code: 'TOS_ACCEPT_IMPERSONATION', message: 'fallback' },
      },
    }
    expect(getApiErrorMessage(err)).toBe(i18n._(API_ERROR_MESSAGES.TOS_ACCEPT_IMPERSONATION))
  })

  // COPY-M-6 (PR #694 round 3) removed `role`, the only param any registered
  // code declared (`CONTRACT_TEMPLATE_MISSING`'s message no longer takes a
  // `{role}` token — see `api-errors.ts`), together with `applyRoleLabel`
  // (its own describe block below is gone too). No code left declares
  // params, so there is nothing for `translateApiError` to interpolate
  // through the public surface right now; a synthetic descriptor would only
  // test a template that never ships. Reinstate a param-interpolation test
  // here against whichever code stage 3 next gives params to.

  it('falls through to prose when the body carries no known code', () => {
    const err = { response: { data: { message: 'Некорректная сумма' } } }
    expect(getApiErrorMessage(err)).toBe('Некорректная сумма')
  })

  it('falls through when code is outside the eight-code registry', () => {
    const err = {
      response: { data: { statusCode: 403, code: 'NOT_A_REAL_CODE', message: 'Доступ запрещён' } },
    }
    expect(getApiErrorMessage(err)).toBe('Доступ запрещён')
  })
})

describe('getApiErrorCode', () => {
  it('returns the code from a valid envelope', () => {
    const err = {
      response: {
        data: { statusCode: 404, code: 'CONTRACT_TEMPLATE_MISSING', message: 'x' },
      },
    }
    expect(getApiErrorCode(err)).toBe('CONTRACT_TEMPLATE_MISSING')
  })

  it('returns null for a plain-prose error', () => {
    expect(getApiErrorCode({ response: { data: { message: 'plain' } } })).toBeNull()
  })

  it('returns null for a non-envelope / unknown-shape error', () => {
    expect(getApiErrorCode(null)).toBeNull()
    expect(getApiErrorCode('oops')).toBeNull()
  })

  it('returns null (not a throw) for undefined — the guard must short-circuit BEFORE `.response` is read', () => {
    // A string/number/null input reaches the same `undefined` result whether
    // or not the `typeof err !== 'object'` half of the guard runs (accessing
    // `.response` on a primitive is a safe no-op in JS) — that half is only
    // OBSERVABLE for `undefined`, where skipping the early return and reading
    // `err.response` throws instead of returning `null`.
    expect(getApiErrorCode(undefined)).toBeNull()
  })
})

// task fix/api-error-messages: the honest, Russian-only, never-raw-axios-text
// replacement for what `api.interceptors.response` (axios.ts) now uses to
// rewrite `error.message` before ANY consumer (dozens of
// `toast.error(...${e.message})` sites app-wide) ever sees it.
describe('getUserFacingErrorMessage', () => {
  it('prefers the backend-supplied message when present (same priority as getApiErrorMessage)', () => {
    const err = {
      response: { status: 409, data: { message: 'Зарплата уже создана' } },
      message: 'Request failed with status code 409',
    }
    expect(getUserFacingErrorMessage(err)).toBe('Зарплата уже создана')
  })

  it('prefers ZodExceptionFilter errors[] over both data.message and status', () => {
    const err = {
      response: {
        status: 400,
        data: {
          message: 'Validation failed',
          errors: [{ path: 'salaryMonth', message: 'Format YYYY-MM' }],
        },
      },
      message: 'Request failed with status code 400',
    }
    expect(getUserFacingErrorMessage(err)).toContain('salaryMonth')
  })

  // Every status this task explicitly names: 415 unsupported format, 413
  // too large, 401/403 no access, 409 stale conflict, 429 rate limit, 5xx
  // our side. 409/429 (task-i18n-stage3a Task 3, Step 4 — mutation gate
  // found both StringLiteral mutants surviving: the ONLY other place `409`
  // appears in this file feeds a real `data.message`, so it never reaches
  // `STATUS_MESSAGES[409]` at all) — this row is the only coverage either
  // status entry has.
  it.each([
    [415, 'формат'],
    [413, 'великий'],
    [401, 'увійти'],
    [403, 'прав'],
    [409, 'конфлікт'],
    [429, 'забагато'],
    [500, 'нашій стороні'],
    [503, 'нашій стороні'],
  ])(
    'falls back to an honest uk message for status %i with no backend message',
    (status, expectedFragment) => {
      const err = {
        response: { status, data: {} },
        message: `Request failed with status code ${status}`,
      }
      const result = getUserFacingErrorMessage(err)
      expect(result).not.toContain('Request failed')
      expect(result.toLowerCase()).toContain(expectedFragment)
    },
  )

  it('never invents a specific cause for an unmapped 4xx status — generic honest fallback', () => {
    const err = { response: { status: 418, data: {} }, message: "I'm a teapot" }
    const result = getUserFacingErrorMessage(err)
    expect(result).toBe('Не вдалося виконати запит. Спробуйте ще раз.')
  })

  it('reports "no connection to the server" for a network error (no response at all)', () => {
    const networkErr = { isAxiosError: true, message: 'Network Error' }
    expect(getUserFacingErrorMessage(networkErr)).toBe(
      'Немає зв’язку із сервером. Перевірте підключення до інтернету і спробуйте знову.',
    )
  })

  it('falls back to a generic uk message for a non-axios, non-HTTP unknown error', () => {
    expect(getUserFacingErrorMessage(new Error('some internal JS error'))).toBe(
      'Сталася помилка. Спробуйте ще раз.',
    )
    expect(getUserFacingErrorMessage(null)).toBe('Сталася помилка. Спробуйте ще раз.')
  })

  it('never returns axios raw technical text for any of the above cases', () => {
    const cases: unknown[] = [
      { response: { status: 415, data: {} }, message: 'Request failed with status code 415' },
      { isAxiosError: true, message: 'Network Error' },
      { response: { status: 500, data: {} }, message: 'Request failed with status code 500' },
    ]
    for (const c of cases) {
      const result = getUserFacingErrorMessage(c)
      expect(result).not.toMatch(/Request failed|Network Error/)
    }
  })

  // Backlog finding 110. A REAL production 500/403 does not arrive with an
  // EMPTY body (the `data: {}` cases above) — Nest's own default handling
  // populates `response.data.message` with the STANDARD, generic HTTP reason
  // phrase: `BaseExceptionFilter` sends 'Internal server error' for any
  // genuinely unhandled exception (`@nestjs/core`'s
  // `MESSAGES.UNKNOWN_EXCEPTION_MESSAGE`), and `ForbiddenException()` /
  // `NotFoundException()` etc constructed with no explicit text default to
  // their exception class's own reason phrase ('Forbidden', 'Not Found', …
  // — `@nestjs/common`'s `exceptions/*.exception.js`). Both shapes made
  // `extractBackendMessage`'s priority-2 branch treat that phrase as if the
  // backend had explained something — it had not — and the raw English
  // reached a money screen (found live in the cascade-preview panel).
  it.each([
    [500, 'Internal server error', 'нашій стороні'],
    [500, 'Internal Server Error', 'нашій стороні'], // InternalServerErrorException()'s own casing
    [403, 'Forbidden', 'прав'],
    [404, 'Not Found', 'не знайдено'],
    [400, 'Bad Request', 'некоректний'],
    // task-mutation-gate follow-up (PR #613, backlog 121): whitespace
    // padding around an otherwise-generic phrase must still be recognised —
    // `isGenericHttpReasonPhrase` trims before comparing, and this is the
    // one shape that can tell a real `.trim()` apart from a no-op (an exact
    // phrase with no padding passes either way).
    [403, '  Forbidden  ', 'прав'],
  ])(
    'status %i with Nest\'s own default body ("%s") falls through to the honest uk text',
    (status, backendMessage, expectedFragment) => {
      const err = {
        response: { status, data: { message: backendMessage } },
        message: `Request failed with status code ${status}`,
      }
      const result = getUserFacingErrorMessage(err)
      expect(result).not.toBe(backendMessage)
      expect(result.toLowerCase()).toContain(expectedFragment)
    },
  )

  // task-mutation-gate follow-up (PR #613, backlog 121). The five rows above
  // sample five of the set's ~19 phrases — every OTHER entry could be
  // silently dropped without a test noticing. This loop iterates the LIVE
  // export so no current entry is skipped just because nobody picked it —
  // real value, and worth keeping — but it reads BOTH the phrase it sends
  // AND the phrase it checks the result against from that same live
  // export. Corrupt a literal INSIDE `GENERIC_HTTP_REASON_PHRASES` (mutate
  // `'unauthorized'` to `''`, say) and `phrase` here becomes `''` right
  // along with it: the mutant filters `''` out of itself and the assertion
  // stays green. That is exactly how the gate found five survivors
  // (`unauthorized` / `method not allowed` / `not acceptable` / `request
  // timeout` / `http version not supported`) with every test passing —
  // this test was checking the set's self-consistency, not its content.
  // What this loop is genuinely good for: a phrase added to the export
  // LATER, with no corresponding row anywhere else, still gets exercised
  // here for free. Content itself is pinned separately below.
  it('filters EVERY phrase currently in GENERIC_HTTP_REASON_PHRASES, not just the sampled few above — catches a phrase added later with no dedicated test', () => {
    for (const phrase of GENERIC_HTTP_REASON_PHRASES) {
      const err = { response: { status: 500, data: { message: phrase } }, message: 'irrelevant' }
      const result = getUserFacingErrorMessage(err)
      expect(result).not.toBe(phrase)
    }
  })

  // Closes what the loop above cannot: KNOWN_GENERIC_HTTP_REASON_PHRASES is
  // typed out by hand, a genuinely separate literal from the source's
  // `GENERIC_HTTP_REASON_PHRASES` export — NOT imported, NOT derived from
  // it. That duplication is not slack to trim, it is the actual mechanism.
  // If a literal inside the SOURCE set is corrupted, this copy does not
  // move with it: the test still sends the real word (e.g. `'unauthorized'`)
  // as the backend message, the corrupted source set no longer recognises
  // it as generic, and the raw English reaches the return value instead of
  // being filtered — the exact production bug (finding 110) this whole set
  // exists to prevent. `expect(result).not.toBe(phrase)` then fails, where
  // the live-set loop above structurally cannot.
  const KNOWN_GENERIC_HTTP_REASON_PHRASES = [
    'bad request',
    'unauthorized',
    'forbidden',
    'not found',
    'method not allowed',
    'not acceptable',
    'request timeout',
    'conflict',
    'gone',
    'precondition failed',
    'payload too large',
    'unsupported media type',
    'misdirected',
    'unprocessable entity',
    'internal server error',
    'not implemented',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    'http version not supported',
  ]

  it('pins every phrase against an independent hardcoded copy — a corrupted literal in the source set is visible here even though the live-set loop above cannot see it', () => {
    for (const phrase of KNOWN_GENERIC_HTTP_REASON_PHRASES) {
      const err = { response: { status: 500, data: { message: phrase } }, message: 'irrelevant' }
      const result = getUserFacingErrorMessage(err)
      expect(result).not.toBe(phrase)
    }
  })

  it('a REAL backend business message for the same status is still shown verbatim — the filter is narrow', () => {
    const err = { response: { status: 403, data: { message: 'Только владелец может это делать' } } }
    expect(getUserFacingErrorMessage(err)).toBe('Только владелец может это делать')
  })
})

// task-i18n-stage2-task5: this function feeds `err.message` via the global
// axios interceptor (`axios.ts`) — every `toast.error(e.message)` call site
// app-wide reads its output, not just direct `getApiErrorMessage` callers.
// Without this same priority-0 envelope translation, a toast for one of the
// seven migrated endpoints would show the envelope's English fallback
// verbatim (see `apiError()` / `api-error.ts`), not the Ukrainian catalog text.
describe('getUserFacingErrorMessage — API error envelope (task-i18n-stage2-task5)', () => {
  beforeAll(() => {
    i18n.load('uk', {})
    i18n.activate('uk')
  })

  it('translates an API error envelope by code, same as getApiErrorMessage', () => {
    const err = {
      response: {
        status: 403,
        data: { statusCode: 403, code: 'SHARE_DECISION_IMPERSONATION', message: 'fallback' },
      },
    }
    expect(getUserFacingErrorMessage(err)).toBe(
      i18n._(API_ERROR_MESSAGES.SHARE_DECISION_IMPERSONATION),
    )
  })
})

// Backlog finding 110, the other consumer of `extractBackendMessage`. Every
// caller reading `mutation.error` off a real save (staleMessage/submitError
// in AdminEditTransactionDialog) goes through THIS function, not
// `getUserFacingErrorMessage` — it deliberately keeps raw backend text for
// genuine business messages (CP-19/CP-20 pin exactly that). The generic-phrase
// filter has to live where BOTH functions read it (`extractBackendMessage`
// itself) so this one inherits the fix instead of re-introducing the leak.
describe("getApiErrorMessage — Nest's own generic reason phrase is not a real explanation either (finding 110)", () => {
  it('a raw 500 with Nest\'s default body does not leak "Internal server error"', () => {
    const err = {
      response: { status: 500, data: { message: 'Internal server error' } },
      // Simulates the shape a component actually receives: the axios
      // response interceptor (axios.ts) has ALREADY run and overwritten
      // `.message` with the honest uk text before any consumer sees it.
      message: 'Помилка на нашій стороні. Ми вже знаємо про проблему — спробуйте трохи пізніше.',
    }
    const result = getApiErrorMessage(err)
    expect(result).not.toBe('Internal server error')
    expect(result.toLowerCase()).toContain('нашій стороні')
  })

  it('a raw 403 with Nest\'s default body does not leak "Forbidden"', () => {
    const err = {
      response: { status: 403, data: { message: 'Forbidden' } },
      message: 'Недостатньо прав для цієї дії.',
    }
    expect(getApiErrorMessage(err)).not.toBe('Forbidden')
  })

  it('a real backend business message is unaffected — CP-19/CP-20 keep passing', () => {
    const err = { response: { data: { message: 'Некорректная сумма' } }, message: 'irrelevant' }
    expect(getApiErrorMessage(err)).toBe('Некорректная сумма')
  })
})
