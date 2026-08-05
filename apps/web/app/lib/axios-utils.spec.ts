import { describe, expect, it } from 'vitest'
import { getAxiosStatus, getApiErrorMessage, getUserFacingErrorMessage } from './axios-utils'

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
})
