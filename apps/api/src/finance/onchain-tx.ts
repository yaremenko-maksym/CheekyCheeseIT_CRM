import { eq } from 'drizzle-orm'
import { extractOnChainTxHash } from '@crm/shared'

import type { DrizzleTx } from '../database/types'
import { consumedTxHashes } from '../database/schema'

/**
 * task-onchain-payment-integrity — shared on-chain settlement primitives.
 *
 * Single source of truth for the rules every USDT money path must obey:
 *
 *   1. EXACT AMOUNT — a transfer settles a declared obligation only when the
 *      on-chain amount equals it EXACTLY, compared as integer minor units
 *      (`usdtToMinorUnits`), never as floats and never within a percentage
 *      band. This is the barrier that makes "find any stranger's transfer of
 *      roughly the right size and claim it" impractical.
 *   2. SINGLE CONSUMPTION — a real on-chain transfer settles AT MOST ONE thing
 *      across the WHOLE system (`consumeTxHash` + `consumed_tx_hashes`), not
 *      one thing per table.
 *   3. RECORDED SENDER — the on-chain `from` is normalised and persisted
 *      (`normalizeEthAddress`) so an investigator can see who actually paid.
 *      It is NOT a gate: staff often withdraw straight from an exchange, whose
 *      hot wallet would be the sender (owner decision).
 *
 * Kept in a tiny standalone module (rather than inside either service) because
 * both `transactions.service` (payouts) and `company-account.service` (deposits)
 * must use the IDENTICAL rules — a divergence between them is exactly the class
 * of bug this task fixes.
 */

// ── Hash shape / normalisation ───────────────────────────────────────────────

/**
 * Normalise a submitted tx hash for the consumed-hash registry.
 *
 * Delegates to `extractOnChainTxHash` from `@crm/shared` — the SINGLE rule for
 * "what is a real on-chain hash", shared with the Zod write boundary and every
 * entry path (`payPayoutRequest`, `manualConfirmPayout`, `submitDeposit`,
 * `declareUsdtProjectIncome`).
 *
 * SECURITY (security-review PR #438, HIGH-1): this used to be an ANCHORED
 * `^0x[0-9a-f]{64}$` while `submitDeposit` extracted with a NON-anchored regex
 * and `manualConfirmPayout` did neither (`length >= 10`). A manual confirmation
 * pasted as an explorer LINK therefore credited the company account while this
 * function returned null → `consumeTxHash` silently skipped the claim → the
 * same transfer could be credited AGAIN as a deposit. Extracting here (rather
 * than only at the entry points) keeps the registry safe even if a future
 * caller forgets to normalise: no input format can produce a credit without a
 * claim.
 *
 * Still returns null — correctly — for the synthetic audit markers `0xSIM…` /
 * `0xMANUAL…`: their prefixes are not hex, so they contain no `0x`+64hex
 * substring. They reference no on-chain transfer, so there is nothing to
 * double-spend.
 *
 * Case-insensitivity matters: explorer links carry EIP-55 mixed case, and
 * `0xAB…` / `0xab…` are the SAME transfer — without normalisation the registry
 * could be bypassed by flipping a single character's case.
 */
export function normalizeOnChainTxHash(raw: string | null | undefined): string | null {
  return extractOnChainTxHash(raw)
}

// ── Address normalisation (for STORING the observed sender) ──────────────────

/** `0x` + 40 hex chars. */
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/i

/**
 * Normalise an Ethereum address for persistence: trimmed + lowercase, or null
 * when absent/malformed. Lowercasing keeps stored senders comparable across
 * sources (Etherscan returns EIP-55 mixed case; our RPC decoding lowercases).
 */
export function normalizeEthAddress(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!ETH_ADDRESS_RE.test(trimmed)) return null
  return trimmed.toLowerCase()
}

// ── USDT amounts — exact integer comparison ──────────────────────────────────

/** USDT has 6 decimals on Ethereum mainnet (mirrors EtherscanService). */
const USDT_DECIMALS = 6

