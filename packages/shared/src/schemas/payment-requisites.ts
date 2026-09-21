import { z } from 'zod'

export const paymentMethodSchema = z.enum(['USDT_ERC20', 'BANK_UAH_FOP'])

export const currencyEnumSchema = z.enum(['USDT', 'USD', 'EUR', 'UAH'])

export const usdtRequisitesSchema = z.object({
  paymentMethod: z.literal('USDT_ERC20'),
  walletUsdtErc20: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'zod.USDT_ADDRESS_FORMAT'),
  walletUsdtLabel: z.string().max(100).nullable().optional(),
})

export const bankUahRequisitesSchema = z.object({
  paymentMethod: z.literal('BANK_UAH_FOP'),
  bankUahRecipient: z.string().min(3, 'zod.RECIPIENT_NAME_MIN').max(255),
  bankUahIban: z.string().regex(/^UA\d{27}$/, 'zod.IBAN_FORMAT'),
  bankUahRnokpp: z.string().regex(/^\d{10}$/, 'zod.RNOKPP_FORMAT'),
  bankUahBankName: z.string().max(255).nullable().optional(),
})

export const paymentRequisitesSchema = z.discriminatedUnion('paymentMethod', [
  usdtRequisitesSchema,
  bankUahRequisitesSchema,
])

export type PaymentMethod = z.infer<typeof paymentMethodSchema>
export type CurrencyEnum = z.infer<typeof currencyEnumSchema>
export type UsdtRequisites = z.infer<typeof usdtRequisitesSchema>
export type BankUahRequisites = z.infer<typeof bankUahRequisitesSchema>
export type PaymentRequisites = z.infer<typeof paymentRequisitesSchema>
