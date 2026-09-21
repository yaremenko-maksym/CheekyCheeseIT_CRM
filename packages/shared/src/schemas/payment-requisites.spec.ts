import { describe, expect, it } from 'vitest'
import { paymentRequisitesSchema } from './payment-requisites'

describe('paymentRequisitesSchema', () => {
  it('accepts valid USDT requisites', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0x1234567890abcdef1234567890abcdef12345678',
      }).success,
    ).toBe(true)
  })

  it('rejects USDT with invalid wallet', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: 'not-a-wallet',
      }).success,
    ).toBe(false)
  })

  it('accepts valid Bank UAH requisites', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван Петренко',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '1234567890',
      }).success,
    ).toBe(true)
  })

  it('rejects Bank UAH with invalid IBAN', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван',
        bankUahIban: 'NOT-AN-IBAN',
        bankUahRnokpp: '1234567890',
      }).success,
    ).toBe(false)
  })

  it('rejects Bank UAH with invalid RNOKPP (not 10 digits)', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'BANK_UAH_FOP',
        bankUahRecipient: 'Іван',
        bankUahIban: 'UA213223130000026007233566001',
        bankUahRnokpp: '12345',
      }).success,
    ).toBe(false)
  })
})

// task-i18n-stage4-task4 (mutation-gate closure): the specs above only pin
// `.success`, never the message — a StringLiteral mutant on any of these
// fields' `'zod.<CODE>'` argument (→ `''`) survives every one of them, and a
// Regex mutant (dropped anchor / negated char class) is equally invisible to
// a bare success/failure check. Each block below pins the EXACT code AND at
// least one boundary case per anchor/quantifier the regex declares.
const VALID_USDT = '0x1234567890abcdef1234567890abcdef12345678'
const VALID_IBAN = 'UA213223130000026007233566001'
const VALID_RNOKPP = '1234567890'

describe('usdtRequisitesSchema.walletUsdtErc20 — format (task-i18n-stage4-task4)', () => {
  it('rejects an invalid address with the exact code', () => {
    const result = paymentRequisitesSchema.safeParse({
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: 'not-a-wallet',
    })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.USDT_ADDRESS_FORMAT')
  })

  it('rejects a value with anything BEFORE the 0x prefix (pins the leading ^)', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: `z${VALID_USDT}`,
      }).success,
    ).toBe(false)
  })

  it('rejects a value with anything AFTER the 40 hex chars (pins the trailing $)', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: `${VALID_USDT}z`,
      }).success,
    ).toBe(false)
  })

  it('rejects a non-hex character among the 40 (pins the [a-fA-F0-9] char class)', () => {
    expect(
      paymentRequisitesSchema.safeParse({
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: `0xg234567890abcdef1234567890abcdef12345678`,
      }).success,
    ).toBe(false)
  })
})

describe('bankUahRequisitesSchema — field codes and boundaries (task-i18n-stage4-task4)', () => {
  function parse(overrides: Record<string, unknown>) {
    return paymentRequisitesSchema.safeParse({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'Іван Петренко',
      bankUahIban: VALID_IBAN,
      bankUahRnokpp: VALID_RNOKPP,
      ...overrides,
    })
  }

  it('bankUahRecipient: rejects below the 3-char minimum with the exact code', () => {
    const result = parse({ bankUahRecipient: 'Ів' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.RECIPIENT_NAME_MIN')
  })

  it('bankUahRecipient: accepts exactly the 3-char boundary', () => {
    expect(parse({ bankUahRecipient: 'Іва' }).success).toBe(true)
  })

  it('bankUahIban: rejects with the exact code', () => {
    const result = parse({ bankUahIban: 'NOT-AN-IBAN' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.IBAN_FORMAT')
  })

  it('bankUahIban: rejects a prefix before UA (pins the leading ^)', () => {
    expect(parse({ bankUahIban: `Z${VALID_IBAN}` }).success).toBe(false)
  })

  it('bankUahIban: rejects a suffix after the 27 digits (pins the trailing $)', () => {
    expect(parse({ bankUahIban: `${VALID_IBAN}9` }).success).toBe(false)
  })

  it('bankUahIban: rejects one digit short of 27 (pins the {27} count)', () => {
    expect(parse({ bankUahIban: VALID_IBAN.slice(0, -1) }).success).toBe(false)
  })

  it('bankUahRnokpp: rejects with the exact code', () => {
    const result = parse({ bankUahRnokpp: '12345' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.RNOKPP_FORMAT')
  })

  it('bankUahRnokpp: rejects a prefix before the 10 digits (pins the leading ^)', () => {
    expect(parse({ bankUahRnokpp: `z${VALID_RNOKPP}` }).success).toBe(false)
  })

  it('bankUahRnokpp: rejects a suffix after the 10 digits (pins the trailing $)', () => {
    expect(parse({ bankUahRnokpp: `${VALID_RNOKPP}1` }).success).toBe(false)
  })

  it('bankUahRnokpp: rejects one digit short of 10 (pins the {10} count)', () => {
    expect(parse({ bankUahRnokpp: VALID_RNOKPP.slice(0, -1) }).success).toBe(false)
  })
})
