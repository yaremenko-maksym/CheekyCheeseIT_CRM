/**
 * task-money-floor-and-lying-comments (security-review follow-up to PR #485).
 *
 * PR #485 gave `paySalarySchema.paidAmount` a floor + precision rule
 * (`transactionAmountError`) but left every OTHER hand-entered `amount` field
 * in `finance.ts` on `.positive().max(MAX_TRANSACTION_AMOUNT)` alone — no
 * floor, no precision cap. `createSalary(amount: 1e-7)` validated fine and
 * landed in `numeric(18,6)` as `0.000000`: an obligation created for ZERO.
 *
 * Each `describe` below pins ONE fixed schema:
 *   - rejects a value below the column's smallest storable unit (the exact
 *     regression this task closes) — removing that schema's
 *     `withMoneyFloor(...)` call makes this test fail (AC4 — "снять пол у
 *     починенной схемы — тест обязан упасть", one test per modified schema,
 *     each scoped to only that field so a mutant dropping ONE call site is
 *     caught by exactly one test);
 *   - accepts the boundary minimum (so the fix is not overly strict).
 *
 * `createSalarySchema` additionally gets the literal AC2 case
 * (`createSalary(amount: 1e-7)`), and `createSeniorIncomeSchema` gets the AC3
 * pair: a legitimate server-computed share with a long float tail
 * (`income * 0.5`-style) is REJECTED raw (too many decimals) and PASSES once
 * rounded to the column's own scale first — proving the fix does not break
 * the path the task explicitly warns about ("натягивать хелпер вслепую
 * нельзя" — blind uniformity turns one defect into another).
 *
 * security-review (BLOCKER round): `moneyFloorAndPrecisionError`'s own
 * docstring PROMISES it "does not reject non-finite/non-positive values
 * itself" — that promise was previously untested, and a mutant dropping the
 * guard survived undetected: for `amount: 0`, the mutated helper added a
 * SECOND, misleading "слишком мала" issue alongside `.positive()`'s own
 * rejection (`.success` stayed `false` either way, so a plain
 * `.success===false` check could never see the difference). The
 * `moneyFloorAndPrecisionError` describe block below pins the function's
 * EXACT return value (not routed through a schema) for 0/negative/NaN/
 * Infinity — the only test shape that can catch a comparison/logical-operator
 * mutation on that guard regardless of which call site exercises it. A
 * handful of schema-level "amount: 0" checks follow as end-to-end wiring
 * confirmation, mirroring the reviewer's own reproduction.
 */
import { describe, expect, it } from 'vitest'
import { MIN_SALARY_AMOUNT, SALARY_AMOUNT_DECIMAL_PLACES } from './money'
import {
  AMOUNT_DECIMAL_PLACES,
  MIN_TRANSACTION_AMOUNT,
  adminUpdateTransactionSchema,
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createDividendSchema,
  createDropIncomeSchema,
  createExpenseSchema,
  createSalarySchema,
  createSeniorIncomeSchema,
  createUsdtIncomeSchema,
  moneyFloorAndPrecisionError,
  updateDropIncomeSchema,
  updateProjectFinanceSettingsSchema,
  updateSeniorIncomeSchema,
} from './finance'

const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const RECEIVER_ID = '33333333-3333-4333-8333-333333333333'
const ADMIN_ID = '44444444-4444-4444-8444-444444444444'
const IDEMPOTENCY_KEY = '55555555-5555-4555-8555-555555555555'
const HTTPS_RECEIPT = 'https://example.com/receipt.pdf'
const EXPLORER_RECEIPT = `https://etherscan.io/tx/0x${'a'.repeat(64)}`

// Below MIN_TRANSACTION_AMOUNT (1e-6) — the exact value from the PR #485 bug
// report, and the smallest column scale (18,6) still cannot store it without
// rounding to `0.000000`.
const TOO_SMALL = 1e-7
// More than AMOUNT_DECIMAL_PLACES (6) — the column silently rounds the tail.
const TOO_PRECISE = 1.1234567

