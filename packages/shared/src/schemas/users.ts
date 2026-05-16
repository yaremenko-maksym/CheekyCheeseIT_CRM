import { z } from 'zod'

export const roleSchema = z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])

const telegramSchema = z
  .string()
  .regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Telegram: 5–32 символів, лише латиниця, цифри та _')
  .max(33)

const phoneSchema = z.string().max(30)

const walletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Введіть коректний USDT ERC-20 адрес (0x...)')
  .nullable()

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  avatar: z.string().url().nullable(),
  role: roleSchema,
  telegram: z.string().nullable(),
  phone: z.string().nullable(),
  walletAddress: z.string().nullable(),
  // For SENIOR/ADMIN: percentage they keep from project income (0–100)
  seniorSharePercent: z.number().int().min(0).max(100),
  // For JUNIOR/HR/ACCOUNTANT: fixed monthly salary in USD
  monthlySalary: z.string().nullable(),
  techStack: z.string().max(100).nullable(),
  createdAt: z.coerce.date(),
})

export const updateProfileSchema = z.object({
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  walletAddress: walletAddressSchema.optional(),
})

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(255),
  role: roleSchema,
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  techStack: z.string().max(100).nullable().optional(),
  walletAddress: walletAddressSchema.optional(),
  // SENIOR/ADMIN: percentage they keep (default 26)
  seniorSharePercent: z.number().int().min(0).max(100).optional(),
  // JUNIOR/HR/ACCOUNTANT: monthly salary in USD
  monthlySalary: z.number().nonnegative().nullable().optional(),
  // SENIOR only: initial team members
  hrIds: z.array(z.string().uuid()).optional(),
  accountantId: z.string().uuid().nullable().optional(),
  // JUNIOR only: project to assign on creation
  projectId: z.string().uuid().nullable().optional(),
})

export const adminUpdateUserSchema = z.object({
  displayName: z.string().min(2).max(255).optional(),
  role: roleSchema.optional(),
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  techStack: z.string().max(100).nullable().optional(),
  walletAddress: walletAddressSchema.optional(),
  seniorSharePercent: z.number().int().min(0).max(100).optional(),
  monthlySalary: z.number().nonnegative().nullable().optional(),
})

export type UserProfileDto = z.infer<typeof userProfileSchema>
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>
export type CreateUserDto = z.infer<typeof createUserSchema>
export type AdminUpdateUserDto = z.infer<typeof adminUpdateUserSchema>
