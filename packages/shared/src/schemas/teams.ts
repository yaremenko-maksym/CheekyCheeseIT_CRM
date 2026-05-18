import { z } from 'zod'

export const teamMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  avatar: z.string().url().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT']),
  techStack: z.string().nullable(),
  joinedAt: z.string().or(z.date()),
})

export const teamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  telegram: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  members: z.array(teamMemberSchema),
})

export const createTeamSchema = z.object({
  name: z.string().min(1).max(255),
  seniorId: z.string().uuid(),
  hrIds: z.array(z.string().uuid()).min(1),
  accountantId: z.string().uuid().nullable(),
})

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255),
  telegram: z
    .string()
    .max(500)
    .refine(
      (val) => !val || val.startsWith('https://t.me/'),
      'Ссылка должна начинаться с https://t.me/',
    )
    .nullable()
    .optional(),
  notes: z.string().nullable().optional(),
})

export const addTeamMemberSchema = z.object({
  userId: z.string().uuid(),
})

export type TeamMemberDto = z.infer<typeof teamMemberSchema>
export type TeamDto = z.infer<typeof teamSchema>
export type CreateTeamDto = z.infer<typeof createTeamSchema>

export type UpdateTeamDto = z.infer<typeof updateTeamSchema>
export type AddTeamMemberDto = z.infer<typeof addTeamMemberSchema>
