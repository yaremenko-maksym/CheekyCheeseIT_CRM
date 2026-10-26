import { z } from 'zod'

/**
 * `nextSlot`: WHEN a job source next becomes due, as a pure function (source fetch strategy U1a).
 * Architecture: docs/architecture/2026-10-25-source-fetch-strategy.md, sections 1-4.
 * Nothing calls it yet; the ledger adopts it in U1b.
 */

export function nextSlot(_now: Date, _profile: FetchProfile, _policy: SlotPolicy): Date {
  throw new Error('not implemented')
}

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

const fetchProfileSchema = z.object({
  intervalMinutes: z.number().int().positive(),
  offIntervalMinutes: z.number().int().positive().nullable(),
  window: z
    .object({ timeZone: z.string(), days: z.array(z.enum(DAYS)), from: z.string(), to: z.string() })
    .nullable(),
})

export type FetchProfile = z.infer<typeof fetchProfileSchema>
export interface SlotPolicy {
  readonly floorMinutes: number
  readonly slowdownLevel: number
  readonly staggerKey: string
}
