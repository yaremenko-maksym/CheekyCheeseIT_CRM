import { z } from 'zod'
import { paymentMethodSchema } from './payment-requisites'
import { tabKeySchema, actionKeySchema } from './view-permissions'

export const roleSchema = z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])

const telegramSchema = z
  .string()
  .regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Telegram: 5–32 символа, латиница/цифры/_')
  .max(33)

const phoneSchema = z.string().max(30)
const techStackSchema = z.array(z.string().min(1).max(50)).max(50)

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  avatar: z.string().url().nullable(),
  role: roleSchema,
  telegram: z.string().nullable(),
  phone: z.string().nullable(),
  techStack: z.array(z.string()).nullable(),
  paymentMethod: paymentMethodSchema.nullable(),
  walletUsdtErc20: z.string().nullable(),
  walletUsdtLabel: z.string().nullable(),
  bankUahRecipient: z.string().nullable(),
  bankUahIban: z.string().nullable(),
  bankUahRnokpp: z.string().nullable(),
  bankUahBankName: z.string().nullable(),
  seniorSharePercent: z.number().int().min(0).max(100),
  monthlySalary: z.string().nullable(),
  archivedAt: z.coerce.date().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.coerce.date(),
})

export const updateProfileSchema = z.object({
  displayName: z.string().min(2).max(255).optional(),
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  techStack: techStackSchema.nullable().optional(),
})

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(255),
  role: roleSchema,
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  techStack: techStackSchema.nullable().optional(),
  seniorSharePercent: z.number().int().min(0).max(100).optional(),
  monthlySalary: z.number().nonnegative().nullable().optional(),
  hrIds: z.array(z.string().uuid()).optional(),
  accountantId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  paymentMethod: paymentMethodSchema,
  walletUsdtErc20: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'USDT ERC-20 адрес должен начинаться с 0x и содержать 42 символа').optional(),
  walletUsdtLabel: z.string().nullable().optional(),
  bankUahRecipient: z.string().min(3, 'ФИО получателя минимум 3 символа').optional(),
  bankUahIban: z.string().regex(/^UA\d{27}$/, 'IBAN должен быть в формате UA + 27 цифр').optional(),
  bankUahRnokpp: z.string().regex(/^\d{10}$/, 'РНОКПП должен быть 10 цифр').optional(),
  bankUahBankName: z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  const isUsdtOnlyRole = data.role === 'SENIOR' || data.role === 'ADMIN'
  if (isUsdtOnlyRole && data.paymentMethod !== 'USDT_ERC20') {
    ctx.addIssue({ code: 'custom', message: 'Senior/Admin могут использовать только USDT ERC-20', path: ['paymentMethod'] })
  }
  if (data.paymentMethod === 'USDT_ERC20' && !data.walletUsdtErc20) {
    ctx.addIssue({ code: 'custom', message: 'USDT кошелёк обязателен', path: ['walletUsdtErc20'] })
  }
  if (data.paymentMethod === 'BANK_UAH_FOP') {
    if (!data.bankUahRecipient) ctx.addIssue({ code: 'custom', message: 'ФИО обязательно', path: ['bankUahRecipient'] })
    if (!data.bankUahIban) ctx.addIssue({ code: 'custom', message: 'IBAN обязателен', path: ['bankUahIban'] })
    if (!data.bankUahRnokpp) ctx.addIssue({ code: 'custom', message: 'РНОКПП обязателен', path: ['bankUahRnokpp'] })
  }
})

export const adminUpdateUserSchema = z.object({
  displayName: z.string().min(2).max(255).optional(),
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  avatar: z.string().url().nullable().optional(),
  techStack: techStackSchema.nullable().optional(),
})

export const userWithPermissionsResponseSchema = z.object({
  user: userProfileSchema,
  permissions: z.object({
    tabs: z.array(tabKeySchema),
    actions: z.array(actionKeySchema),
    fields: z.record(z.string(), z.boolean()),
  }),
  data: z.record(z.string(), z.unknown()),
})

export type UserProfileDto = z.infer<typeof userProfileSchema>
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>
export type CreateUserDto = z.infer<typeof createUserSchema>
export type AdminUpdateUserDto = z.infer<typeof adminUpdateUserSchema>
export type UserWithPermissionsResponse = z.infer<typeof userWithPermissionsResponseSchema>
