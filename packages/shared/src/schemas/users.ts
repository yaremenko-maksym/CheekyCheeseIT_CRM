import { z } from 'zod'
import type { Role } from '../types/roles'
import { currencyEnumSchema, paymentMethodSchema } from './payment-requisites'
import { tabKeySchema, actionKeySchema } from './view-permissions'

export const roleSchema = z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])

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
  /** Google / dicebear fallback URL — renamed from `avatar` in migration 0013. */
  avatarUrl: z.string().url().nullable(),
  /** FK → documents.id for AVATAR uploads; nullable when user uses Google fallback. */
  avatarDocumentId: z.string().uuid().nullable(),
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
  /**
   * DROP-only: percentage the drop keeps off the project income (0-100).
   * Default 5. Nullable for non-DROP roles (column is nullable in DB).
   */
  dropSharePercent: z.number().int().min(0).max(100).nullable(),
  /**
   * Legal full name (Cyrillic, order: Surname First Patronymic).
   * Set by ADMIN at user creation / edit. Used in MSA contract interpolation
   * instead of displayName. Nullable (not set for users created before this field).
   */
  legalFullName: z.string().nullable().optional(),
  monthlySalary: z.string().nullable(),
  salaryCurrency: currencyEnumSchema.default('USD'),
  archivedAt: z.coerce.date().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.coerce.date(),
})

export const updateProfileSchema = z.object({
  displayName: z.string().min(2).max(255).optional(),
  telegram: telegramSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  techStack: techStackSchema.nullable().optional(),
  /**
   * FK → documents.id for AVATAR-category uploads. Service validates that the
   * referenced document exists with `category = 'AVATAR'` and the caller owns it
   * (or is ADMIN). Passing `null` clears the custom avatar and reverts to the
   * Google fallback (`avatar_url`).
   */
  avatarDocumentId: z.string().uuid().nullable().optional(),
})

/**
 * Validators for payment requisites at user creation. Kept as exported
 * fragments so the same regexes/messages are reused in the Edit dialog
 * and the dedicated requisites tab.
 */
const usdtWalletField = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'USDT ERC-20 адрес должен начинаться с 0x и содержать 42 символа')
const bankUahRecipientField = z.string().min(3, 'ФИО получателя минимум 3 символа').max(255)
const bankUahIbanField = z.string().regex(/^UA\d{27}$/, 'IBAN должен быть в формате UA + 27 цифр')
const bankUahRnokppField = z.string().regex(/^\d{10}$/, 'РНОКПП должен быть 10 цифр')

/**
 * Refines a create-user payload to require the requisite fields that match
 * the selected `paymentMethod`. Shared between `createUserSchema` and
 * `adminUpdateUserSchema` (when payment fields are edited).
 */
