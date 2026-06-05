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
])

export const actionKeySchema = z.enum([
  'edit-profile',
  'change-role',
  'change-salary',
  'change-requisites',
  'set-note',
  'archive',
])

export const viewPermissionsSchema = z.object({
  tabs: z.array(tabKeySchema),
  actions: z.array(actionKeySchema),
  fields: z.record(z.string(), z.boolean()),
})

export type TabKey = z.infer<typeof tabKeySchema>
export type ActionKey = z.infer<typeof actionKeySchema>
export type ViewPermissions = z.infer<typeof viewPermissionsSchema>
