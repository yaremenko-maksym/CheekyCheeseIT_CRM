import { describe, expect, it } from 'vitest'
import {
  updateProfileSchema,
  adminUpdateUserSchema,
  createUserSchema,
  createDropSchema,
} from './users'

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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
  })

  it('fails when SENIOR has blank legalFullName', () => {
    const result = createUserSchema.safeParse({ ...seniorBase, legalFullName: '   ' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('legalFullName')
    }
  })

  it('legalFullName issue path is exactly ["legalFullName"]', () => {
    const result = createUserSchema.safeParse(seniorBase)
    expect(result.success).toBe(false)
    if (!result.success) {
      const legalIssue = result.error.issues.find((i) => i.path[0] === 'legalFullName')
      expect(legalIssue).toBeDefined()
      expect(legalIssue?.path).toEqual(['legalFullName'])
    }
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
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('hrIds')
    }
  })

  it('rejects a non-UUID accountantId when supplied', () => {
    const result = createDropSchema.safeParse({ ...dropBase, accountantId: 'not-a-uuid' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'))
      expect(paths).toContain('accountantId')
    }
  })
})
