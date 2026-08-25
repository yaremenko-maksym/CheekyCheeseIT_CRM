import { describe, expect, it } from 'vitest'
import {
  getAxiosStatus,
  getApiErrorMessage,
  getUserFacingErrorMessage,
  stripQueryString,
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
    expect(getApiErrorMessage(null)).toBe('Произошла ошибка')
  })

  it('falls back to default string for plain string error', () => {
    expect(getApiErrorMessage('oops')).toBe('Произошла ошибка')
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
  // too large, 401/403 no access, 5xx our side.
  it.each([
    [415, 'формат'],
    [413, 'больш'],
    [401, 'войти'],
    [403, 'прав'],
    [500, 'нашей стороне'],
    [503, 'нашей стороне'],
  ])(
    'falls back to an honest Russian message for status %i with no backend message',
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
    expect(result).toBe('Не удалось выполнить запрос. Попробуйте ещё раз.')
  })

  it('reports "no connection to the server" for a network error (no response at all)', () => {
    const networkErr = { isAxiosError: true, message: 'Network Error' }
    expect(getUserFacingErrorMessage(networkErr)).toBe(
      'Нет связи с сервером. Проверьте подключение к интернету и попробуйте снова.',
    )
  })

  it('falls back to a generic Russian message for a non-axios, non-HTTP unknown error', () => {
    expect(getUserFacingErrorMessage(new Error('some internal JS error'))).toBe(
      'Произошла ошибка. Попробуйте ещё раз.',
    )
    expect(getUserFacingErrorMessage(null)).toBe('Произошла ошибка. Попробуйте ещё раз.')
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
    [500, 'Internal server error', 'нашей стороне'],
    [500, 'Internal Server Error', 'нашей стороне'], // InternalServerErrorException()'s own casing
    [403, 'Forbidden', 'прав'],
    [404, 'Not Found', 'не найдены'],
    [400, 'Bad Request', 'некорректный'],
  ])(
    'status %i with Nest\'s own default body ("%s") falls through to the honest Russian text',
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

  it('a REAL backend business message for the same status is still shown verbatim — the filter is narrow', () => {
    const err = { response: { status: 403, data: { message: 'Только владелец может это делать' } } }
    expect(getUserFacingErrorMessage(err)).toBe('Только владелец может это делать')
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
      // `.message` with the honest Russian text before any consumer sees it.
      message: 'Ошибка на нашей стороне. Мы уже знаем о проблеме — попробуйте немного позже.',
    }
    const result = getApiErrorMessage(err)
    expect(result).not.toBe('Internal server error')
    expect(result.toLowerCase()).toContain('нашей стороне')
  })

  it('a raw 403 with Nest\'s default body does not leak "Forbidden"', () => {
    const err = {
      response: { status: 403, data: { message: 'Forbidden' } },
      message: 'Недостаточно прав для этого действия.',
    }
    expect(getApiErrorMessage(err)).not.toBe('Forbidden')
  })

  it('a real backend business message is unaffected — CP-19/CP-20 keep passing', () => {
    const err = { response: { data: { message: 'Некорректная сумма' } }, message: 'irrelevant' }
    expect(getApiErrorMessage(err)).toBe('Некорректная сумма')
  })
})