/**
 * Convert a decimal USDT amount to EXACT integer minor units (10^-6 USDT).
 *
 * Parses the DECIMAL STRING directly — no `parseFloat`, no multiplication by
 * 1e6 — because binary floats cannot represent most decimal fractions: e.g.
 * `740.07 * 1e6 === 740069999.9999999`, which would make an exact comparison
 * spuriously fail (and rounding it back would quietly re-introduce a
 * tolerance). Accepts the `numeric(18,6)` strings Drizzle returns
 * ("740.000000"), plain integers ("740"), and a leading minus.
 *
 * Returns null when the input is not a plain decimal number or carries more
 * than 6 decimal places (un-representable in USDT — never silently truncate an
 * amount that decides whether money moves).
 */
/**
 * Parse an ALREADY-minor-units integer string (what
 * `DepositVerification.amountUsdtMinor` carries) into a bigint.
 *
 * Returns null for null/undefined/malformed input instead of letting `BigInt()`
 * throw: a verifier that returns garbage must produce a clean "amount does not
 * match" rejection (payout stays PENDING), never a 500 on the money path.
 */
export function minorUnitsFromString(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null
  const text = raw.trim()
  if (!/^-?\d+$/.test(text)) return null
  return BigInt(text)
}

export function usdtToMinorUnits(raw: string | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null
  const text = typeof raw === 'number' ? String(raw) : raw.trim()
  // A trailing dot with no digits ("740.") is malformed, not "740" — a decimal
  // point that decides money must be followed by digits (review LOW).
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null
  const sign = m[1] ?? ''
  const whole = m[2] ?? '0'
  const fraction = m[3] ?? ''
  if (fraction.length > USDT_DECIMALS) return null
  const padded = fraction.padEnd(USDT_DECIMALS, '0')
  const magnitude = BigInt(`${whole}${padded}`)
  return sign === '-' ? -magnitude : magnitude
}

// ── Consumed-hash registry ───────────────────────────────────────────────────

/**
 * Money path that consumed a hash. Mirrors `consumed_tx_hashes.purpose`.
 *
 * `ADMIN_INCOME` joined the set in the security-review fix round: it is the
 * THIRD term `computeCompanyAccountBalanceFromLedger` credits, so leaving it
 * out kept the "one transfer settles one thing" invariant non-global (the same
 * transfer could be declared as admin income AND settle a payout/deposit).
 */
export type ConsumedTxPurpose = 'PAYOUT' | 'COMPANY_DEPOSIT' | 'ADMIN_INCOME'

/** Uniform 400 message for a hash already spent by ANY path. */
export const TX_HASH_ALREADY_CONSUMED_MESSAGE =
  'Этот хеш транзакции уже использован (выплата или пополнение счёта компании)'

/**
 * Claim an on-chain hash for `purpose` — MUST be called INSIDE the same DB
 * transaction that performs the credit.
 *
 * Throws the raw Postgres unique violation (23505) when the hash was already
 * consumed by ANY path; callers translate it into a 400 via `isUniqueViolation`.
 * Letting the DB decide (rather than a preceding SELECT) is what makes two
 * concurrent requests with the same hash resolve to exactly one winner.
 *
 * No-ops for synthetic markers (`normalizeOnChainTxHash` → null): they are not
 * on-chain transfers, so there is nothing to double-spend.
 */
export async function consumeTxHash(
  dbtx: DrizzleTx,
  params: {
    txHash: string
    purpose: ConsumedTxPurpose
    referenceId: string | null
    consumedByUserId: string | null
  },
): Promise<void> {
  const normalized = normalizeOnChainTxHash(params.txHash)
  if (!normalized) return

  await dbtx.insert(consumedTxHashes).values({
    txHash: normalized,
    purpose: params.purpose,
    referenceId: params.referenceId,
    consumedByUserId: params.consumedByUserId,
  })
}

/**
 * Fast-fail read: is this hash already consumed by ANY path?
 *
 * UX-only pre-check (a clean error before any chain call / write). NOT
 * authoritative — the read can go stale before the write. `consumeTxHash`
 * inside the credit transaction is the authoritative guard.
 *
 * Accepts any drizzle handle (pooled `db` or a transaction).
 */
export async function findConsumedTxHash(
  db: Pick<DrizzleTx, 'query'>,
  txHash: string,
): Promise<{ purpose: string } | null> {
  const normalized = normalizeOnChainTxHash(txHash)
  if (!normalized) return null

  const row = await db.query.consumedTxHashes.findFirst({
    where: eq(consumedTxHashes.txHash, normalized),
    columns: { purpose: true },
  })
  return row ?? null
}
