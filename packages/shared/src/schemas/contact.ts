import { z } from 'zod'

/**
 * task-landing-contact-and-hiring-strip.md — public "Start a project"
 * contact form (`POST /api/public/contact`). NOT persisted to the DB (owner
 * decision #2 in the task file) — this is the wire contract for a plain-JSON
 * request the API fans out as an email to every ADMIN via Resend
 * (`ContactService`), it never becomes a database row.
 *
 * Mirrors `applyVacancyFieldsSchema` (vacancies.ts) conventions: a honeypot
 * `website` field (`max(0)` — a real visitor's browser never fills it, a
 * bot's autofill usually does) + a Turnstile token, both stripped before
 * anything reaches the email body.
 */
export const contactRequestSchema = z.object({
  name: z.string().min(2).max(80),
  company: z.string().max(120).optional(),
  email: z.email().max(160),
  message: z.string().min(10).max(2000),
  turnstileToken: z.string().min(1),
  website: z.string().max(0).optional(), // honeypot
})
export type ContactRequest = z.infer<typeof contactRequestSchema>
