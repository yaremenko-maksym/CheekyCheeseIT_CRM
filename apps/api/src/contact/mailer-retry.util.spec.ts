import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeErrorReason, sleep } from './mailer-retry.util'

describe('safeErrorReason', () => {
  it('extracts only the HTTP status and drops the provider body', () => {
    const err = new Error(
      'Resend API HTTP 422: {"message":"invalid recipient victim@example.com","long":"' +
        'x'.repeat(500) +
        '"}',
    )
    expect(safeErrorReason(err)).toBe('Resend API HTTP 422')
  })

  it('falls back to the constructor name for non-Status Error messages', () => {
    expect(safeErrorReason(new Error('socket hang up'))).toBe('Error')
    expect(safeErrorReason(new TypeError('fetch failed'))).toBe('TypeError')
  })

  it('matches the status only at the start of the message', () => {
    expect(safeErrorReason(new Error('wrapped: Resend API HTTP 422'))).toBe('Error')
  })

  it('returns "unknown" for every non-Error value', () => {
    expect(safeErrorReason('Resend API HTTP 500: body')).toBe('unknown')
    expect(safeErrorReason(undefined)).toBe('unknown')
    expect(safeErrorReason(null)).toBe('unknown')
    expect(safeErrorReason({ message: 'Resend API HTTP 500' })).toBe('unknown')
  })
})

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves only once the requested delay has elapsed', async () => {
    vi.useFakeTimers()
    let resolved = false
    const pending = sleep(500).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(499)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(resolved).toBe(true)
  })

  it('resolves immediately for a zero delay', async () => {
    vi.useFakeTimers()
    const pending = sleep(0)
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toBeUndefined()
  })
})
