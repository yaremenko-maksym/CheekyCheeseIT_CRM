import { z } from 'zod'

export const paymentMethodSchema = z.enum(['USDT_ERC20', 'BANK_UAH_FOP'])

export const usdtRequisitesSchema = z.object({
  paymentMethod: z.literal('USDT_ERC20'),
  walletUsdtErc20: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'USDT ERC-20 адрес должен начинаться с 0x и содержать 42 символа'),
  walletUsdtLabel: z.string().max(100).nullable().optional(),
})

export const bankUahRequisitesSchema = z.object({
  paymentMethod: z.literal('BANK_UAH_FOP'),
  bankUahRecipient: z.string().min(3, 'ФИО получателя минимум 3 символа').max(255),
  bankUahIban: z.string().regex(/^UA\d{27}$/, 'IBAN должен быть в формате UA + 27 цифр (29 символов)'),
  bankUahRnokpp: z.string().regex(/^\d{10}$/, 'РНОКПП должен быть 10 цифр'),
  bankUahBankName: z.string().max(255).nullable().optional(),
})

export const paymentRequisitesSchema = z.discriminatedUnion('paymentMethod', [
  usdtRequisitesSchema,
  bankUahRequisitesSchema,
])

export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type UsdtRequisites = z.infer<typeof usdtRequisitesSchema>
export type BankUahRequisites = z.infer<typeof bankUahRequisitesSchema>
export type PaymentRequisites = z.infer<typeof paymentRequisitesSchema>
