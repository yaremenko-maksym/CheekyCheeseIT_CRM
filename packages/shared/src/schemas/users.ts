import { z } from 'zod'
import type { Role } from '../types/roles'
import { currencyEnumSchema, paymentMethodSchema } from './payment-requisites'
import { tabKeySchema, actionKeySchema } from './view-permissions'
import { withSalaryFloor } from './money'
import { pendingSeniorShareSchema } from './finance'

export const roleSchema = z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])

/**
 * Roles eligible to receive a SALARY transaction.
 * ADMIN is excluded — admin income flows through shares (ADMIN_INCOME / PAYOUT).
 * Single source of truth shared by backend (createSalary allow-list) and
 * frontend (salaryTargets filter in CreateTransactionDialog).
 *
 * task-salary-no-admin-receiver (security-MED #222) review finding MED#1.
 */
export const SALARY_ELIGIBLE_ROLES = [
  'JUNIOR',
  'HR',
  'ACCOUNTANT',
  'SENIOR',
  'DROP',
] as const satisfies ReadonlyArray<z.infer<typeof roleSchema>>

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
   * task-pending-share (position 5, design spec §4.3). A proposed new value
   * for `seniorSharePercent` above, awaiting THIS person's own confirmation
   * — `null` when nothing is pending. Gated by the same `fields.share`
   * permission as `seniorSharePercent` itself (see `UsersService.
   * buildProfileView`). Always `.percent` non-null when present — the
   * column it targets is NOT NULL, so a base-share proposal never proposes
   * "clear".
   */
  pendingSeniorShare: pendingSeniorShareSchema.nullable().optional(),
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
  /**
   * Ukrainian registration address (ФОП). Used in contract template as {{registrationAddress}}.
   * Example: "м. Київ, вул. Хрещатик, 1".
   */
  registrationAddress: z.string().nullable().optional(),
  monthlySalary: z.string().nullable(),
  salaryCurrency: currencyEnumSchema.default('USD'),
  archivedAt: z.coerce.date().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.coerce.date(),
  /**
   * Personal address on file (§4.4). Set by ADMIN at creation, visible on
   * the profile. `null` when never set OR when masked from this viewer
   * (see `personalContactVisible` below — the two collapse to the SAME
   * `null` here; that ambiguity is intentional for this field specifically,
   * since a masked viewer must not learn "not set" vs "set but hidden"
   * either). Masked the same way as `email` (realContacts permission) —
   * never shown to a viewer without contact access. NOT a login method by
   * itself — see `user_emails.canLogin`.
   */
  personalEmail: z.string().email().nullable().optional(),
  /**
   * task-user-emails-invite (UX-M-1, design-gate audit PR #623): whether
   * `personalEmail`/`personalEmailCanLogin` came back `null` because this
   * viewer cannot see the field at all, or because it genuinely has no
   * value. A consumer MUST check this before treating either sibling
   * field's `null` as "not set" — see `UsersService.buildProfileView`'s
   * `personalContactVisible` for the full rationale. `.optional()` (not
   * `.default()`) deliberately — a `.default()` here makes the field
   * REQUIRED in the inferred `UserProfileDto` type, breaking every existing
   * fixture across the frontend that types itself as `UserProfileDto`
   * without it (found via `pnpm --filter @crm/web typecheck` — a wide,
   * mechanical blast radius for a field most fixtures have no reason to
   * care about). `undefined` is treated as falsy at every call site
   * (`user.personalContactVisible === true`, never `!== false`), so an
   * omitted field fails safe as "not visible" exactly like `.default(false)`
   * would have — without forcing every unrelated fixture to know this field
   * exists.
   */
  personalContactVisible: z.boolean().optional(),
  /**
   * task-user-emails-invite (spec §5): tri-state, gated by
   * `personalContactVisible` — `null` = no personal address on file, `false`
   * = address on file but the invite has not been accepted yet, `true` =
   * accepted, works as a login. `undefined`/omitted only for API responses
   * that predate this field (older cached data); treat the same as `null`.
   */
  personalEmailCanLogin: z.boolean().nullable().optional(),
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
    // security-review PR #623 (SR-M-1): `.max(255)` matches the `varchar(255)`
    // column both `users.email` and `user_emails.email` actually are —
    // `.email()` alone accepts arbitrarily long strings, and UsersService now
    // wraps the write in a transaction specifically so a value that slips
    // past validation and hits the column bound rolls back cleanly instead
    // of leaving a half-created user — but catching it here means the admin
    // sees a clear field error instead of a raw request failure at all.
    email: z.string().email('Некорректный email').max(255, 'Email не длиннее 255 символов'),
    /**
     * Personal address (§4.4) — optional, set by ADMIN at creation. `null`/
     * omitted = not set. Post-creation changes (typo fix, address rotation,
     * removal) go through the DEDICATED `changePersonalEmailSchema` /
     * `PATCH /users/:id/personal-email` below, not through
     * `adminUpdateUserSchema` — see that schema's own comment for why this
     * stays a separate endpoint rather than folding into the general
     * profile-edit surface (owner decision, security-review PR #623 round 4:
     * an admin must be able to fix a mistyped personal address FAST, and the
     * fix must immediately revoke login on the old address, not just add a
     * new one alongside it).
     */
    personalEmail: z
      .string()
      .email('Некорректный email')
      .max(255, 'Email не длиннее 255 символов')
      .nullable()
      .optional(),
    displayName: z.string().min(2).max(255),
    role: roleSchema,
    telegram: telegramSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
    techStack: techStackSchema.nullable().optional(),
    seniorSharePercent: z.number().int().min(0).max(100).optional(),
    // BIZ-14. task-money-floor-and-lying-comments (security-review MED-1):
    // this is the OTHER operand of `createMonthlySalaries`' `juniorSalaryOverride
    // ?? user.monthlySalary` — an unfloored value here reached the SAME direct
    // cron insert (bypassing createSalarySchema) as the now-fixed
    // `updateProjectFinanceSettingsSchema.juniorSalaryOverride` in `finance.ts`.
    // The floor rejects a value strictly BELOW one storable unit (numeric
    // (10,2)) — it does NOT make `0` unreachable: `.nonnegative()` accepts it
    // by design (a deliberate "no salary yet" value), and an explicit `0`
    // still reaches `paySalary` unchecked when `paidAmount` is omitted. See
    // `./money`'s module comment for the full write-path map and that gap.
    monthlySalary: withSalaryFloor(z.number().nonnegative().max(500_000)).nullable().optional(), // BIZ-14
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
    /** Ukrainian registration address (ФОП). Used in contract template as {{registrationAddress}}. */
    registrationAddress: z.string().max(500).nullable().optional(),
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

    // §4.4: a personal address identical to the work address is nonsensical
    // input (same DB unique index would reject it at insert time anyway,
    // but that surfaces as a raw 409 with no field pointer — catch it here
    // so the admin sees exactly which field is wrong). No `.trim()` here —
    // both fields are already `z.string().email()`, which rejects leading/
    // trailing whitespace on its own (verified empirically), so by the time
    // this line runs neither value can carry any to trim away.
    if (data.personalEmail && data.personalEmail.toLowerCase() === data.email.toLowerCase()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Личный email должен отличаться от рабочего',
        path: ['personalEmail'],
      })
    }

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
 * `dropSharePercent` (default 5) and locks the role to DROP. The drop is
 * always paired with its drop-team at creation time (spec §5.1). HR is
 * required (≥1) per owner decision; `accountantId` is OPTIONAL (nullable) —
 * an accountant may not exist yet (e.g. 0 accountants in the workspace) and
 * a drop-team is a valid state without one, identical to `createTeamSchema`.
 * `telegramChannel` is optional.
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
    /**
     * Legal full name (Cyrillic, order: Surname First Patronymic).
     * REQUIRED at DROP creation — the drop still gets an MSA contract (owner
     * decision) and the UI blocks submit without it. Enforced via the
     * superRefine below so the payload can never silently drop it (the exact
     * data-loss bug this schema field closes). Same validators as
     * `createUserSchema` for consistency.
     */
    legalFullName: z.string().min(5, 'ФИО минимум 5 символов').max(200).optional(),
    /**
     * Ukrainian registration address (ФОП). Used in the DROP contract template
     * as {{registrationAddress}}. Optional — matches the UI (no required
     * validator on the field). Persisted when provided so it is not lost.
     */
    registrationAddress: z.string().max(500).nullable().optional(),
    // Team section — identical shape to senior-team creation.
    hrIds: z.array(z.string().uuid()).min(1, 'HR обязателен (минимум 1)'),
    accountantId: z.string().uuid().nullable().optional(),
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

    // DROP is a contract-eligible role (CONTRACT_ROLES) — legalFullName is
    // mandatory at creation, mirroring `createUserSchema`. Without this the
    // ФИО typed by the admin was never persisted (legal_full_name=null) and
    // the MSA contract rendered with the platform display name instead.
    if (!data.legalFullName?.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'ФИО обязательно для контракта',
        path: ['legalFullName'],
      })
    }
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
    /**
     * Service persists it only when the effective role is SENIOR
     * (role-scoped write).
     */
    seniorSharePercent: z.number().int().min(0).max(100).optional(),
    /**
     * DROP-only override on edit. Service persists it only when the
     * effective role is DROP (role-scoped write).
     */
    dropSharePercent: z.number().int().min(0).max(100).optional(),
    // BIZ-14. task-money-floor-and-lying-comments (security-review MED-1) —
    // see the matching comment on createUserSchema.monthlySalary above.
    monthlySalary: withSalaryFloor(z.number().nonnegative().max(500_000)).nullable().optional(), // BIZ-14
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
    /**
     * Ukrainian registration address (ФОП). Used in contract template as {{registrationAddress}}.
     */
    registrationAddress: z.string().max(500).nullable().optional(),
  })
  .superRefine(refineRequisitePresence)

