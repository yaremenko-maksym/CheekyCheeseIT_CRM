/**
 * The one counting semaphore the resume pipeline uses.
 *
 * Two places need "no more than N of these at a time" and they need it for the
 * SAME reason — a bounded working set of expensive, attacker-triggerable work:
 *   - `ResumeTextExtractionService`: bounds peak memory held by parsers;
 *   - `ResumeTypstService`: bounds how many child processes may compete with
 *     the API for CPU (task §2, "не более одного-двух рендеров одновременно").
 *
 * Lifted out of the extraction service rather than copied into the renderer:
 * the queue is four lines and both copies would have needed the same fix if
 * either were wrong (the `finally`-release is the part that is easy to get
 * wrong, and getting it wrong deadlocks the endpoint permanently).
 */
export class ResumeSemaphore {
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  /** In-flight holders right now — the gate's only observable effect. */
  get active(): number {
    return this.running
  }

  /** Admitted but still waiting for a slot. */
  get queued(): number {
    return this.waiting.length
  }

  /**
   * Run `task` while holding a slot.
   *
   * The release is in a `finally`, so a throwing task frees its slot — the
   * failure mode that would otherwise be permanent: a parser that throws on a
   * malformed file is the NORMAL case here, not an exceptional one, so leaking
   * a slot per bad upload would wedge the whole pipeline within minutes.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.running -= 1
    this.waiting.shift()?.()
  }
}
