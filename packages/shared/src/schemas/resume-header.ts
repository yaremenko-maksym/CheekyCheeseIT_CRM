/**
 * The resume header: name, email, phone and Telegram printed at the top of the PDF.
 *
 * Each value defaults to the senior's CRM profile. HR may override any of them per resume
 * (`senior_resumes.header`); a `null` field follows the profile, so a later profile edit still
 * reaches every field HR did not override. The overrides are validated here, the profile values
 * are not: a profile that fails these rules (one-word name, no phone) still renders as it is.
 */
import { z } from 'zod'

/** Two words or more, letters with an inner apostrophe, hyphen or dot (`Anna-Maria O'Neil`). */
const NAME_PATTERN = /^\p{L}+(?:['’.-]\p{L}+)*\.?(?:\s+\p{L}+(?:['’.-]\p{L}+)*\.?)+$/u
/** International form: `+`, then digits with optional spaces, dashes or parentheses. */
const PHONE_PATTERN = /^\+\d[\d\s()-]*\d$/
/** `@` and a Telegram username: a letter first, 5–32 characters of Latin letters, digits or `_`. */
const TELEGRAM_PATTERN = /^@[A-Za-z]\w{4,31}$/

export const resumeHeaderNameSchema = z
  .string()
  .trim()
  .max(255)
  .regex(NAME_PATTERN, 'zod.RESUME_HEADER_NAME_FORMAT')

export const resumeHeaderEmailSchema = z.string().trim().max(255).email('zod.EMAIL_INVALID')

export const resumeHeaderPhoneSchema = z
  .string()
  .trim()
  .max(30)
  .regex(PHONE_PATTERN, 'zod.PHONE_INVALID')
  .refine((phone) => {
    const digits = phone.replace(/\D/g, '').length
    return digits >= 9 && digits <= 15
  }, 'zod.PHONE_INVALID')

export const resumeHeaderTelegramSchema = z
  .string()
  .trim()
  .regex(TELEGRAM_PATTERN, 'zod.RESUME_HEADER_TELEGRAM_FORMAT')

/** HR's overrides. `null` = the profile value. */
export const resumeHeaderOverridesSchema = z.object({
  displayName: resumeHeaderNameSchema.nullable(),
  email: resumeHeaderEmailSchema.nullable(),
  phone: resumeHeaderPhoneSchema.nullable(),
  telegram: resumeHeaderTelegramSchema.nullable(),
})
export type ResumeHeaderOverrides = z.infer<typeof resumeHeaderOverridesSchema>

export const EMPTY_RESUME_HEADER: ResumeHeaderOverrides = {
  displayName: null,
  email: null,
  phone: null,
  telegram: null,
}

export const updateResumeHeaderSchema = z.object({ header: resumeHeaderOverridesSchema })
export type UpdateResumeHeaderInput = z.infer<typeof updateResumeHeaderSchema>

/** The profile values the header defaults to (`users` columns, as stored). */
export const resumeHeaderDefaultsSchema = z.object({
  displayName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  telegram: z.string().nullable(),
})
export type ResumeHeaderValues = z.infer<typeof resumeHeaderDefaultsSchema>

/**
 * The stored overrides, read through their schema: a malformed `header` column overrides nothing,
 * as a malformed layout falls back to the default.
 */
export function parseResumeHeader(raw: unknown): ResumeHeaderOverrides {
  return resumeHeaderOverridesSchema.safeParse(raw).data ?? EMPTY_RESUME_HEADER
}

/** The header the PDF prints: each override, else the profile value. */
export function resolveResumeHeader<T extends ResumeHeaderValues>(profile: T, raw: unknown): T {
  const header = parseResumeHeader(raw)
  return {
    ...profile,
    displayName: header.displayName ?? profile.displayName,
    email: header.email ?? profile.email,
    phone: header.phone ?? profile.phone,
    telegram: header.telegram ?? profile.telegram,
  }
}
