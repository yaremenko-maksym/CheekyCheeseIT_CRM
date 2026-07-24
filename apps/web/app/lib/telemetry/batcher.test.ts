import { describe, expect, it, vi } from 'vitest'
import { EventBatcher } from './batcher'

/**
 * Deterministic manual-timer harness — no `vi.useFakeTimers()`/real
 * `setTimeout` involved. `setTimer` just records the callback; the test
 * fires it explicitly to simulate "15s elapsed".
 */
function manualTimers() {
  let handleSeq = 0
  const pending = new Map<number, () => void>()
  const cleared = new Set<number>()
  return {
    setTimer: vi.fn((cb: () => void, _ms: number) => {
      const handle = ++handleSeq
      pending.set(handle, cb)
      return handle
    }),
    clearTimer: vi.fn((handle: unknown) => {
      cleared.add(handle as number)
      pending.delete(handle as number)
    }),
    fire(handle: number) {
      pending.get(handle)?.()
    },
    wasCleared(handle: number) {
      return cleared.has(handle)
    },
  }
}

describe('EventBatcher', () => {
  it('does not send anything before maxSize or the timer fires', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<number>({
      send,
      maxSize: 10,
      maxWaitMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    for (let i = 0; i < 9; i++) batcher.add(i)

    expect(send).not.toHaveBeenCalled()
    expect(batcher.size()).toBe(9)
  })

  it('flushes immediately once the buffer reaches maxSize (10)', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<number>({
      send,
      maxSize: 10,
      maxWaitMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    for (let i = 0; i < 10; i++) batcher.add(i)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(batcher.size()).toBe(0)
  })

  it('flushes when the 15s timer fires, even with fewer than maxSize items', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<string>({
      send,
      maxSize: 10,
      maxWaitMs: 15_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    batcher.add('a')
    batcher.add('b')
    expect(timers.setTimer).toHaveBeenCalledTimes(1)
    expect(timers.setTimer.mock.calls[0]?.[1]).toBe(15_000)

    timers.fire(1)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(['a', 'b'])
    expect(batcher.size()).toBe(0)
  })

  it('only starts ONE timer per buffering window (not one per add)', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<number>({
      send,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    batcher.add(1)
    batcher.add(2)
    batcher.add(3)

    expect(timers.setTimer).toHaveBeenCalledTimes(1)
  })

  it('flush() on pagehide sends whatever is buffered and cancels the pending timer', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<number>({
      send,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    batcher.add(1)
    batcher.add(2)
    batcher.flush()

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith([1, 2])
    expect(timers.wasCleared(1)).toBe(true)
  })

  it('flush() on an empty buffer is a silent no-op (no empty POST)', () => {
    const send = vi.fn()
    const batcher = new EventBatcher<number>({ send })

    batcher.flush()

    expect(send).not.toHaveBeenCalled()
  })

  it('starts a fresh timer for the NEXT window after a flush', () => {
    const send = vi.fn()
    const timers = manualTimers()
    const batcher = new EventBatcher<number>({
      send,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    batcher.add(1)
    timers.fire(1)
    expect(send).toHaveBeenCalledTimes(1)

    batcher.add(2)
    expect(timers.setTimer).toHaveBeenCalledTimes(2)
  })
})
