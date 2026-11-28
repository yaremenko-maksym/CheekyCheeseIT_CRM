/**
 * Manager-role plan PR 8 (design §4.6 currency) — `nbu_daily_rates`: the official NBU rate of one
 * PAST calendar day, persisted the first time `NbuCurrencyService` fetched it as an exact-date hit.
 * A past day's NBU rate never changes, so a row is written once (`ON CONFLICT DO NOTHING`) and never
 * updated; a later read of that day never calls NBU. Only exact hits are stored: never a
 * previous-day, cached or hardcoded fallback, and never today (see `NbuRateStore`).
 * Production gets the table ONLY through `drizzle/manual/2026-11-28_nbu_daily_rates.sql`.
 */
import { sql } from 'drizzle-orm'
import { check, date, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const nbuDailyRates = pgTable(
  'nbu_daily_rates',
  {
    // The day the rate APPLIES TO (NBU `exchangedate`), not the day it was fetched.
    rateDate: date('rate_date', { mode: 'string' }).primaryKey(),
    // Same 4-decimal scale `NbuCurrencyService` formats with, so a persisted read is byte-identical.
    usdUah: numeric('usd_uah', { precision: 14, scale: 4 }).notNull(),
    eurUah: numeric('eur_uah', { precision: 14, scale: 4 }).notNull(),
    // Which NBU service answered (`NBU_SOURCES[].id`) — provenance only.
    sourceId: text('source_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('ck_nbu_daily_rates_positive', sql`${t.usdUah} > 0 AND ${t.eurUah} > 0`)],
)