function refineRequisitePresence(
  data: {
    role?: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP' | undefined
    paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP' | undefined
    walletUsdtErc20?: string | null | undefined
    bankUahRecipient?: string | null | undefined
    bankUahIban?: string | null | undefined
    bankUahRnokpp?: string | null | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (!data.paymentMethod) return
  // DROP is NOT USDT-only (spec §8.3) — both USDT ERC-20 and Bank UAH FOP are allowed.
  const isUsdtOnlyRole = data.role === 'SENIOR' || data.role === 'ADMIN'
  if (isUsdtOnlyRole && data.paymentMethod !== 'USDT_ERC20') {
    ctx.addIssue({
      code: 'custom',
      message: 'Senior/Admin могут использовать только USDT ERC-20',
      path: ['paymentMethod'],
    })
  }
  if (data.paymentMethod === 'USDT_ERC20' && !data.walletUsdtErc20) {
    ctx.addIssue({ code: 'custom', message: 'USDT кошелёк обязателен', path: ['walletUsdtErc20'] })
  }
  if (data.paymentMethod === 'BANK_UAH_FOP') {
    if (!data.bankUahRecipient)
      ctx.addIssue({ code: 'custom', message: 'ФИО обязательно', path: ['bankUahRecipient'] })
    if (!data.bankUahIban)
      ctx.addIssue({ code: 'custom', message: 'IBAN обязателен', path: ['bankUahIban'] })
    if (!data.bankUahRnokpp)
      ctx.addIssue({ code: 'custom', message: 'РНОКПП обязателен', path: ['bankUahRnokpp'] })
  }
}

/**
 * Team-creation mode for SENIOR creation. Default `CREATE_NEW` preserves
 * the legacy behavior (auto-create senior-team). `JOIN_DROP_TEAM` skips
 * the auto-team and instead attaches the new senior to an existing drop-team
 * via `TeamsService.addSeniorToDropTeam`. Drop role - phase 1.
 */
export const teamModeSchema = z.enum(['CREATE_NEW', 'JOIN_DROP_TEAM'])
export type TeamMode = z.infer<typeof teamModeSchema>

/**
 * Roles that require a legal full name at user creation time.
 * These are the roles that get an MSA contract via the wizard (A3-3).
 * ADMIN is excluded — ADMIN cannot be created via the wizard at all
 * (blocked by CREATE_ALLOWED_ROLES on the frontend + backend guard).
 */
const CONTRACT_ROLES = new Set<string>(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT', 'DROP'])

export const createUserSchema = z
  .object({
    email: z.string().email('Некорректный email'),
    displayName: z.string().min(2).max(255),
    role: roleSchema,
    telegram: telegramSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    techStack: techStackSchema.nullable().optional(),
    seniorSharePercent: z.number().int().min(0).max(100).optional(),
    monthlySalary: z.number().nonnegative().nullable().optional(),
    salaryCurrency: currencyEnumSchema.optional(),
    hrIds: z.array(z.string().uuid()).optional(),
    accountantId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    paymentMethod: paymentMethodSchema,
    walletUsdtErc20: usdtWalletField.optional(),
    walletUsdtLabel: z.string().nullable().optional(),
    bankUahRecipient: bankUahRecipientField.optional(),
    bankUahIban: bankUahIbanField.optional(),
    bankUahRnokpp: bankUahRnokppField.optional(),
    bankUahBankName: z.string().nullable().optional(),
    /**
     * Legal full name (Cyrillic, order: Surname First Patronymic).
     * REQUIRED at creation for contract-eligible roles (SENIOR/HR/JUNIOR/ACCOUNTANT/DROP)
     * via superRefine below (A3-3 / A2c). When set, used in MSA contract
     * interpolation instead of displayName.
     */
    legalFullName: z.string().min(5, 'ФИО минимум 5 символов').max(200).optional(),
    /**
     * Senior-only: select between creating a fresh senior-team (default
     * `CREATE_NEW`) and joining an existing drop-team (`JOIN_DROP_TEAM`).
     * Ignored for other roles. Old clients omit the field and stay on the
     * legacy `CREATE_NEW` path.
     */
    teamMode: teamModeSchema.optional(),
    /**
     * Required when `teamMode === 'JOIN_DROP_TEAM'`. The drop-team must be
     * `type='DROP'`, active and have no active senior — backend validates.
     */
    dropTeamId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    refineRequisitePresence(data, ctx)

    // A3-3 / A2c: legalFullName required for contract-eligible roles.
    if (CONTRACT_ROLES.has(data.role) && !data.legalFullName?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'ФИО обязательно для контракта',
        path: ['legalFullName'],
      })
    }

    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (data.role !== 'SENIOR') {
        ctx.addIssue({
          code: 'custom',
          message: 'teamMode=JOIN_DROP_TEAM доступен только при создании SENIOR',
          path: ['teamMode'],
        })
      }
      if (!data.dropTeamId) {
        ctx.addIssue({
          code: 'custom',
          message: 'dropTeamId обязателен при teamMode=JOIN_DROP_TEAM',
          path: ['dropTeamId'],
        })
      }
    }
  })

/**
 * Create-drop payload. Mirrors `createUserSchema` for SENIOR but adds the
 * `dropSharePercent` (default 5) and locks the role to DROP. The team
 * section (`hrIds` + `accountantId` + `telegramChannel`) is mandatory —
 * drops are always paired with their drop-team at creation time
 * (spec §5.1). HR is required (≥1) per owner decision.
 */
export const createDropSchema = z
  .object({
    email: z.string().email('Некорректный email'),
    displayName: z.string().min(2).max(255),
    telegram: telegramSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    techStack: techStackSchema.nullable().optional(),
    /** Default 5%; range 0-100. */
    dropSharePercent: z.number().int().min(0).max(100).optional(),
    // Payment requisites — DROP can choose USDT or Bank UAH (spec §8.3).
    paymentMethod: paymentMethodSchema,
    walletUsdtErc20: usdtWalletField.optional(),
    walletUsdtLabel: z.string().nullable().optional(),
    bankUahRecipient: bankUahRecipientField.optional(),
    bankUahIban: bankUahIbanField.optional(),
    bankUahRnokpp: bankUahRnokppField.optional(),
    bankUahBankName: z.string().nullable().optional(),
    // Team section — identical shape to senior-team creation.
    hrIds: z.array(z.string().uuid()).min(1, 'HR обязателен (минимум 1)'),
    accountantId: z.string().uuid(),
    /**
     * Telegram channel of the drop-team (`teams.telegram_channel`).
     * Identical regex to user-level telegram for consistency.
     */
    telegramChannel: z
      .string()
      .regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Telegram: 5–32 символа, латиница/цифры/_')
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    refineRequisitePresence({ ...data, role: 'DROP' as const }, ctx)
  })

