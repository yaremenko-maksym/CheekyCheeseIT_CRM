/**
 * A FIFO counting semaphore for one process (backlog 436): at most `size` bodies run at once, the
 * rest wait in arrival order. A release hands its slot straight to the oldest waiter, so a new
 * arrival in the same tick can neither jump the queue nor push the count past the cap.
 */
export class RunSlots {
  private active = 0
  private readonly waiters: { id: string; wake: () => void }[] = []

  /** `size` is a positive integer: the env schema refuses anything else at boot. */
  constructor(private readonly size: number) {}

  /** Ids waiting for a slot, oldest first. */
  waiting(): string[] {
    return this.waiters.map((w) => w.id)
  }

  /** Runs `body` in a slot; the slot is freed however the body ends. */
  async hold<T>(id: string, body: () => Promise<T>): Promise<T> {
    await this.acquire(id)
    try {
      return await body()
    } finally {
      this.release()
    }
  }

  private acquire(id: string): Promise<void> {
    if (this.active < this.size) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((wake) => this.waiters.push({ id, wake }))
  }

  private release(): void {
    const next = this.waiters.shift()
    // The slot passes on as is: `active` stays the same.
    if (next) next.wake()
    else this.active -= 1
  }
}
