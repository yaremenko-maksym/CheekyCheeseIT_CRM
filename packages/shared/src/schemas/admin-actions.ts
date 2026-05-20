import { z } from 'zod'
import { roleSchema } from './users'
import { paymentRequisitesSchema } from './payment-requisites'

export const changeRoleSchema = z.object({
  role: roleSchema,
})

export const changeSalarySchema = z.object({
  monthlySalary: z.number().nonnegative().nullable().optional(),
  seniorSharePercent: z.number().int().min(0).max(100).optional(),
}).refine((d) => d.monthlySalary !== undefined || d.seniorSharePercent !== undefined, {
  message: 'Укажите хотя бы одно из полей: monthlySalary или seniorSharePercent',
})

export const changeRequisitesSchema = paymentRequisitesSchema

export const setNoteSchema = z.object({
  note: z.string().max(2000).nullable(),
})

export const teamMembershipSchema = z.object({
  teamId: z.string().uuid(),
  op: z.enum(['add', 'remove']),
})

export const projectReassignSchema = z.object({
  projectId: z.string().uuid(),
  action: z.enum(['add', 'remove']),
})

export type ChangeRoleDto = z.infer<typeof changeRoleSchema>
export type ChangeSalaryDto = z.infer<typeof changeSalarySchema>
export type ChangeRequisitesDto = z.infer<typeof changeRequisitesSchema>
export type SetNoteDto = z.infer<typeof setNoteSchema>
export type TeamMembershipDto = z.infer<typeof teamMembershipSchema>
export type ProjectReassignDto = z.infer<typeof projectReassignSchema>
