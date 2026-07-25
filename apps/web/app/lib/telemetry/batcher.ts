/**
 * telemetry/batcher — task-telemetry-web AC1 ("батчер (10/15с/флаш на
 * pagehide) — чистая функция тестируема без DOM-хаков").
 *
 * Generic, side-effect-free (besides the injected `send`) event buffer:
 * flushes when it reaches `maxSize` items OR `maxWaitMs` elapses since the
 * first buffered item, whichever comes first (spec §4 "буфер 10 событий или
 * 15с"). The `pagehide`/`visibilitychange(hidden)` → immediate flush case
 * (spec §4) is just `flush()` called externally — see
 * `use-visibility-flush.ts`.
 *
 * Timer/clock are injected (`setTimer`/`clearTimer`/`now` — `now` isn't
 * actually used internally but is accepted for future/consumer symmetry with
 * `route-duration.ts`) so tests can drive the "15s" branch deterministically
 * without real timers or `vi.useFakeTimers()` — see `batcher.test.ts`.
 */
export interface EventBatcherOptions<T> {
  send: (items: T[]) => void
  maxSize?: number
  maxWaitMs?: number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const DEFAULT_MAX_SIZE = 10
const DEFAULT_MAX_WAIT_MS = 15_000

export class EventBatcher<T> {
  private buffer: T[] = []
  private timerHandle: unknown = null
  private readonly maxSize: number
  private readonly maxWaitMs: number
  private readonly send: (items: T[]) => void
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(options: EventBatcherOptions<T>) {
    this.send = options.send
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** Buffers one item; flushes immediately once the buffer reaches `maxSize`. */
  add(item: T): void {
    this.buffer.push(item)
    if (this.buffer.length >= this.maxSize) {
      this.flush()
      return
    }
    if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => this.flush(), this.maxWaitMs)
    }
  }

  /** Sends whatever is buffered (no-op if empty) and cancels the pending timer. */
  flush(): void {
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle)
      this.timerHandle = null
    }
    if (this.buffer.length === 0) return
    const items = this.buffer
    this.buffer = []
    this.send(items)
  }

  /** Current buffer size — test/inspection helper. */
  size(): number {
    return this.buffer.length
  }
}
