import { z } from 'zod'

// ---------------------------------------------------------------------------
// Legend Entry — journal record added by viewers (ADMIN / HR / JUNIOR)
// ---------------------------------------------------------------------------

export const legendEntrySchema = z.object({
  id: z.string().uuid(),
  legendId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  text: z.string(),
  createdAt: z.string(), // ISO 8601
})

export type LegendEntry = z.infer<typeof legendEntrySchema>

// ---------------------------------------------------------------------------
// Legend — client-facing persona profile, one per project
// ---------------------------------------------------------------------------

export const legendSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** Client-facing persona full name (Cyrillic). Separate from legalFullName. */
  fullName: z.string().min(1, 'ФИО обязательно'),
  dateOfBirth: z.string().nullable(),
  address: z.string().nullable(),
  presentedRole: z.string().nullable(),
  presentedStack: z.string().nullable(),
  backstory: z.string().nullable(),
  hobbies: z.string().nullable(),
  notes: z.string().nullable(),
  entries: z.array(legendEntrySchema),
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
  fullName: z.string().min(1, 'Имя обязательно'),
  dateOfBirth: isoDateString.nullish(),
  address: z.string().nullish(),
  presentedRole: z.string().nullish(),
  presentedStack: z.string().nullish(),
  backstory: z.string().nullish(),
  hobbies: z.string().nullish(),
  notes: z.string().nullish(),
})

export type UpsertLegendDto = z.infer<typeof upsertLegendSchema>

export const addLegendEntrySchema = z.object({
  text: z.string().min(1, 'Текст обязателен').max(5000),
})

export type AddLegendEntryDto = z.infer<typeof addLegendEntrySchema>