/**
 * Rejoin-team payload for a teamless SENIOR. Either creates a fresh
 * senior-team (`CREATE_NEW`, requires no extra args — server pulls
 * existing HR pool, similar to admin Edit dialog) or attaches the senior
 * to an existing drop-team (`JOIN_DROP_TEAM`, requires `dropTeamId`).
 */
export const rejoinTeamSchema = z
  .object({
    teamMode: teamModeSchema,
    dropTeamId: z.string().uuid().optional(),
    hrIds: z.array(z.string().uuid()).optional(),
    accountantId: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.teamMode === 'JOIN_DROP_TEAM' && !data.dropTeamId) {
      ctx.addIssue({
        code: 'custom',
        message: 'dropTeamId обязателен при teamMode=JOIN_DROP_TEAM',
        path: ['dropTeamId'],
      })
    }
    if (data.teamMode === 'CREATE_NEW' && (!data.hrIds || data.hrIds.length < 1)) {
      ctx.addIssue({
        code: 'custom',
        message: 'HR обязателен (минимум 1) при teamMode=CREATE_NEW',
        path: ['hrIds'],
      })
    }
  })

export const adminUpdateUserSchema = z
  .object({
    email: z.string().email('Некорректный email').optional(),
    displayName: z.string().min(2).max(255).optional(),
    role: roleSchema.optional(),
    telegram: telegramSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    /**
     * ADMIN may set a custom avatar for any user. Service validates the FK
     * points to a document with `category = 'AVATAR'`.
     */
    avatarDocumentId: z.string().uuid().nullable().optional(),
    techStack: techStackSchema.nullable().optional(),
    seniorSharePercent: z.number().int().min(0).max(100).optional(),
    /**
     * DROP-only override on edit. Service ignores for non-DROP targets.
     */
    dropSharePercent: z.number().int().min(0).max(100).optional(),
    monthlySalary: z.number().nonnegative().nullable().optional(),
    salaryCurrency: currencyEnumSchema.optional(),
    // Payment requisites — optional in admin update; when paymentMethod is set,
    // matching fields must also be provided (validated via superRefine).
    paymentMethod: paymentMethodSchema.optional(),
    walletUsdtErc20: usdtWalletField.nullable().optional(),
    walletUsdtLabel: z.string().nullable().optional(),
    bankUahRecipient: bankUahRecipientField.nullable().optional(),
    bankUahIban: bankUahIbanField.nullable().optional(),
    bankUahRnokpp: bankUahRnokppField.nullable().optional(),
    bankUahBankName: z.string().nullable().optional(),
    // For SENIOR: optional team composition update. Diffs against current team_members
    // (only entries with leftAt IS NULL) and reconciles via add/remove.
    hrIds: z.array(z.string().uuid()).optional(),
    accountantId: z.string().uuid().nullable().optional(),
    // For SENIOR: optional Telegram channel handle stored on the senior's team
    // (`teams.telegram_channel`). Backend rejects this field for non-SENIOR with
    // 400 — UI hides it for other roles. Pair-invariant: SENIOR ≡ team.
    teamTelegramChannel: z
      .string()
      .regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Некорректный канал (5–32 латинских символов или _, опц. @)')
      .nullable()
      .optional(),
    /**
     * Legal full name (Cyrillic, order: Surname First Patronymic). Optional in
     * admin update — set when ADMIN knows the legal name. When set, used in MSA
     * contract interpolation instead of displayName.
     */
    legalFullName: z.string().min(5, 'ФИО минимум 5 символов').max(200).optional(),
  })
  .superRefine(refineRequisitePresence)

// Query params for list endpoints — `?archived=true|false`.
export const listArchivedQuerySchema = z.object({
  archived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? false : v === true || v === 'true')),
})

export type ListArchivedQuery = z.infer<typeof listArchivedQuerySchema>

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
export type CreateDropDto = z.infer<typeof createDropSchema>
export type RejoinTeamDto = z.infer<typeof rejoinTeamSchema>

/**
 * Returns whether a given field should be displayed for a user with the given role.
 * Used in both frontend rendering and backend field-filtering to enforce per-role rules.
 */
export function shouldShowField(role: Role, field: 'salary' | 'share' | 'techStack'): boolean {
  switch (field) {
    case 'salary':
      // JUNIOR, HR, ACCOUNTANT have a fixed monthly salary; SENIOR/ADMIN/DROP use share-based income
      return role === 'JUNIOR' || role === 'HR' || role === 'ACCOUNTANT'
    case 'share':
      // SENIOR, ADMIN and DROP see their share percentage; others don't have one
      return role === 'SENIOR' || role === 'ADMIN' || role === 'DROP'
    case 'techStack':
      // All roles surface a tech stack — soft-skills for HR/ACCOUNTANT, dev stack for others
      return true
    default:
      return false
  }
}
