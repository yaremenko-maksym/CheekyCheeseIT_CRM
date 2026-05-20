import { z } from 'zod'

export const googleCallbackSchema = z.object({
  email: z.string().email(),
  googleId: z.string(),
  displayName: z.string(),
  avatar: z.string().url().optional(),
})

export const sessionUserSchema = z.object({
  id: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid UUID',
  ),
  email: z.string().email(),
  displayName: z.string(),
  avatar: z.string().url().nullable(),
  /** User-uploaded avatar (URL or base64 data URL). Takes precedence over `avatar` in UI. */
  avatarOverride: z.string().nullable().optional(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
})

export type GoogleCallbackDto = z.infer<typeof googleCallbackSchema>
export type SessionUser = z.infer<typeof sessionUserSchema>
