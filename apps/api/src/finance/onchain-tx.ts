import { eq } from 'drizzle-orm'

import type { DrizzleTx } from '../database/types'
import { consumedTxHashes } from '../database/schema'

/**
 * task-onchain-payment-integrity — shared on-chain settlement primitives.
 *
 * Single source of truth for the two rules every USDT money path must obey:
 *
 *   1. SENDER IDENTITY — an on-chain transfer only settles an obligation when
 *      it was sent BY the person claiming it (`addressesMatch`). Before this,
 *      only the RECIPIENT was checked, so any third party's transfer into the
 *      company wallet could be claimed as "my payment".
 *   2. SINGLE CONSUMPTION — a real on-chain transfer settles AT MOST ONE thing
 *      across the WHOLE system (`consumeTxHash` + `consumed_tx_hashes`), not
 *      one thing per table.
 *
 * Kept in a tiny standalone module (rather than inside either service) because
 * both `transactions.service` (payouts) and `company-account.service` (deposits)
 * must use the IDENTICAL rules — a divergence between them is exactly the class
 * of bug this task fixes.
 */

// ── Hash shape / normalisation ───────────────────────────────────────────────

/** A real Ethereum transaction hash: `0x` + 64 hex chars. */
const REAL_TX_HASH_RE = /^0x[0-9a-f]{64}$/i

/**
 * Normalise a submitted tx hash for the consumed-hash registry.
 *
 * Returns the lowercase hash when it is a REAL on-chain hash shape, else `null`.
 *
 * `null` means "not an on-chain transfer — nothing to consume":
 *   • `0xSIM…`    — dev-simulate marker (`payPayoutRequest`, dev only),
 *   • `0xMANUAL…` — off-chain manual-confirmation marker (`manualConfirmPayout`
 *                   with CASH / ADMIN_USDT and no real hash).
 * Both are random-by-construction audit placeholders that reference NO chain
 * transfer, so registering them would only add noise (and, worse, could collide
 * a legitimate future hash if the prefix scheme ever changed).
 *
 * Case-insensitivity matters: Etherscan links carry EIP-55-ish mixed case, and
 * `0xAB…` / `0xab…` are the SAME transfer — without normalisation the registry
 * could be bypassed by flipping a single character's case.
 */
export function normalizeOnChainTxHash(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!REAL_TX_HASH_RE.test(trimmed)) return null
  return trimmed.toLowerCase()
}

// ── Address comparison ───────────────────────────────────────────────────────

/**
 * Case-insensitive Ethereum address comparison, fail-closed on missing input.
 *
 * Returns FALSE when either side is null/empty — an unknown address never
 * "matches". This is what makes an unconfigured payer wallet reject rather than
 * silently pass (the whole point of the sender check).
 */
export function addressesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim().toLowerCase() ?? ''
  const right = b?.trim().toLowerCase() ?? ''
  if (!left || !right) return false
  return left === right
}

// ── Consumed-hash registry ───────────────────────────────────────────────────

/** Money path that consumed a hash. Mirrors `consumed_tx_hashes.purpose`. */
export type ConsumedTxPurpose = 'PAYOUT' | 'COMPANY_DEPOSIT'

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
