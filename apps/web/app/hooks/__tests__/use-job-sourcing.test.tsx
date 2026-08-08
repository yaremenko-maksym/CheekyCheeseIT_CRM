import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()

vi.mock('@/lib/axios', () => ({ api: { post: (...args: unknown[]) => post(...args) } }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))

const { useCreateJobExclusion } = await import('../use-job-sourcing')

/**
 * Code review round 4: the error handler was written but never exercised.
 *
 * It exists because of a design-review finding — an ADMIN/HR with no senior
 * selected must SEE why the exclusion was refused. A generic "Не удалось
 * добавить исключение" would have left the same dead end the silent no-op did,
 * so the value under test is specifically that the SERVER's sentence reaches
 * the user.
 */
function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useCreateJobExclusion — error surfacing', () => {
  beforeEach(() => {
    post.mockReset()
    toastError.mockReset()
    toastSuccess.mockReset()
  })

  it('shows the server’s own message when the API refuses', async () => {
    post.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          message:
            'Выберите синьора, для которого подбираются вакансии — на канбане пока не выбран ни один',
        },
      },
    })

    const { result } = renderHook(() => useCreateJobExclusion(undefined), { wrapper })
    result.current.mutate({ scope: 'SENIOR', kind: 'COMPANY', value: 'EPAM' })

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0]?.[0]).toContain('Выберите синьора')
  })

  it('never shows a raw library string when the connection drops', async () => {
    // This case is why the handler uses `getUserFacingErrorMessage` rather than
    // `getApiErrorMessage`: the latter falls through to axios's own `.message`
    // and put the English "Network Error" in front of a Russian-speaking user.
    post.mockRejectedValue({ isAxiosError: true, message: 'Network Error' })

    const { result } = renderHook(() => useCreateJobExclusion(undefined), { wrapper })
    result.current.mutate({ scope: 'SENIOR', kind: 'COMPANY', value: 'EPAM' })

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    const shown = toastError.mock.calls[0]?.[0] as string
    expect(shown).not.toBe('Network Error')
    expect(shown).toMatch(/[а-яА-Я]/)
    expect(shown).toContain('Нет связи с сервером')
  })

  it('maps a bare error to a Russian sentence too', async () => {
    post.mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useCreateJobExclusion(undefined), { wrapper })
    result.current.mutate({ scope: 'SENIOR', kind: 'COMPANY', value: 'EPAM' })

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    const shown = toastError.mock.calls[0]?.[0] as string
    expect(shown).not.toBe('boom')
    expect(shown).toMatch(/[а-яА-Я]/)
  })

  it('reports success without touching the error path', async () => {
    post.mockResolvedValue({
      data: {
        id: '44444444-4444-4444-8444-444444444444',
        scope: 'SENIOR',
        seniorId: '11111111-1111-4111-8111-111111111111',
        kind: 'COMPANY',
        value: 'EPAM',
        normalizedValue: 'epam',
        origin: 'MANUAL',
        sourceLabel: null,
        createdAt: '2026-08-07T09:00:00.000Z',
      },
    })

    const { result } = renderHook(() => useCreateJobExclusion(undefined), { wrapper })
    result.current.mutate({ scope: 'SENIOR', kind: 'COMPANY', value: 'EPAM' })

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Исключение добавлено'))
    expect(toastError).not.toHaveBeenCalled()
  })
})
