import { z } from 'zod'
import { itDomainSchema } from './projects'

export const interviewStageSchema = z.enum([
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
])

export const interviewSchema = z.object({
  id: z.string().uuid(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  hrId: z.string().uuid().nullable(),
  hrName: z.string().nullable(),
  companyName: z.string(),
  vacancyUrl: z.string().nullable(),
  callUrl: z.string().nullable(),
  stage: interviewStageSchema,
  notesDomain: itDomainSchema.nullable(),
  notesTechStack: z.string().nullable(),
  notesTeamSize: z.string().nullable(),
  notesBenefits: z.string().nullable(),
  notesPaymentType: z.string().nullable(),
  notesSalaryReview: z.string().nullable(),
  notesCorpTech: z.string().nullable(),
  notesGeneral: z.string().nullable(),
  position: z.number(),
  createdProjectId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const createInterviewSchema = z.object({
  seniorId: z.string().uuid(),
  companyName: z.string().min(1).max(255),
  vacancyUrl: z.string().url().nullable().optional(),
  callUrl: z.string().url().nullable().optional(),
})

export const updateInterviewSchema = z.object({
  companyName: z.string().min(1).max(255).optional(),
  vacancyUrl: z.string().url().nullable().optional(),
  callUrl: z.string().url().nullable().optional(),
  stage: interviewStageSchema.optional(),
  notesDomain: itDomainSchema.nullable().optional(),
  notesTechStack: z.string().max(500).nullable().optional(),
  notesTeamSize: z.string().max(100).nullable().optional(),
  notesBenefits: z.string().max(500).nullable().optional(),
  notesPaymentType: z.string().max(100).nullable().optional(),
  notesSalaryReview: z.string().max(255).nullable().optional(),
  notesCorpTech: z.string().max(255).nullable().optional(),
  notesGeneral: z.string().max(1000).nullable().optional(),
})

export const moveInterviewSchema = z.object({
  stage: interviewStageSchema,
  position: z.number().int().min(0),
})

export type InterviewStage = z.infer<typeof interviewStageSchema>
export type InterviewDto = z.infer<typeof interviewSchema>
export type CreateInterviewDto = z.infer<typeof createInterviewSchema>
export type UpdateInterviewDto = z.infer<typeof updateInterviewSchema>
export type MoveInterviewDto = z.infer<typeof moveInterviewSchema>
