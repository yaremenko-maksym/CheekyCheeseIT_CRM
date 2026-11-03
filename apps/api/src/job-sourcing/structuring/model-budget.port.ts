/** Model calls one collection cycle may make, shared by every HTML provider. */
export const HTML_MODEL_CALLS_PER_CYCLE = 20

declare const reservationBrand: unique symbol
/** An opaque hold on one call; only the budget that issued it can settle it. */
export interface Reservation {
  readonly [reservationBrand]: true
}

export interface ModelUsage {
  readonly totalTokens?: number
}

/**
 * Reserve a call BEFORE making it. Every reservation ends exactly once: `commit` when the call
 * produced a usable result, `release` on every other path (failure, timeout, cancellation), which
 * returns the slot to the cycle.
 */
export interface ModelBudgetPort {
  reserve(): Reservation | null
  release(reservation: Reservation): void
  commit(reservation: Reservation, usage?: ModelUsage): void
}

export interface BudgetSnapshot {
  readonly committed: number
  readonly reserved: number
  readonly totalTokens: number
}

/** One cycle's budget held in memory. The DB-backed reservation / daily-usage adapter is separate. */
export class InMemoryModelBudget implements ModelBudgetPort {
  private readonly open = new Set<Reservation>()
  private committed = 0
  private totalTokens = 0

  constructor(private readonly limit: number = HTML_MODEL_CALLS_PER_CYCLE) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(`model call limit must be a non-negative integer, got ${String(limit)}`)
    }
  }

  reserve(): Reservation | null {
    if (this.committed + this.open.size >= this.limit) return null
    // A fresh object per hold: identity is the token, nothing outside can forge one.
    const reservation = Object.freeze({}) as Reservation
    this.open.add(reservation)
    return reservation
  }

  /** Settling a reservation twice, or one this budget never issued, changes nothing. */
  release(reservation: Reservation): void {
    this.open.delete(reservation)
  }

  commit(reservation: Reservation, usage?: ModelUsage): void {
    if (!this.open.delete(reservation)) return
    this.committed += 1
    this.totalTokens += usage?.totalTokens ?? 0
  }

  snapshot(): BudgetSnapshot {
    return { committed: this.committed, reserved: this.open.size, totalTokens: this.totalTokens }
  }
}
