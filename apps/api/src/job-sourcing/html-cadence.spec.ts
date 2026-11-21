import { describe, expect, it } from 'vitest'
import { HTML_COLLECTION_CRON } from './job-sourcing.cron'
import { nextAttemptAt } from './ownership/ledger-policy'
import { MANIFEST_DEFINITIONS } from './providers/manifest.definitions'
import { HTML_RUN_TIMES } from './providers/manifest.fetch-profile'
import { SMARTRECRUITERS_BOUNDS } from './providers/sources/smartrecruiters.provider'
import { LEDGER_CATALOG_SNAPSHOT } from './runtime/ledger-catalog.snapshot'
import { productionLedgerCatalog } from './runtime/production-catalog'

/**
 * Task sources-15 (owner, 2026-11-21): every live HTML source runs at the four Kyiv slots of the HTML
 * cron, 6 h apart. The HTML handler claims with the cadence term (`next_attempt_at <= now`), so the
 * `next_attempt_at` a run writes must have come by the next slot, or that slot claims nothing.
 */
const LIVE_HTML = [
  'JUSTJOIN_HTML',
  'THEHUB_HTML',
  'LANDINGJOBS_HTML',
  'NEXTLEVELJOBS_HTML',
  'DICE_HTML',
  'NOFLUFF_HTML',
] as const

const MINUTE = 60_000
/** November: Kyiv is UTC+2, so the slots are 00:30, 06:30, 12:30 and 18:30 UTC. */
const kyivSlotsUtc = (day: string): Date[] =>
  HTML_RUN_TIMES.map((t) => {
    const [h, m] = t.split(':').map(Number) as [number, number]
    return new Date(Date.parse(`${day}T00:00:00Z`) + ((h - 2) * 60 + m) * MINUTE)
  })

describe('HTML sources: four runs a day (sources-15)', () => {
  it('the cron fires at the four slot times, 6 h apart', () => {
    expect(HTML_RUN_TIMES).toEqual(['02:30', '08:30', '14:30', '20:30'])
    expect(HTML_COLLECTION_CRON).toBe('30 2,8,14,20 * * *')
  })

  it('every live HTML type carries an entry with a profile', () => {
    for (const type of LIVE_HTML) {
      const entries = LEDGER_CATALOG_SNAPSHOT.entries.filter((e) => e.type === type)
      expect(entries.length, type).toBeGreaterThan(0)
      for (const e of entries) expect(e.fetchProfile, e.id).not.toBeNull()
    }
  })

  // A weekday and a Saturday: a working-hours window would put the weekend on its off interval.
  for (const day of ['2026-11-25', '2026-11-28']) {
    it(`on ${day} a run at each slot leaves the source due at the next slot`, () => {
      const catalog = productionLedgerCatalog()
      const slots = kyivSlotsUtc(day)
      const nextDaySlot = kyivSlotsUtc(
        new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * MINUTE).toISOString().slice(0, 10),
      )[0]!
      for (const e of LEDGER_CATALOG_SNAPSHOT.entries.filter((x) =>
        (LIVE_HTML as readonly string[]).includes(x.type),
      )) {
        slots.forEach((slot, k) => {
          const following = slots[k + 1] ?? nextDaySlot
          // The earliest finish (claimed at once) and the latest (10 min jitter + a full 60 min window).
          for (const finishMin of [1, 70]) {
            const finish = new Date(slot.getTime() + finishMin * MINUTE)
            const next = nextAttemptAt(finish, e.id, catalog.entry(e.id), 0)
            expect(next, `${e.id} after ${slot.toISOString()}`).not.toBeNull()
            expect(next!.getTime(), `${e.id} after ${slot.toISOString()}`).toBeLessThanOrEqual(
              following.getTime(),
            )
            // And not before it: a slot claims a source once, never twice.
            expect(next!.getTime(), `${e.id} after ${slot.toISOString()}`).toBeGreaterThan(
              finish.getTime(),
            )
          }
        })
      }
    })
  }
})

describe('SmartRecruiters: 10 requests a minute (sources-15)', () => {
  const host = (key: string) => LEDGER_CATALOG_SNAPSHOT.hosts.find((h) => h.hostKey === key)?.policy
  const sr = host('api.smartrecruiters.com')

  it('its host budget is 10 a minute, the run ceiling 10, and both pass the claim-time check', () => {
    expect(sr?.requestBudget).toEqual({ perMinute: 10, perHour: 120 })
    expect(sr?.requestsPerRun).toBe(10)
    expect(SMARTRECRUITERS_BOUNDS.maxRequests).toBe(sr?.requestsPerRun)
    // `assertPolicy`: a run never sends more than the minute allows, the hour covers the minute.
    expect(sr!.requestsPerRun!).toBeLessThanOrEqual(sr!.requestBudget!.perMinute)
    expect(sr!.requestBudget!.perHour).toBeGreaterThanOrEqual(sr!.requestBudget!.perMinute)
  })

  it('a run reads at most 9 postings: one list request plus one detail request each', () => {
    expect(SMARTRECRUITERS_BOUNDS.maxListPages).toBe(1)
    expect(SMARTRECRUITERS_BOUNDS.pageSize).toBe(9)
    expect(SMARTRECRUITERS_BOUNDS.maxListPages + SMARTRECRUITERS_BOUNDS.pageSize).toBe(
      SMARTRECRUITERS_BOUNDS.maxRequests,
    )
  })

  it('every other BOARD type keeps the 2-a-minute floor', () => {
    const others = MANIFEST_DEFINITIONS.filter(
      (d) => d.scopeKind === 'BOARD' && d.type !== 'SMARTRECRUITERS_ATS',
    )
    expect(others.length).toBeGreaterThan(0)
    for (const d of others)
      expect(d.hostRequestBudget, d.type).toEqual({ perMinute: 2, perHour: 120 })
  })
})
