import { describe, expect, it } from 'vitest'
import { getAxiosStatus, getApiErrorMessage } from './axios-utils'

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
