import { describe, expect, it } from 'vitest'
import settle from 'axios/unsafe/core/settle.js'
import { api } from './axios'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'

/**
 * security-review round 2, HIGH-1 — permanent regression coverage.
 *
 * Repro-confirmed (not reasoned) against the REAL installed axios (1.17.0):
 * `Error.prototype.stack` is materialized LAZILY by V8 — the header line
 * ("AxiosError: <message>") is built from whatever `.message` holds at the
 * moment something FIRST reads `.stack`, not at throw time. Axios's own
 * `Axios.prototype.request` reads `.stack` (to append call-site frames)
 * AFTER our response interceptor runs. Before the fix, mutating
 * `error.message` first meant that later read froze the header with the
 * (possibly backend-echoed, PII-carrying) humanized text — permanently,
 * since V8 caches the string after first access. The fix is a `void
 * error.stack` read BEFORE the `.message` mutation in `axios.ts`.
 *
 * This spec exercises 100% real axios internals via a custom `adapter`
 * (axios's own official extensibility point — no mocking library, no new
 * dependency) that calls the REAL `settle()` (the function real adapters
 * use to turn a raw HTTP response into resolve/reject), so
 * `Axios.prototype.request`'s stack-enhancement code actually runs, exactly
 * as it does against a real network response.
 */
function fakeAdapter(backendMessage: string, status: number) {
  return (config: AxiosRequestConfig): Promise<AxiosResponse> =>
    new Promise((resolve, reject) => {
      settle(resolve, reject, {
        data: { message: backendMessage },
        status,
        statusText: 'error',
        headers: {},
        config,
        request: {},
      } as AxiosResponse)
    })
}

describe('axios.ts interceptor — HIGH-1: .stack never carries the backend-echoed message', () => {
  it('freezes the stack header with the ORIGINAL axios text, even though .message becomes the backend message', async () => {
    const backendMessage = 'Пользователь vasya@example.com уже существует'

    let caught: { message?: string; stack?: string } | undefined
    try {
      await api.get('/users', { adapter: fakeAdapter(backendMessage, 409) })
    } catch (err) {
      caught = err as { message?: string; stack?: string }
    }

    expect(caught).toBeDefined()
    // .message IS the backend text — that's the intended, unrelated fix
    // (task fix/api-error-messages) letting the SAME user see it in a toast.
    expect(caught?.message).toBe(backendMessage)
    // .stack's header must stay the safe, generic axios-generated text —
    // never the backend-echoed one, regardless of what .message became.
    expect(caught?.stack?.split('\n')[0]).toBe('AxiosError: Request failed with status code 409')
    expect(caught?.stack).not.toContain('vasya@example.com')
  })

  it('freezes the header safely for a status with NO backend message too (pure status-code text)', async () => {
    let caught: { message?: string; stack?: string } | undefined
    try {
      await api.get('/documents', { adapter: fakeAdapter('', 415) })
    } catch (err) {
      caught = err as { message?: string; stack?: string }
    }

    expect(caught?.message).toBe('Формат файла не поддерживается.')
    expect(caught?.stack?.split('\n')[0]).toBe('AxiosError: Request failed with status code 415')
  })
})