// ── BLOCKER (security-review): pin `moneyFloorAndPrecisionError`'s EXACT
// return value for every branch, directly — not routed through a schema.
// This is the ONLY test shape that reliably catches a mutation on the guard
// clause regardless of which of the 11 call sites happens to exercise it:
// a schema-level `.success===false` check cannot tell "rejected for being
// too small" apart from "rejected for being non-positive, PLUS a spurious
// second message" — both parse-fail the same way.
describe('moneyFloorAndPrecisionError — pure function contract (BLOCKER round)', () => {
  it('returns null for exactly 0 — must NOT add a second "слишком мала" message alongside .positive()\'s own rejection', () => {
    expect(moneyFloorAndPrecisionError(0)).toBeNull()
  })

  it('returns null for a negative value — same reasoning as 0', () => {
    expect(moneyFloorAndPrecisionError(-1)).toBeNull()
    expect(moneyFloorAndPrecisionError(-0.0000001)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(moneyFloorAndPrecisionError(Number.NaN)).toBeNull()
  })

  it('returns null for +Infinity and -Infinity', () => {
    expect(moneyFloorAndPrecisionError(Number.POSITIVE_INFINITY)).toBeNull()
    expect(moneyFloorAndPrecisionError(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('returns the "too small" message for a positive value below MIN_TRANSACTION_AMOUNT', () => {
    expect(moneyFloorAndPrecisionError(TOO_SMALL)).toContain('слишком мала')
  })

  it('returns null exactly AT the floor boundary — MIN_TRANSACTION_AMOUNT itself is storable', () => {
    expect(moneyFloorAndPrecisionError(MIN_TRANSACTION_AMOUNT)).toBeNull()
  })

  it('returns the "too many decimals" message above AMOUNT_DECIMAL_PLACES digits', () => {
    expect(moneyFloorAndPrecisionError(TOO_PRECISE)).toContain('знаков после запятой')
  })

  it('returns null for exactly AMOUNT_DECIMAL_PLACES digits — the boundary is inclusive', () => {
    expect(moneyFloorAndPrecisionError(1.123456)).toBeNull()
  })

  it('returns null for an ordinary valid amount', () => {
    expect(moneyFloorAndPrecisionError(100.5)).toBeNull()
  })
})

describe('createAdminIncomeSchema.amount — floor (task-money-floor-and-lying-comments)', () => {
  const base = {
    projectId: PROJECT_ID,
    currency: 'USD' as const,
    receiptExternalUrl: HTTPS_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    const result = createAdminIncomeSchema.safeParse({ ...base, amount: TOO_SMALL })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
    // Pins the ISSUE SHAPE `withMoneyFloor` emits, not just its message — a
    // mutant that keeps the message but corrupts `code` (e.g. 'custom' → '')
    // is otherwise unobserved (Zod does not validate a custom issue's `code`
    // against anything, so `.success`/`.message` stay identical either way).
    const code = !result.success ? result.error.issues[0]?.code : undefined
    expect(code).toBe('custom')
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createAdminIncomeSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })
})

describe('createUsdtIncomeSchema.amount — floor', () => {
  const base = {
    projectId: PROJECT_ID,
    currency: 'USDT' as const,
    receiverId: ADMIN_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    receiptExternalUrl: EXPLORER_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    expect(createUsdtIncomeSchema.safeParse({ ...base, amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createUsdtIncomeSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })
})

describe('createSeniorIncomeSchema.amount — floor + the computed-path trap (AC3)', () => {
  const base = {
    projectId: PROJECT_ID,
    currency: 'USD' as const,
    receiptExternalUrl: HTTPS_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    const result = createSeniorIncomeSchema.safeParse({ ...base, amount: TOO_SMALL })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createSeniorIncomeSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })

  it('rejects more decimals than the column keeps (silent rounding, not an error)', () => {
    const result = createSeniorIncomeSchema.safeParse({ ...base, amount: TOO_PRECISE })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('знаков после запятой')
  })

  // AC3 — the SECOND half of the fix. Without it, a blind "reject anything
  // over 6 decimals" rule would break a legitimate computed share the moment
  // floating-point division produces a long tail — exactly the trap the task
  // calls out ("income * 0.5 дает 333.33333333333337").
  it('AC3: a raw computed share with a long float tail is rejected…', () => {
    const income = 1000
    const share = income * (1 / 3) // 333.3333333333333 — far more than 6 decimals
    expect(String(share).replace(/^\d+\./, '').length).toBeGreaterThan(AMOUNT_DECIMAL_PLACES)
    const result = createSeniorIncomeSchema.safeParse({ ...base, amount: share })
    expect(result.success).toBe(false)
  })

  it('…but the SAME computed share PASSES once rounded to the column scale first — the correct fix is "round on input", not "reject the computed path"', () => {
    const income = 1000
    const share = income * (1 / 3)
    const rounded = Math.round(share * 10 ** AMOUNT_DECIMAL_PLACES) / 10 ** AMOUNT_DECIMAL_PLACES
    const result = createSeniorIncomeSchema.safeParse({ ...base, amount: rounded })
    expect(result.success).toBe(true)
  })
})

describe('createDropIncomeSchema.amount — floor', () => {
  const base = {
    projectId: PROJECT_ID,
    currency: 'USD' as const,
    receiptExternalUrl: HTTPS_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    expect(createDropIncomeSchema.safeParse({ ...base, amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createDropIncomeSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })
})

describe('updateSeniorIncomeSchema.amount — floor (optional field, still floored when present)', () => {
  it('parses without amount at all (legacy — nothing to floor)', () => {
    expect(updateSeniorIncomeSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an amount below the smallest storable unit', () => {
    expect(updateSeniorIncomeSchema.safeParse({ amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(updateSeniorIncomeSchema.safeParse({ amount: MIN_TRANSACTION_AMOUNT }).success).toBe(
      true,
    )
  })
})

describe('updateDropIncomeSchema.amount — floor (optional field, still floored when present)', () => {
  it('parses without amount at all (legacy — nothing to floor)', () => {
    expect(updateDropIncomeSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an amount below the smallest storable unit', () => {
    expect(updateDropIncomeSchema.safeParse({ amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(updateDropIncomeSchema.safeParse({ amount: MIN_TRANSACTION_AMOUNT }).success).toBe(true)
  })
})

describe('createExpenseSchema.amount — floor', () => {
  const base = {
    currency: 'USD' as const,
    category: 'Office',
    receiptExternalUrl: HTTPS_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    expect(createExpenseSchema.safeParse({ ...base, amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(createExpenseSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success).toBe(
      true,
    )
  })
})

// ── AC2 — the headline case from the task file, verbatim ───────────────────
describe('createSalarySchema.amount — floor (AC2, the field flagged in the task)', () => {
  const base = { receiverId: RECEIVER_ID, salaryMonth: '2026-08' }

  it('createSalary(amount: 1e-7) is REJECTED, not written as an obligation for zero', () => {
    const result = createSalarySchema.safeParse({ ...base, amount: TOO_SMALL })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(createSalarySchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success).toBe(
      true,
    )
  })

  it('rejects more decimals than the column keeps', () => {
    const result = createSalarySchema.safeParse({ ...base, amount: TOO_PRECISE })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('знаков после запятой')
  })

  it('still enforces the pre-existing BIZ-13 ceiling (untouched by this fix)', () => {
    expect(createSalarySchema.safeParse({ ...base, amount: 500_001 }).success).toBe(false)
    expect(createSalarySchema.safeParse({ ...base, amount: 500_000 }).success).toBe(true)
  })
})

describe('createAdminTransferSchema.amount — floor', () => {
  const base = {
    receiverId: RECEIVER_ID,
    currency: 'USD' as const,
    receiptExternalUrl: HTTPS_RECEIPT,
  }

  it('rejects an amount below the smallest storable unit', () => {
    expect(createAdminTransferSchema.safeParse({ ...base, amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createAdminTransferSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })
})

describe('adminUpdateTransactionSchema.amount — floor (optional field)', () => {
  it('parses without amount at all', () => {
    expect(adminUpdateTransactionSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an amount below the smallest storable unit', () => {
    expect(adminUpdateTransactionSchema.safeParse({ amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(adminUpdateTransactionSchema.safeParse({ amount: MIN_TRANSACTION_AMOUNT }).success).toBe(
      true,
    )
  })
})

describe('createDividendSchema.amount — floor, but deliberately NO new ceiling', () => {
  const base = { idempotencyKey: IDEMPOTENCY_KEY, receiptExternalUrl: EXPLORER_RECEIPT }

  it('rejects an amount below the smallest storable unit', () => {
    expect(createDividendSchema.safeParse({ ...base, amount: TOO_SMALL }).success).toBe(false)
  })

  it('accepts exactly the smallest storable amount', () => {
    expect(
      createDividendSchema.safeParse({ ...base, amount: MIN_TRANSACTION_AMOUNT }).success,
    ).toBe(true)
  })

  // The floor fix must NOT smuggle in a ceiling this schema never had — "no
  // balance gate" is an explicit, unrelated business decision (see the
  // schema's own comment) that this task does not touch.
  it('still accepts a very large dividend — no ceiling was added by this fix', () => {
    expect(createDividendSchema.safeParse({ ...base, amount: 10_000_000 }).success).toBe(true)
  })
})

// ── juniorSalaryOverride — a DIFFERENT column scale (numeric(10,2), not
// (18,6)) — its own MIN/decimal-places constants, deliberately NOT reusing
// MIN_TRANSACTION_AMOUNT/AMOUNT_DECIMAL_PLACES (see the schema comment).
describe('updateProjectFinanceSettingsSchema.juniorSalaryOverride — floor at ITS OWN scale (10,2)', () => {
  it('rejects an amount below the smallest storable unit at scale 2 (0.001 would round to 0.00)', () => {
    const result = updateProjectFinanceSettingsSchema.safeParse({ juniorSalaryOverride: 0.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
    const code = !result.success ? result.error.issues[0]?.code : undefined
    expect(code).toBe('custom')
  })

  it('accepts exactly the smallest storable amount (one cent)', () => {
    expect(
      updateProjectFinanceSettingsSchema.safeParse({
        juniorSalaryOverride: MIN_SALARY_AMOUNT,
      }).success,
    ).toBe(true)
  })

  it('rejects more decimals than THIS column keeps (2, not 6)', () => {
    const result = updateProjectFinanceSettingsSchema.safeParse({ juniorSalaryOverride: 1.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain(`${SALARY_AMOUNT_DECIMAL_PLACES} знаков после запятой`)
  })

  // `0` stays a legitimate, existing override ("this project's junior earns
  // nothing") — the floor must not turn it into a rejection. Regression guard
  // against a careless "value <= 0 is always invalid" generalisation.
  it('still accepts an explicit 0 override — a deliberate business value, not a typo', () => {
    expect(updateProjectFinanceSettingsSchema.safeParse({ juniorSalaryOverride: 0 }).success).toBe(
      true,
    )
  })

  it('accepts a normal two-decimal amount well within scale', () => {
    expect(
      updateProjectFinanceSettingsSchema.safeParse({ juniorSalaryOverride: 1500.5 }).success,
    ).toBe(true)
  })

  it('parses without juniorSalaryOverride at all (nothing to floor)', () => {
    expect(updateProjectFinanceSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('parses an explicit null (clears the override)', () => {
    expect(
      updateProjectFinanceSettingsSchema.safeParse({ juniorSalaryOverride: null }).success,
    ).toBe(true)
  })
})

// ── BLOCKER (security-review) — end-to-end wiring confirmation. The pure-
// function block above proves `moneyFloorAndPrecisionError` itself is
// correct; these mirror the reviewer's OWN reproduction (schema-level
// `amount: 0`) to confirm `withMoneyFloor` actually wires it in without
// re-adding a message `.positive()` already owns.
describe('amount: 0 — schema-level wiring: only .positive()\'s own issue, never a duplicate "слишком мала"', () => {
  it('createAdminIncomeSchema', () => {
    const result = createAdminIncomeSchema.safeParse({
      projectId: PROJECT_ID,
      currency: 'USD' as const,
      receiptExternalUrl: HTTPS_RECEIPT,
      amount: 0,
    })
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })

  it('createSalarySchema (AC2 headline field)', () => {
    const result = createSalarySchema.safeParse({
      receiverId: RECEIVER_ID,
      salaryMonth: '2026-08',
      amount: 0,
    })
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })

  // The schema with NO `.max()` — the reviewer's own reproduction used this
  // exact field ("подмена на transactionAmountError роняет ровно тест про
  // дивиденд на 10M"); pinning amount:0 here too so the guard fix and the
  // no-ceiling guarantee are both covered on the same field.
  it('createDividendSchema', () => {
    const result = createDividendSchema.safeParse({
      idempotencyKey: IDEMPOTENCY_KEY,
      receiptExternalUrl: EXPLORER_RECEIPT,
      amount: 0,
    })
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })

  it('adminUpdateTransactionSchema (optional field, explicitly set to 0)', () => {
    const result = adminUpdateTransactionSchema.safeParse({ amount: 0 })
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })
})
