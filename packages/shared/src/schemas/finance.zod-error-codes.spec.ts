/**
 * task-i18n-stage4-task4 (mutation-gate closure). A handful of `finance.ts`
 * schemas — soft-delete/restore reasons, the on-chain release flow, and the
 * company-account (USDT) schemas — had NO test coverage anywhere before this
 * task, so migrating their `message:` literals to `'zod.<CODE>'` keys left
 * every one of them a `StringLiteral '' ` mutant away from silently emitting
 * an empty message. Each block below pins the exact code AND, where the
 * field is a regex/length boundary, at least one case per anchor/quantifier.
 */
import { describe, expect, it } from 'vitest'
import {
  createCompanyDepositSchema,
  deleteTransactionSchema,
  manualConfirmPayoutSchema,
  releaseOnChainHashSchema,
  restoreTransactionSchema,
  updateRequisitesSchema,
  updateWalletSchema,
  COMPANY_REQUISITES_MAX,
} from './finance'

const VALID_TX_HASH = `0x${'a'.repeat(64)}`
const VALID_ETH_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

describe('deleteTransactionSchema.reason — code and boundary', () => {
  it('rejects below the 3-char minimum with the exact code', () => {
    const result = deleteTransactionSchema.safeParse({ reason: 'ab' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.REASON_REQUIRED_DELETE')
  })

  it('accepts exactly the 3-char boundary', () => {
    expect(deleteTransactionSchema.safeParse({ reason: 'abc' }).success).toBe(true)
  })

  // mutation-gate closure: `.min(3, CODE)` alone does not observe `.trim()` —
  // a 3-char value that is only 3 chars BEFORE trimming (2 real chars + 1
  // leading space) crosses the min boundary in OPPOSITE directions with and
  // without the trim, which a bare short-string case cannot distinguish.
  it('rejects a value that is 3 chars only before trimming (pins .trim() running before .min)', () => {
    const result = deleteTransactionSchema.safeParse({ reason: ' ab' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.REASON_REQUIRED_DELETE')
  })
})

describe('restoreTransactionSchema.reason — code and boundary', () => {
  it('rejects below the 3-char minimum with the exact code', () => {
    const result = restoreTransactionSchema.safeParse({ reason: 'ab' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.REASON_REQUIRED_RESTORE')
  })

  it('accepts exactly the 3-char boundary', () => {
    expect(restoreTransactionSchema.safeParse({ reason: 'abc' }).success).toBe(true)
  })

  it('rejects a value that is 3 chars only before trimming (pins .trim() running before .min)', () => {
    const result = restoreTransactionSchema.safeParse({ reason: ' ab' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.REASON_REQUIRED_RESTORE')
  })
})

describe('releaseOnChainHashSchema — txHash format and reason codes', () => {
  it('rejects a txHash with no real on-chain hash, with the exact code', () => {
    const result = releaseOnChainHashSchema.safeParse({ txHash: 'not-a-hash', reason: 'typo fix' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'txHash')
    expect(issue?.message).toBe('zod.TX_HASH_FORMAT')
  })

  it('accepts a bare valid hash', () => {
    expect(
      releaseOnChainHashSchema.safeParse({ txHash: VALID_TX_HASH, reason: 'typo fix' }).success,
    ).toBe(true)
  })

  it('reason: rejects below the 3-char minimum with the exact code', () => {
    const result = releaseOnChainHashSchema.safeParse({ txHash: VALID_TX_HASH, reason: 'ab' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'reason')
    expect(issue?.message).toBe('zod.REASON_REQUIRED_RELEASE')
  })

  it('reason: rejects a value that is 3 chars only before trimming (pins .trim() running before .min)', () => {
    const result = releaseOnChainHashSchema.safeParse({ txHash: VALID_TX_HASH, reason: ' ab' })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'reason')
    expect(issue?.message).toBe('zod.REASON_REQUIRED_RELEASE')
  })
})

describe('manualConfirmPayoutSchema.txHash — format-or-empty code', () => {
  it('rejects an invalid, non-empty txHash with the exact code', () => {
    const result = manualConfirmPayoutSchema.safeParse({
      method: 'ADMIN_USDT',
      txHash: 'not-a-hash',
    })
    expect(result.success).toBe(false)
    const issue = (result.error?.issues ?? []).find((i) => i.path[0] === 'txHash')
    expect(issue?.message).toBe('zod.TX_HASH_FORMAT_OR_EMPTY')
  })

  it('accepts an empty string (leave-empty is the whole point of this code)', () => {
    expect(manualConfirmPayoutSchema.safeParse({ method: 'ADMIN_USDT', txHash: '' }).success).toBe(
      true,
    )
  })

  it('accepts a valid hash', () => {
    expect(
      manualConfirmPayoutSchema.safeParse({ method: 'ADMIN_USDT', txHash: VALID_TX_HASH }).success,
    ).toBe(true)
  })
})

describe('updateWalletSchema.walletAddress — USDT address format, regex boundaries', () => {
  it('rejects an invalid address with the exact code', () => {
    const result = updateWalletSchema.safeParse({ walletAddress: 'not-a-wallet' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.USDT_ADDRESS_FORMAT')
  })

  it('accepts a valid address', () => {
    expect(updateWalletSchema.safeParse({ walletAddress: VALID_ETH_ADDRESS }).success).toBe(true)
  })

  it('rejects a prefix before 0x (pins the leading ^)', () => {
    expect(updateWalletSchema.safeParse({ walletAddress: `!${VALID_ETH_ADDRESS}` }).success).toBe(
      false,
    )
  })

  it('rejects a suffix after the 40 hex chars (pins the trailing $)', () => {
    expect(updateWalletSchema.safeParse({ walletAddress: `${VALID_ETH_ADDRESS}!` }).success).toBe(
      false,
    )
  })

  it('rejects a non-hex character among the 40 (pins the char class)', () => {
    expect(
      updateWalletSchema.safeParse({
        walletAddress: '0xg234567890abcdef1234567890abcdef12345678',
      }).success,
    ).toBe(false)
  })
})

describe('updateRequisitesSchema.requisitesMarkdown — length cap code and boundary', () => {
  it('rejects one character over the cap with the exact code', () => {
    const result = updateRequisitesSchema.safeParse({
      requisitesMarkdown: 'a'.repeat(COMPANY_REQUISITES_MAX + 1),
    })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.REQUISITES_TOO_LONG')
  })

  it('accepts exactly the cap', () => {
    expect(
      updateRequisitesSchema.safeParse({ requisitesMarkdown: 'a'.repeat(COMPANY_REQUISITES_MAX) })
        .success,
    ).toBe(true)
  })

  it('accepts an empty string (clears the section)', () => {
    expect(updateRequisitesSchema.safeParse({ requisitesMarkdown: '' }).success).toBe(true)
  })
})

describe('createCompanyDepositSchema.txHashOrLink — min-length code and boundary', () => {
  it('rejects below the 10-char minimum with the exact code', () => {
    const result = createCompanyDepositSchema.safeParse({ txHashOrLink: 'short' })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toBe('zod.TX_HASH_MIN_LENGTH')
  })

  it('accepts exactly the 10-char boundary', () => {
    expect(createCompanyDepositSchema.safeParse({ txHashOrLink: '0123456789' }).success).toBe(true)
  })
})
