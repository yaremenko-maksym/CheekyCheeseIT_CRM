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
      response: { data: { message: 'Зарплата уже создана' } },
      message: 'Request failed with status code 400',
    }
    expect(getApiErrorMessage(err)).toBe('Зарплата уже создана')
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
})
