import { Injectable } from '@nestjs/common'
import { inArray } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { nbuDailyRates } from '../database/schema'

/** One persisted NBU day. `day` is `YYYYMMDD`, the format `NbuCurrencyService` keys on. */
export interface PersistedNbuRate {
  day: string
  usdUah: string
  eurUah: string
  sourceId: string
}

const toIso = (ymd: string): string => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
const toYmd = (iso: string): string => iso.replace(/-/g, '')

/**
 * Manager-role plan PR 8 — the `nbu_daily_rates` table behind `NbuCurrencyService`. Deliberately
 * dumb: it neither decides what may be persisted (the service does: exact past-day hits only) nor
 * swallows errors (the service degrades on them, so a missing table never breaks a balance).
 */
@Injectable()
export class NbuRateStore {
  constructor(private readonly db: DatabaseService) {}

  /** The persisted subset of `days`, in one query. */
  async findMany(days: readonly string[]): Promise<Map<string, PersistedNbuRate>> {
    const out = new Map<string, PersistedNbuRate>()
    if (days.length === 0) return out
    const rows = await this.db.db
      .select()
      .from(nbuDailyRates)
      .where(inArray(nbuDailyRates.rateDate, days.map(toIso)))
    for (const r of rows) {
      const day = toYmd(r.rateDate)
      out.set(day, { day, usdUah: r.usdUah, eurUah: r.eurUah, sourceId: r.sourceId })
    }
    return out
  }

  /** Write-once: a day already stored keeps its first value (a past NBU rate never changes). */
  async save(rate: PersistedNbuRate): Promise<void> {
    await this.db.db
      .insert(nbuDailyRates)
      .values({
        rateDate: toIso(rate.day),
        usdUah: rate.usdUah,
        eurUah: rate.eurUah,
        sourceId: rate.sourceId,
      })
      .onConflictDoNothing({ target: nbuDailyRates.rateDate })
  }
}
