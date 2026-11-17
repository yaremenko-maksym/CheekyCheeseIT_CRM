import { z } from 'zod'

/**
 * A senior's own availability (vacancy-queue design §5.2): «Вільно з {d}» / «Зайнято».
 * FREE always carries the day the senior is free from (a past or present day reads as free now);
 * BUSY carries no day. `null` (no row) means nobody has said, and the card shows nothing.
 * This is the SENIOR's availability, never a vacancy's (`job_opportunities.availability`).
 */
export const SENIOR_AVAILABILITY_STATUSES = ['FREE', 'BUSY'] as const

export const seniorAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('FREE'), availableFrom: z.iso.date() }).strict(),
  z.object({ status: z.literal('BUSY') }).strict(),
])

/** GET / PUT `/users/:id/availability`: the stored value, or `null` when never set. */
export const seniorAvailabilityResponseSchema = seniorAvailabilitySchema.nullable()

export type SeniorAvailabilityDto = z.infer<typeof seniorAvailabilitySchema>
