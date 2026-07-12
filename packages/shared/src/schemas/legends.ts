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
  /** Optional event date (YYYY-MM-DD). Falls back to createdAt for display if null. */
  eventDate: z.string().nullable(),
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
  /**
   * Persona prefill data from the real subject (drop ?? senior).
   * Only provided when viewer is ADMIN or HR (team-scoped).
   * JUNIOR viewers always receive null — prevents real identity leakage (AC8 / bug class #157/#158).
   */
  defaults: z
    .object({
      fullName: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable()
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Legend = z.infer<typeof legendSchema>

/**
 * Response schema for GET /projects/:projectId/legend.
 * - Legend object when legend exists for the project
 * - null when project is accessible but no legend has been created yet
 *   (200 with null body — replaces the former 404 for missing-legend case)
 */
export const legendResponseSchema = legendSchema.nullable()
export type LegendResponse = z.infer<typeof legendResponseSchema>

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
  /** Optional event date (YYYY-MM-DD). Defaults to today on client, stored as-is. */
  eventDate: isoDateString.nullish(),
})

export type AddLegendEntryDto = z.infer<typeof addLegendEntrySchema>

// ---------------------------------------------------------------------------
// Salary meta — GET /api/users/me/salary-meta
// ---------------------------------------------------------------------------

/**
 * Self-only salary metadata for the JUNIOR hub salary block.
 * changedAt = created_at of the last user_audit_log row for this user
 * where changes contains 'monthlySalary' key (actual values are redacted).
 */
export const salaryMetaSchema = z.object({
  monthlySalary: z.string().nullable(), // numeric string from DB, null if not set
  salaryCurrency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).nullable(),
  changedAt: z.string().nullable(), // ISO 8601 or null
})

export type SalaryMetaDto = z.infer<typeof salaryMetaSchema>
