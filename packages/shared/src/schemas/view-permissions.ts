import { z } from 'zod'

export const tabKeySchema = z.enum([
  'overview',
  'finance',
  'projects',
  'team',
  'interviews',
  'requisites',
  'documents',
  'audit',
  'contract',
  // task-resume-base: canonical structured CV. Surfaced ONLY on a SENIOR
  // card (the resume is a senior artefact) — see UsersAccessService.
  'resume',
])

export const actionKeySchema = z.enum([
  'edit-profile',
  'change-role',
  'change-salary',
  'change-requisites',
  'set-note',
  'archive',
  // task-user-emails-invite: ADMIN-only "resend invite" action
  // (AdminActionsMenu) — the frontend additionally gates its render on
  // `user.personalEmail && user.personalEmailCanLogin === false`
  // (UsersService.buildProfileView), so this key alone does not mean the
  // button is always visible, only that the viewer is ALLOWED to use it.
  'resend-personal-invite',
])

export const viewPermissionsSchema = z.object({
  tabs: z.array(tabKeySchema),
  actions: z.array(actionKeySchema),
  fields: z.record(z.string(), z.boolean()),
})

export type TabKey = z.infer<typeof tabKeySchema>
export type ActionKey = z.infer<typeof actionKeySchema>
export type ViewPermissions = z.infer<typeof viewPermissionsSchema>
