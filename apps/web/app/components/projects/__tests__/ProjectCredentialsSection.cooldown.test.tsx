/**
 * ProjectCredentialsSection: after a 429 the reveal button counts down once per second.
 *
 * The seconds are derived from the clock. Under the React Compiler a render-time
 * `Date.now()` read is not a memo dependency, so the countdown must come from state
 * the interval updates, or it freezes at its first value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const credential = {
  id: 'cred-1',
  projectId: 'proj-1',
  label: 'Staging',
  login: 'admin',
  url: null,
  notes: null,
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
}
const tooManyRequests = Object.assign(new Error('429'), { response: { status: 429 } })
const reveal = { isPending: false, mutateAsync: vi.fn(() => Promise.reject(tooManyRequests)) }
const del = { isPending: false, mutateAsync: vi.fn() }
const credentials = { data: [credential], isLoading: false, isError: false }

vi.mock('@/hooks/use-credentials', () => ({
  useCredentials: () => credentials,
  useRevealCredential: () => reveal,
  useDeleteCredential: () => del,
  useCreateCredential: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateCredential: () => ({ isPending: false, mutateAsync: vi.fn() }),
}))

import { ProjectCredentialsSection } from '../ProjectCredentialsSection'

const secondsLeft = () => {
  const title = screen.getByTestId('credentials-reveal-btn-cred-1').getAttribute('title') ?? ''
  return Number(/(\d+)/.exec(title)?.[1])
}

describe('ProjectCredentialsSection — 429 cooldown countdown', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
    await loadCatalog('en')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('decreases the visible seconds every second, then re-enables reveal', async () => {
    render(<ProjectCredentialsSection projectId="proj-1" canEdit={false} />, {
      wrapper: I18nTestProvider,
    })
    const button = screen.getByTestId('credentials-reveal-btn-cred-1')
    // The page has been open for a while: the cooldown counts from the 429, not from mount.
    vi.setSystemTime(new Date('2026-11-11T12:05:00Z'))

    await act(async () => {
      fireEvent.click(button)
    })
    expect(secondsLeft()).toBe(60)
    expect(button).toBeDisabled()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(secondsLeft()).toBe(59)

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(secondsLeft()).toBe(58)

    await act(async () => {
      vi.advanceTimersByTime(57_000)
    })
    expect(secondsLeft()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    // The tick where now === cooldownUntil clears the cooldown and stops the interval.
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute('title')
  })
})
