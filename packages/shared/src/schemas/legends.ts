import { z } from 'zod'

// ---------------------------------------------------------------------------
// Legend — client-facing SENIOR persona
//
// The «legend» is the profile a SENIOR presents to client companies. It is
// intentionally SEPARATE from users.legalFullName (which is the real
// passport/legal name used for MSA contracts). The legend fullName is a
// client-facing persona name and can differ from the legal name.
// ---------------------------------------------------------------------------

export const legendSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  /** Client-facing persona full name (Cyrillic). Separate from legalFullName. */
  fullName: z.string().min(1, 'ФИО обязательно'),
  dateOfBirth: z.string().nullable(),
  address: z.string().nullable(),
  hobbies: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Legend = z.infer<typeof legendSchema>

/**
 * ISO date string — YYYY-MM-DD (10 chars, numbers + dashes).
 * We store as text in the DB so the format is enforced here at the boundary.
 */
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата должна быть в формате ГГГГ-ММ-ДД (например, 1990-01-15)')

export const upsertLegendSchema = z.object({
  /** Client-facing persona full name (required). */
  fullName: z.string().min(1, 'ФИО обязательно'),
  dateOfBirth: isoDateString.nullable().optional(),
  address: z.string().nullable().optional(),
  hobbies: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

export type UpsertLegendDto = z.infer<typeof upsertLegendSchema>
