import { describe, expect, it } from 'vitest'
import {
  updateProfileSchema,
  adminUpdateUserSchema,
  createUserSchema,
  createDropSchema,
  changePersonalEmailSchema,
} from './users'
import { MIN_SALARY_AMOUNT } from './money'

/**
 * Avatar storage now lives in the documents table; the profile schemas accept
 * a `avatarDocumentId` UUID FK and an `avatarUrl` (Google / dicebear fallback)
 * but no longer the legacy `avatarOverride` base64 column (dropped in 0013).
 *
 * Tests here pin the surface so a refactor can't silently bring back the
 * inline-base64 XSS surface this avatar field used to host before PHASE 6.
 */
describe('avatarDocumentId validation', () => {
  // Valid v4-style UUID (third group starts with 4, fourth with 8/9/a/b).
  const validUuid = '123e4567-e89b-42d3-a456-426614174000'

  it('accepts a valid UUID in updateProfileSchema', () => {
    expect(updateProfileSchema.safeParse({ avatarDocumentId: validUuid }).success).toBe(true)
  })

  it('accepts a valid UUID in adminUpdateUserSchema', () => {
    expect(adminUpdateUserSchema.safeParse({ avatarDocumentId: validUuid }).success).toBe(true)
  })

  it('accepts null (clears the custom avatar)', () => {
    expect(updateProfileSchema.safeParse({ avatarDocumentId: null }).success).toBe(true)
    expect(adminUpdateUserSchema.safeParse({ avatarDocumentId: null }).success).toBe(true)
  })

  it('rejects non-UUID strings (no more base64 / data: URLs)', () => {
    expect(
      updateProfileSchema.safeParse({ avatarDocumentId: 'data:image/png;base64,AAAA' }).success,
    ).toBe(false)
    expect(
      updateProfileSchema.safeParse({ avatarDocumentId: 'https://example.com/x.png' }).success,
    ).toBe(false)
    expect(updateProfileSchema.safeParse({ avatarDocumentId: 'not-a-uuid' }).success).toBe(false)
  })
})

// ─── A3-3: createUserSchema — legalFullName required for contract roles ───────

/**
 * CONTRACT_ROLES = SENIOR | HR | JUNIOR | ACCOUNTANT | DROP
 * legalFullName must be present and non-blank for these roles at creation.
 * ADMIN cannot be created (role not in CREATE_ALLOWED_ROLES — separate guard).
 */

/** Minimal valid payload for a SENIOR user (USDT required for SENIOR). */
const seniorBase = {
  email: 'senior@example.com',
  displayName: 'Иван Иванов',
  role: 'SENIOR' as const,
  paymentMethod: 'USDT_ERC20' as const,
  walletUsdtErc20: '0xAbCd1234567890aBcDeF1234567890AbCdEf1234',
  hrIds: ['123e4567-e89b-42d3-a456-426614174000'],
  seniorSharePercent: 26,
}

/** Minimal valid payload for a JUNIOR user (Bank UAH). */
const juniorBase = {
  email: 'junior@example.com',
  displayName: 'Петро Петренко',
  role: 'JUNIOR' as const,
  paymentMethod: 'BANK_UAH_FOP' as const,
  bankUahRecipient: 'Петренко Петро',
  bankUahIban: 'UA123456789012345678901234567',
  bankUahRnokpp: '1234567890',
}