/**
 * Dedicated payload for `PATCH /users/:id/personal-email` — security-review
 * PR #623 round 4, owner decision: "туда будет всегда попадать валидная
 * почта. В случае чего, мы можем быстро изменить почту, что за собой
 * изменит и правила для входа и со старой указанной почты уже нельзя будет
 * войти". Kept OUT of `adminUpdateUserSchema` (not folded into the general
 * profile PATCH) so this single-purpose, security-sensitive write — it
 * revokes login on whatever address was there before, unconditionally —
 * has its own narrow endpoint, its own audit action
 * (`personal_email_changed`), and cannot be smuggled in as one field among
 * many in a large edit payload.
 *
 * `personalEmail: null` means "remove the personal address" (and revoke its
 * login, same as any other change — see `UsersService.changePersonalEmail`).
 * A non-null value means "set/replace it" — covers add (no PERSONAL row
 * yet), change (typo fix, address rotation) and re-invite-by-replacement
 * uniformly; the service treats all three as the same operation: delete
 * whatever PERSONAL row exists, insert the new one if provided.
 */
export const changePersonalEmailSchema = z.object({
  personalEmail: z
    .string()
    .email('Некорректный email')
    .max(255, 'Email не длиннее 255 символов')
    .nullable(),
})

export type ChangePersonalEmailDto = z.infer<typeof changePersonalEmailSchema>

// Query params for list endpoints — `?archived=true|false`.
export const listArchivedQuerySchema = z.object({
  archived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? false : v === true || v === 'true')),
})

export type ListArchivedQuery = z.infer<typeof listArchivedQuerySchema>

export const profileOverviewDataSchema = z.object({
  techStack: z.array(z.string()).nullable(),
  adminNote: z.string().nullable(),
  tosAcceptedAt: z.string().nullable(),
  tosVersion: z.number().nullable(),
})

export type ProfileOverviewData = z.infer<typeof profileOverviewDataSchema>

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