describe('createUserSchema — legalFullName superRefine (A3-3 / A2c)', () => {
  it('fails when SENIOR has no legalFullName', () => {
    const result = createUserSchema.safeParse(seniorBase)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('fails when SENIOR has blank legalFullName', () => {
    const result = createUserSchema.safeParse({ ...seniorBase, legalFullName: '   ' })
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('passes when SENIOR has valid legalFullName', () => {
    const result = createUserSchema.safeParse({
      ...seniorBase,
      legalFullName: 'Іваненко Іван Іванович',
    })
    expect(result.success).toBe(true)
  })

  it('fails when JUNIOR has no legalFullName', () => {
    const result = createUserSchema.safeParse(juniorBase)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('fails when HR has no legalFullName', () => {
    const payload = {
      email: 'hr@example.com',
      displayName: 'Ганна Хріщ',
      role: 'HR' as const,
      paymentMethod: 'BANK_UAH_FOP' as const,
      bankUahRecipient: 'Хріщ Ганна',
      bankUahIban: 'UA123456789012345678901234567',
      bankUahRnokpp: '1234567890',
    }
    const result = createUserSchema.safeParse(payload)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('fails when ACCOUNTANT has no legalFullName', () => {
    const payload = {
      email: 'acc@example.com',
      displayName: 'Бухгалтер Один',
      role: 'ACCOUNTANT' as const,
      paymentMethod: 'BANK_UAH_FOP' as const,
      bankUahRecipient: 'Бухгалтер Один',
      bankUahIban: 'UA123456789012345678901234567',
      bankUahRnokpp: '1234567890',
    }
    const result = createUserSchema.safeParse(payload)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('fails when DROP has no legalFullName', () => {
    const payload = {
      email: 'drop@example.com',
      displayName: 'Дроп Один',
      role: 'DROP' as const,
      paymentMethod: 'BANK_UAH_FOP' as const,
      bankUahRecipient: 'Дроп Один',
      bankUahIban: 'UA123456789012345678901234567',
      bankUahRnokpp: '1234567890',
    }
    const result = createUserSchema.safeParse(payload)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('legalFullName issue path is exactly ["legalFullName"]', () => {
    const result = createUserSchema.safeParse(seniorBase)
    expect(result.success).toBe(false)
    const legalIssue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(legalIssue).toBeDefined()
    expect(legalIssue?.path).toEqual(['legalFullName'])
  })
})

// ─── Bug-fix: accountant is OPTIONAL for drop creation ───────────────────────

/**
 * Owner report: a workspace may have 0 accountants, which made drop creation
 * impossible because `accountantId` was a required UUID. The field is now
 * nullable/optional (same shape as `createTeamSchema`). HR stays required (≥1).
 */
describe('createDropSchema — accountant optional', () => {
  const validUuid = '123e4567-e89b-42d3-a456-426614174000'

  /** Minimal valid DROP payload (USDT requisites; no accountant). */
  const dropBase = {
    email: 'drop@example.com',
    displayName: 'Дроп Дропенко',
    paymentMethod: 'USDT_ERC20' as const,
    walletUsdtErc20: '0xAbCd1234567890aBcDeF1234567890AbCdEf1234',
    hrIds: [validUuid],
    // legalFullName is REQUIRED for DROP (contract-eligible role).
    legalFullName: 'Дропенко Дроп Дропович',
  }

  it('passes when accountantId is omitted', () => {
    expect(createDropSchema.safeParse(dropBase).success).toBe(true)
  })

  it('passes when accountantId is null', () => {
    expect(createDropSchema.safeParse({ ...dropBase, accountantId: null }).success).toBe(true)
  })

  it('passes when a valid accountantId UUID is supplied', () => {
    expect(createDropSchema.safeParse({ ...dropBase, accountantId: validUuid }).success).toBe(true)
  })

  it('still requires at least one HR (empty hrIds fails on the hrIds path)', () => {
    const result = createDropSchema.safeParse({ ...dropBase, hrIds: [] })
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('hrIds')
  })

  it('rejects a non-UUID accountantId when supplied', () => {
    const result = createDropSchema.safeParse({ ...dropBase, accountantId: 'not-a-uuid' })
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('accountantId')
  })
})

// ─── Bug-fix: legalFullName/registrationAddress persisted on drop creation ────

/**
 * Owner report (manual-QA on #387): the «Юридическое ФИО» field is required in
 * the DROP dialog, but createDropSchema never carried `legalFullName` /
 * `registrationAddress`, so the admin's input was silently dropped
 * (legal_full_name=null) and the MSA contract rendered with the display name.
 * Owner decision: keep the data (drop needs a contract) and keep ФИО required.
 */
describe('createDropSchema — legalFullName/registrationAddress persistence', () => {
  const validUuid = '123e4567-e89b-42d3-a456-426614174000'

  /** Valid DROP payload WITHOUT the contract fields — used to prove ФИО is required. */
  const dropNoContract = {
    email: 'drop@example.com',
    displayName: 'Дроп Дропенко',
    paymentMethod: 'USDT_ERC20' as const,
    walletUsdtErc20: '0xAbCd1234567890aBcDeF1234567890AbCdEf1234',
    hrIds: [validUuid],
  }

  it('fails when legalFullName is missing (required for contract)', () => {
    const result = createDropSchema.safeParse(dropNoContract)
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('fails when legalFullName is blank/whitespace', () => {
    const result = createDropSchema.safeParse({ ...dropNoContract, legalFullName: '   ' })
    expect(result.success).toBe(false)
    const paths = (result.error?.issues ?? []).map((i) => i.path.join('.'))
    expect(paths).toContain('legalFullName')
  })

  it('passes with a valid legalFullName', () => {
    const result = createDropSchema.safeParse({
      ...dropNoContract,
      legalFullName: 'Дропенко Дроп Дропович',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an optional registrationAddress alongside legalFullName', () => {
    const result = createDropSchema.safeParse({
      ...dropNoContract,
      legalFullName: 'Дропенко Дроп Дропович',
      registrationAddress: 'м. Київ, вул. Хрещатик, 1',
    })
    expect(result.success).toBe(true)
    expect(result.data?.registrationAddress).toBe('м. Київ, вул. Хрещатик, 1')
    expect(result.data?.legalFullName).toBe('Дропенко Дроп Дропович')
  })

  it('registrationAddress stays optional (payload valid without it)', () => {
    const result = createDropSchema.safeParse({
      ...dropNoContract,
      legalFullName: 'Дропенко Дроп Дропович',
    })
    expect(result.success).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// task-money-floor-and-lying-comments (security-review MED-1) —
// `monthlySalary` (`users.monthly_salary`, `numeric(10,2)`) is the OTHER
// operand of `createMonthlySalaries`' `juniorSalaryOverride ??
// user.monthlySalary` — the SAME "obligation recorded as zero" bug the task
// fixed on `finance.ts`'s `juniorSalaryOverride` was still reachable through
// THIS field via createUserSchema / adminUpdateUserSchema. See `./money`'s
// module comment for the full write-path map.
// ─────────────────────────────────────────────────────────────────────────────

const juniorWithLegalName = { ...juniorBase, legalFullName: 'Петренко Петро Петрович' }

describe('createUserSchema.monthlySalary — floor (security-review MED-1)', () => {
  it('rejects an amount below the smallest storable unit (0.001 would round to 0.00)', () => {
    const result = createUserSchema.safeParse({ ...juniorWithLegalName, monthlySalary: 0.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.SALARY_AMOUNT_TOO_SMALL')
  })

  it('accepts exactly the smallest storable amount (one cent)', () => {
    expect(
      createUserSchema.safeParse({ ...juniorWithLegalName, monthlySalary: MIN_SALARY_AMOUNT })
        .success,
    ).toBe(true)
  })

  it('rejects more decimals than the column keeps', () => {
    const result = createUserSchema.safeParse({ ...juniorWithLegalName, monthlySalary: 1.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.SALARY_AMOUNT_TOO_MANY_DECIMALS')
  })

  it('still accepts 0 — a deliberate "no salary yet" value, and null/omitted', () => {
    expect(createUserSchema.safeParse({ ...juniorWithLegalName, monthlySalary: 0 }).success).toBe(
      true,
    )
    expect(
      createUserSchema.safeParse({ ...juniorWithLegalName, monthlySalary: null }).success,
    ).toBe(true)
    expect(createUserSchema.safeParse(juniorWithLegalName).success).toBe(true)
  })
})

// ─── §4.4: personalEmail must differ from the work email ──────────────────────

describe('createUserSchema — personalEmail must differ from work email (§4.4)', () => {
  it('rejects when personalEmail is byte-identical to email', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'ivan@example.com',
      personalEmail: 'ivan@example.com',
    })
    expect(result.success).toBe(false)
    const issue = !result.success ? result.error.issues[0] : undefined
    expect(issue?.path).toEqual(['personalEmail'])
    expect(issue?.message).toBe('zod.PERSONAL_EMAIL_MUST_DIFFER')
    expect(issue?.code).toBe('custom')
  })

  it('rejects when the two addresses differ only by case', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'ivan@example.com',
      personalEmail: 'IVAN@EXAMPLE.COM',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a genuinely different personal email', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'ivan@example.com',
      personalEmail: 'ivan.personal@gmail.com',
    })
    expect(result.success).toBe(true)
  })

  it('accepts an omitted personalEmail (the common case — most users have none)', () => {
    expect(
      createUserSchema.safeParse({ ...juniorWithLegalName, email: 'ivan@example.com' }).success,
    ).toBe(true)
  })

  it('rejects an invalid personalEmail shape with the standard email message', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'ivan@example.com',
      personalEmail: 'not-an-email',
    })
    expect(result.success).toBe(false)
    const issue = !result.success
      ? result.error.issues.find((i) => i.path[0] === 'personalEmail')
      : undefined
    expect(issue?.message).toBe('zod.EMAIL_INVALID')
  })
})

// security-review PR #623 (SR-M-1): `.max(255)` caps `email` / `personalEmail`
// at the `varchar(255)` column bound — `.email()` alone accepts arbitrarily
// long strings. Pins BOTH the boundary itself and the Russian message text
// (a mutation-gate run on this file found the message string on both calls
// unasserted — StringLiteral survivors on schemas/users.ts:174/185 — while
// every OTHER mutant on this same line, including the 255 boundary itself,
// was already killed by unrelated tests that merely happen to exercise a
// valid-length email).
describe('createUserSchema — email / personalEmail length cap (security-review PR #623, SR-M-1)', () => {
  const DOMAIN = '@x.co' // 5 chars
  const email256 = `${'a'.repeat(256 - DOMAIN.length)}${DOMAIN}` // 256 chars total — one over the cap
  const email255 = email256.slice(1) // 255 chars — exactly at the cap

  it('rejects an email one character over the 255 cap, with the field-specific message', () => {
    expect(email256).toHaveLength(256)
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: email256,
    })
    expect(result.success).toBe(false)
    const issue = !result.success
      ? result.error.issues.find((i) => i.path[0] === 'email')
      : undefined
    expect(issue?.message).toBe('zod.EMAIL_TOO_LONG')
  })

  it('accepts an email exactly at the 255 cap', () => {
    expect(email255).toHaveLength(255)
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: email255,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a personalEmail one character over the 255 cap, with the field-specific message', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'ivan@example.com',
      personalEmail: email256,
    })
    expect(result.success).toBe(false)
    const issue = !result.success
      ? result.error.issues.find((i) => i.path[0] === 'personalEmail')
      : undefined
    expect(issue?.message).toBe('zod.EMAIL_TOO_LONG')
  })

  // mutation-gate closure (PR #623): `.email('zod.EMAIL_INVALID')` on the
  // WORK `email` field had no test asserting its message text — the
  // personalEmail test above (line ~369) only covers the message on THAT
  // field. StringLiteral survivor on schemas/users.ts:174.
  it('rejects an invalid work email shape with the standard email message', () => {
    const result = createUserSchema.safeParse({
      ...juniorWithLegalName,
      email: 'not-an-email',
    })
    expect(result.success).toBe(false)
    const issue = !result.success
      ? result.error.issues.find((i) => i.path[0] === 'email')
      : undefined
    expect(issue?.message).toBe('zod.EMAIL_INVALID')
  })
})

describe('adminUpdateUserSchema.monthlySalary — floor (security-review MED-1)', () => {
  it('rejects an amount below the smallest storable unit', () => {
    const result = adminUpdateUserSchema.safeParse({ monthlySalary: 0.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.SALARY_AMOUNT_TOO_SMALL')
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(adminUpdateUserSchema.safeParse({ monthlySalary: MIN_SALARY_AMOUNT }).success).toBe(true)
  })

  it('still accepts 0 and omitted (unchanged behaviour)', () => {
    expect(adminUpdateUserSchema.safeParse({ monthlySalary: 0 }).success).toBe(true)
    expect(adminUpdateUserSchema.safeParse({}).success).toBe(true)
  })
})

// security-review PR #623 round 4, owner decision — mutation gate (`--changed`)
// caught this with ZERO prior coverage: an `ObjectLiteral` mutant emptying
// the whole schema to `z.object({})` survived every existing test, because
// nothing anywhere had ever parsed a single payload through it.
describe('changePersonalEmailSchema (security-review PR #623 round 4, owner decision)', () => {
  it('accepts a valid email', () => {
    const result = changePersonalEmailSchema.safeParse({ personalEmail: 'ivan.personal@gmail.com' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.personalEmail).toBe('ivan.personal@gmail.com')
  })

  it('accepts null (removal)', () => {
    const result = changePersonalEmailSchema.safeParse({ personalEmail: null })
    expect(result.success).toBe(true)
    expect(result.success && result.data.personalEmail).toBeNull()
  })

  it('requires the field — omitting it fails (unlike createUserSchema.personalEmail, this is not .optional())', () => {
    expect(changePersonalEmailSchema.safeParse({}).success).toBe(false)
  })

  it('rejects an invalid email shape with the exact message', () => {
    const result = changePersonalEmailSchema.safeParse({ personalEmail: 'not-an-email' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.EMAIL_INVALID')
  })

  it("rejects an email over the 255-char cap with the exact message (mirrors createUserSchema.personalEmail's bound)", () => {
    const email256 = `${'a'.repeat(247)}@example.com` // 260 chars, well over 255
    const result = changePersonalEmailSchema.safeParse({ personalEmail: email256 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.EMAIL_TOO_LONG')
  })

  it('accepts exactly 255 characters (boundary — kills an off-by-one on the cap)', () => {
    // 'a'.repeat(243) + '@example.com' (12 chars) = 255 exactly.
    const email255 = `${'a'.repeat(243)}@example.com`
    expect(email255).toHaveLength(255)
    expect(changePersonalEmailSchema.safeParse({ personalEmail: email255 }).success).toBe(true)
  })
})

// task-i18n-stage4-task4 (mutation-gate closure): every describe block above
// pins `.success`/`.path`, never the exact `zod.<CODE>` message — a
// StringLiteral mutant on any of these fields' code (→ `''`) is invisible to
// a bare success/failure check, and a Regex mutant (dropped anchor / negated
// char class) on `telegramSchema` is equally invisible without a boundary
// case per anchor. Each block below closes exactly one such gap.

describe('telegramSchema — format code and regex boundaries (task-i18n-stage4-task4)', () => {
  const VALID_TELEGRAM = 'valid_handle'

  it('rejects a too-short handle with the exact code', () => {
    const result = createDropSchema.safeParse({
      ...{
        email: 'drop@example.com',
        displayName: 'Дроп Один',
        role: 'DROP' as const,
        paymentMethod: 'BANK_UAH_FOP' as const,
        bankUahRecipient: 'Дроп Один',
        bankUahIban: 'UA123456789012345678901234567',
        bankUahRnokpp: '1234567890',
        legalFullName: 'Дропенко Дроп Дропович',
      },
      telegram: 'abcd', // 4 chars — below the 5-char minimum
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'telegram')
    expect(issue?.message).toBe('zod.TELEGRAM_FORMAT')
  })

  // legalFullName included in EVERY payload below — seniorBase/juniorBase
  // alone fail the SEPARATE LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT superRefine
  // check (SENIOR and JUNIOR are both CONTRACT_ROLES), which otherwise masks
  // `.success` regardless of the field actually under test here — confirmed
  // by hand: `seniorBase.telegram` alone with an anchor-defeating mutant
  // applied to `telegramSchema` still reports `.success === false` for the
  // WRONG reason, letting the mutant survive silently.
  const LEGAL_NAME = 'Іваненко Іван Іванович'

  it('rejects a value with anything BEFORE the optional @ (pins the leading ^)', () => {
    // '!' is outside [a-zA-Z0-9_] — unlike a plain letter, it cannot itself
    // satisfy the pattern, so this only fails via the anchor being present.
    expect(
      createUserSchema.safeParse({
        ...seniorBase,
        legalFullName: LEGAL_NAME,
        telegram: `!${VALID_TELEGRAM}`,
      }).success,
    ).toBe(false)
  })

  it('rejects a value with anything AFTER the 32-char body (pins the trailing $)', () => {
    expect(
      createUserSchema.safeParse({
        ...seniorBase,
        legalFullName: LEGAL_NAME,
        telegram: `${VALID_TELEGRAM}!`,
      }).success,
    ).toBe(false)
  })

  it('accepts exactly the 5-char lower boundary', () => {
    expect(
      createUserSchema.safeParse({
        ...seniorBase,
        legalFullName: LEGAL_NAME,
        telegram: 'abcde',
      }).success,
    ).toBe(true)
  })
})

describe('createUserSchema — payment requisites field codes (usdtWalletField/bankUah* — task-i18n-stage4-task4)', () => {
  const LEGAL_NAME = 'Іваненко Іван Іванович'

  it('walletUsdtErc20: rejects an invalid address with the exact code', () => {
    const result = createUserSchema.safeParse({
      ...seniorBase,
      legalFullName: LEGAL_NAME,
      walletUsdtErc20: 'not-a-wallet',
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'walletUsdtErc20')
    expect(issue?.message).toBe('zod.USDT_ADDRESS_FORMAT')
  })

  it('walletUsdtErc20: rejects a prefix before 0x (pins the leading ^)', () => {
    expect(
      createUserSchema.safeParse({
        ...seniorBase,
        legalFullName: LEGAL_NAME,
        walletUsdtErc20: `!${seniorBase.walletUsdtErc20}`,
      }).success,
    ).toBe(false)
  })

  it('walletUsdtErc20: rejects a suffix after the 40 hex chars (pins the trailing $)', () => {
    expect(
      createUserSchema.safeParse({
        ...seniorBase,
        legalFullName: LEGAL_NAME,
        walletUsdtErc20: `${seniorBase.walletUsdtErc20}z`,
      }).success,
    ).toBe(false)
  })

  it('bankUahRecipient: rejects below the 3-char minimum with the exact code', () => {
    const result = createUserSchema.safeParse({
      ...juniorBase,
      legalFullName: LEGAL_NAME,
      bankUahRecipient: 'Пе',
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahRecipient')
    expect(issue?.message).toBe('zod.RECIPIENT_NAME_MIN')
  })

  it('bankUahIban: rejects with the exact code and pins the leading UA/trailing digit-count', () => {
    const result = createUserSchema.safeParse({
      ...juniorBase,
      legalFullName: LEGAL_NAME,
      bankUahIban: 'NOT-AN-IBAN',
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahIban')
    expect(issue?.message).toBe('zod.IBAN_FORMAT')
    expect(
      createUserSchema.safeParse({
        ...juniorBase,
        legalFullName: LEGAL_NAME,
        bankUahIban: `${juniorBase.bankUahIban}9`,
      }).success,
    ).toBe(false)
    expect(
      createUserSchema.safeParse({
        ...juniorBase,
        legalFullName: LEGAL_NAME,
        bankUahIban: `!${juniorBase.bankUahIban}`,
      }).success,
    ).toBe(false)
  })

  it('bankUahRnokpp: rejects with the exact code and pins the digit count', () => {
    const result = createUserSchema.safeParse({
      ...juniorBase,
      legalFullName: LEGAL_NAME,
      bankUahRnokpp: '12345',
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahRnokpp')
    expect(issue?.message).toBe('zod.RNOKPP_FORMAT')
    expect(
      createUserSchema.safeParse({
        ...juniorBase,
        legalFullName: LEGAL_NAME,
        bankUahRnokpp: `${juniorBase.bankUahRnokpp}1`,
      }).success,
    ).toBe(false)
    expect(
      createUserSchema.safeParse({
        ...juniorBase,
        legalFullName: LEGAL_NAME,
        bankUahRnokpp: `!${juniorBase.bankUahRnokpp}`,
      }).success,
    ).toBe(false)
  })
})

describe('createUserSchema.legalFullName — min-length code (task-i18n-stage4-task4)', () => {
  it('rejects below the 5-char minimum with the exact code', () => {
    const result = createUserSchema.safeParse({ ...seniorBase, legalFullName: 'Іва' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(issue?.message).toBe('zod.LEGAL_FULL_NAME_MIN')
  })

  it('accepts exactly the 5-char boundary', () => {
    expect(createUserSchema.safeParse({ ...seniorBase, legalFullName: 'Іванн' }).success).toBe(true)
  })
})

describe('createUserSchema — superRefine issue codes (task-i18n-stage4-task4)', () => {
  it('LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT: exact message when a contract-eligible role has no legalFullName', () => {
    const result = createUserSchema.safeParse(seniorBase)
    expect(result.success).toBe(false)
    const legalIssue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(legalIssue?.message).toBe('zod.LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT')
  })
})

describe('createDropSchema — field codes and its own superRefine (task-i18n-stage4-task4)', () => {
  const dropWithLegalName = {
    email: 'drop@example.com',
    displayName: 'Дроп Один',
    paymentMethod: 'BANK_UAH_FOP' as const,
    bankUahRecipient: 'Дроп Один',
    bankUahIban: 'UA123456789012345678901234567',
    bankUahRnokpp: '1234567890',
    hrIds: ['123e4567-e89b-42d3-a456-426614174000'],
    legalFullName: 'Дропенко Дроп Дропович',
  }

  it('email: rejects an invalid shape with the exact code', () => {
    const result = createDropSchema.safeParse({ ...dropWithLegalName, email: 'not-an-email' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'email')
    expect(issue?.message).toBe('zod.EMAIL_INVALID')
  })

  it('legalFullName: rejects below the 5-char minimum with the exact code', () => {
    const result = createDropSchema.safeParse({ ...dropWithLegalName, legalFullName: 'Дро' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(issue?.message).toBe('zod.LEGAL_FULL_NAME_MIN')
  })

  it('hrIds: rejects an empty array with the exact code', () => {
    const result = createDropSchema.safeParse({ ...dropWithLegalName, hrIds: [] })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'hrIds')
    expect(issue?.message).toBe('zod.HR_REQUIRED_MIN')
  })

  it('telegramChannel: rejects a too-short handle with the exact code, pins both anchors', () => {
    const result = createDropSchema.safeParse({ ...dropWithLegalName, telegramChannel: 'abcd' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'telegramChannel')
    expect(issue?.message).toBe('zod.TELEGRAM_FORMAT')
    expect(
      createDropSchema.safeParse({ ...dropWithLegalName, telegramChannel: '!valid_handle' })
        .success,
    ).toBe(false)
    expect(
      createDropSchema.safeParse({ ...dropWithLegalName, telegramChannel: 'valid_handle!' })
        .success,
    ).toBe(false)
  })

  it('telegramChannel: accepts a valid handle with no leading @ (pins @? as truly optional)', () => {
    expect(
      createDropSchema.safeParse({ ...dropWithLegalName, telegramChannel: 'valid_handle' }).success,
    ).toBe(true)
  })

  it('telegramChannel: rejects a handle made only of non-word characters (pins the [a-zA-Z0-9_] char class)', () => {
    expect(
      createDropSchema.safeParse({ ...dropWithLegalName, telegramChannel: '!!!!!!' }).success,
    ).toBe(false)
  })

  it("superRefine: exact message when legalFullName is missing (this schema's own required-for-contract check)", () => {
    const { legalFullName: _legalFullName, ...withoutLegalName } = dropWithLegalName
    const result = createDropSchema.safeParse(withoutLegalName)
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(issue?.message).toBe('zod.LEGAL_FULL_NAME_REQUIRED_FOR_CONTRACT')
  })
})

describe('adminUpdateUserSchema — field codes (task-i18n-stage4-task4)', () => {
  it('email: rejects an invalid shape with the exact code', () => {
    const result = adminUpdateUserSchema.safeParse({ email: 'not-an-email' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'email')
    expect(issue?.message).toBe('zod.EMAIL_INVALID')
  })

  it('teamTelegramChannel: rejects a too-short handle with the exact code, pins both anchors', () => {
    const result = adminUpdateUserSchema.safeParse({ teamTelegramChannel: 'abcd' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'teamTelegramChannel')
    expect(issue?.message).toBe('zod.TELEGRAM_FORMAT')
    expect(adminUpdateUserSchema.safeParse({ teamTelegramChannel: '!valid_handle' }).success).toBe(
      false,
    )
    expect(adminUpdateUserSchema.safeParse({ teamTelegramChannel: 'valid_handle!' }).success).toBe(
      false,
    )
  })

  it('teamTelegramChannel: accepts a valid handle with no leading @ (pins @? as truly optional)', () => {
    expect(adminUpdateUserSchema.safeParse({ teamTelegramChannel: 'valid_handle' }).success).toBe(
      true,
    )
  })

  it('teamTelegramChannel: rejects a handle made only of non-word characters (pins the [a-zA-Z0-9_] char class)', () => {
    expect(adminUpdateUserSchema.safeParse({ teamTelegramChannel: '!!!!!!' }).success).toBe(false)
  })

  it('legalFullName: rejects below the 5-char minimum with the exact code', () => {
    const result = adminUpdateUserSchema.safeParse({ legalFullName: 'Іва' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'legalFullName')
    expect(issue?.message).toBe('zod.LEGAL_FULL_NAME_MIN')
  })

  // mutation-gate closure: `.max(200)` mutated to `.min(200)` is invisible to
  // a too-short case (both reject it) — only a NORMAL, well-under-200-char
  // valid name observes the difference (real: accepted; mutant: rejected,
  // since it would then require at least 200 characters).
  it('legalFullName: accepts an ordinary name well under the 200-char cap (pins .max, not .min)', () => {
    expect(
      adminUpdateUserSchema.safeParse({ legalFullName: 'Іваненко Іван Іванович' }).success,
    ).toBe(true)
  })
})

/**
 * fix-round 1 (PR #699, security-review bonus): `refineRequisitePresence`'s
 * five `ctx.addIssue` branches had zero direct test coverage — 27 mutants
 * survived undetected in `@crm/shared`'s mutation gate. One test per branch,
 * pinning the exact code (not just `success: false`).
 */
describe('adminUpdateUserSchema — refineRequisitePresence (security-review bonus)', () => {
  it('SENIOR with paymentMethod=BANK_UAH_FOP is rejected — zod.USDT_ONLY_FOR_SENIOR_ADMIN', () => {
    const result = adminUpdateUserSchema.safeParse({
      role: 'SENIOR',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahIban: 'UA' + '1'.repeat(27),
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'paymentMethod')
    expect(issue?.message).toBe('zod.USDT_ONLY_FOR_SENIOR_ADMIN')
  })

  it('ADMIN with paymentMethod=BANK_UAH_FOP is ALSO rejected — same code, second isUsdtOnlyRole branch', () => {
    const result = adminUpdateUserSchema.safeParse({
      role: 'ADMIN',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahIban: 'UA' + '1'.repeat(27),
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'paymentMethod')
    expect(issue?.message).toBe('zod.USDT_ONLY_FOR_SENIOR_ADMIN')
  })

  it('DROP with paymentMethod=BANK_UAH_FOP is ACCEPTED — pins the isUsdtOnlyRole exclusion (spec §8.3)', () => {
    const result = adminUpdateUserSchema.safeParse({
      role: 'DROP',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahIban: 'UA' + '1'.repeat(27),
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(true)
  })

  it('paymentMethod=USDT_ERC20 with no walletUsdtErc20 — zod.USDT_WALLET_REQUIRED', () => {
    const result = adminUpdateUserSchema.safeParse({ paymentMethod: 'USDT_ERC20' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'walletUsdtErc20')
    expect(issue?.message).toBe('zod.USDT_WALLET_REQUIRED')
  })

  it('paymentMethod=BANK_UAH_FOP with no bankUahRecipient — zod.RECIPIENT_NAME_REQUIRED', () => {
    const result = adminUpdateUserSchema.safeParse({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahIban: 'UA' + '1'.repeat(27),
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahRecipient')
    expect(issue?.message).toBe('zod.RECIPIENT_NAME_REQUIRED')
  })

  it('paymentMethod=BANK_UAH_FOP with no bankUahIban — zod.IBAN_REQUIRED', () => {
    const result = adminUpdateUserSchema.safeParse({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahIban')
    expect(issue?.message).toBe('zod.IBAN_REQUIRED')
  })

  it('paymentMethod=BANK_UAH_FOP with no bankUahRnokpp — zod.RNOKPP_REQUIRED', () => {
    const result = adminUpdateUserSchema.safeParse({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahIban: 'UA' + '1'.repeat(27),
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'bankUahRnokpp')
    expect(issue?.message).toBe('zod.RNOKPP_REQUIRED')
  })

  it('paymentMethod omitted entirely — refine is a no-op, nothing required', () => {
    expect(adminUpdateUserSchema.safeParse({}).success).toBe(true)
  })

  it('BANK_UAH_FOP with all three requisite fields present — accepted, no issues', () => {
    const result = adminUpdateUserSchema.safeParse({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Recipient Name',
      bankUahIban: 'UA' + '1'.repeat(27),
      bankUahRnokpp: '1'.repeat(10),
    })
    expect(result.success).toBe(true)
  })
})
