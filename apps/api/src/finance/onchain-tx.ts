import { and, desc, eq, isNull, ne } from 'drizzle-orm'
import { extractOnChainTxHash } from '@crm/shared'

import type { DrizzleTx } from '../database/types'
import { consumedTxHashes } from '../database/schema'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'

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

/**
 * Outcome of a claim attempt.
 *
 * `reclaimedAfterRelease` is the audit signal from MED-J: this transfer had
 * been released by an ADMIN and is now being spent again. Legitimate by design
 * (that is what a release is FOR), but the pair of events is what an
 * investigation reconstructs, so crediting callers record it.
 */
export interface ConsumeTxHashResult {
  claimed: boolean
  reclaimedAfterRelease: boolean
}

/** Uniform 400 message for a hash already spent by ANY path. */
export const TX_HASH_ALREADY_CONSUMED_MESSAGE =
  'Этот хеш транзакции уже использован (выплата или пополнение счёта компании)'

/**
 * A settlement that may consume an on-chain transfer, discriminated by the
 * ledger path that writes it. One variant per crediting term in
 * `computeCompanyAccountBalanceFromLedger` — see `settlementConsumesTransfer`.
 */
export type OnChainSettlement =
  /** `CompanyAccountService.submitDeposit` / `getDepositStatus`. */
  | { kind: 'COMPANY_DEPOSIT'; credited: boolean }
  /** `TransactionsService.applyPayoutPaidCascade` (on-chain pay + manual confirm). */
  | { kind: 'PAYOUT'; hasRealTxHash: boolean }
  /** `createAdminIncome` / `declareUsdtProjectIncome`. */
  | { kind: 'ADMIN_INCOME'; fundingSource: string | null | undefined }

/**
 * THE rule for when a settlement must claim its on-chain hash.
 *
 * A claim means "this transfer is spent — no other path may settle against it".
 * The condition is NOT the same for the three paths, and pretending otherwise
 * is dangerous, so the discriminated union forces each call site to state which
 * path it is and hand over the fact that decides it:
 *
 *   • `COMPANY_DEPOSIT` — claims when the deposit is actually CREDITED. The
 *     balance term has NO `fundingSource` condition (deposits are the pool's
 *     own inflow), so a `fundingSource`-based rule would be false for every
 *     deposit. An unverified PENDING deposit claims nothing — otherwise anyone
 *     could burn a stranger's transfer off the public explorer (MED-3).
 *   • `PAYOUT` — claims whenever a REAL on-chain hash settled it, INCLUDING the
 *     manual ADMIN_USDT / CASH confirmations whose `fundingSource` is null and
 *     which therefore never touch the company balance. Deliberate: the transfer
 *     happened once and settled this payout, so it must not also be spendable
 *     as a deposit. Synthetic markers (`0xSIM…`/`0xMANUAL…`) carry no transfer
 *     and are filtered by `consumeTxHash` itself.
 *   • `ADMIN_INCOME` — claims only when the income lands in the company pool
 *     (`fundingSource='COMPANY_ACCOUNT'`, the exact balance predicate). A
 *     PERSONAL admin declaration references a transfer to that admin's OWN
 *     wallet, not to the company wallet — burning it would block that
 *     transfer's real payer for nothing.
 *
 * Security-review history: under-claiming here was HIGH-3 (`createAdminIncome`
 * credited the pool without claiming, so the transfer could be credited again
 * as a deposit); over-claiming is the mirror defect (griefing). The predicate
 * was briefly expressed as `claimsOnChainHash(fundingSource)` — accurate for
 * admin income, but read as a GLOBAL rule it would have returned false for
 * every deposit and silently re-opened the hole it had just closed. Hence the
 * per-path shape: a caller must NAME its path and hand over the fact that
 * decides it, so the deposit rule cannot be applied to an income BY ACCIDENT.
 * It is not a proof — a caller that names the wrong path still compiles; the
 * type removes the easy mistake, not deliberate misuse.
 */
export function settlementConsumesTransfer(settlement: OnChainSettlement): boolean {
  switch (settlement.kind) {
    case 'COMPANY_DEPOSIT':
      return settlement.credited
    case 'PAYOUT':
      return settlement.hasRealTxHash
    case 'ADMIN_INCOME':
      // LOW (round 6): the exported marker, not a third copy of the literal —
      // this predicate must mean exactly what the balance formula means.
      return settlement.fundingSource === COMPANY_ACCOUNT_FUNDING_SOURCE
  }
}

/**
 * Claim an on-chain hash for `purpose` — MUST be called INSIDE the same DB
 * transaction that performs the credit.
 *
 * Throws the raw Postgres unique violation (23505) when the hash was already
 * consumed by ANY path; callers translate it into a 400 via `isUniqueViolation`.
 * Letting the DB decide (rather than a preceding SELECT) is what makes two
 * concurrent requests with the same hash resolve to exactly one winner.
 *
 * Returns `true` when a claim row was written, `false` when the input carried
 * no on-chain hash (synthetic `0xSIM…`/`0xMANUAL…` markers, or a receipt link
 * without a hash). Callers on CREDITING paths must record that `false` — see
 * `TransactionsService.recordUnclaimedCredit`.
 */
export async function consumeTxHash(
  dbtx: DrizzleTx,
  params: {
    txHash: string
    purpose: ConsumedTxPurpose
    referenceId: string | null
    consumedByUserId: string | null
  },
): Promise<ConsumeTxHashResult> {
  const normalized = normalizeOnChainTxHash(params.txHash)
  // MED-1 (security-review PR #438): report the skip so the caller can RECORD
  // it. A credit whose evidence carries no on-chain hash (an `…/address/0x…`
  // explorer link, a non-Ethereum explorer) is legitimate legacy behaviour —
  // but it is also the exact shape of the HIGH-1 bug ("money moved, registry
  // untouched"), so an auditor must be able to tell the two apart.
  if (!normalized) return { claimed: false, reclaimedAfterRelease: false }

  // The INSERT goes FIRST and is the serialization point: the partial unique
  // index makes a competing ACTIVE claim fail here, so whatever we observe
  // afterwards is settled fact.
  const [inserted] = await dbtx
    .insert(consumedTxHashes)
    .values({
      txHash: normalized,
      purpose: params.purpose,
      referenceId: params.referenceId,
      consumedByUserId: params.consumedByUserId,
    })
    .returning({ id: consumedTxHashes.id })

  // MED-J (round 5): is this hash being spent AGAIN after an ADMIN released it?
  // The release is legitimate (it exists to unstick money) but the pair
  // "released → consumed again" is the sequence an investigator looks for, so
  // the caller records it.
  //
  // MED-O (round 6): this read happens AFTER the insert, not before. Reading
  // first left a window — a release committing between the read and the insert
  // produced a claim that looked first-time, silently breaking exactly the pair
  // this signal exists to preserve. Under READ COMMITTED each statement takes a
  // fresh snapshot, so a release that committed before our insert is visible
  // here; one that commits later cannot have preceded this claim anyway.
  //
  // LOW (round 7): inspect the row IMMEDIATELY PRECEDING ours, not "any
  // released row ever". The previous form was sticky — once a hash had been
  // released, every later claim carried the marker, which is noise exactly
  // where an investigator wants signal. The predecessor is decisive on its
  // own: a new claim can only exist because the previous one is no longer
  // ACTIVE, so "the previous row is released" IS "this claim follows a
  // release". The explicit ORDER BY also replaces an unordered `findFirst`
  // whose correctness relied on there being at most one tombstone (round 6).
  const [previous] = await dbtx
    .select({ releasedAt: consumedTxHashes.releasedAt })
    .from(consumedTxHashes)
    .where(and(eq(consumedTxHashes.txHash, normalized), ne(consumedTxHashes.id, inserted!.id)))
    .orderBy(desc(consumedTxHashes.createdAt))
    .limit(1)

  return {
    claimed: true,
    reclaimedAfterRelease: previous?.releasedAt != null,
  }
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
): Promise<{ purpose: string; referenceId: string | null } | null> {
  const normalized = normalizeOnChainTxHash(txHash)
  if (!normalized) return null

  // `referenceId` matters (security-review round 4, MED-G): a guard that only
  // asks "is this hash taken?" rejects a user re-attaching their OWN receipt to
  // the very row that claimed it. Callers compare the OWNER, not the value.
  //
  // MED-J (round 5): only ACTIVE claims block. A released tombstone stays in
  // the table as evidence but must not keep the transfer un-settleable — that
  // would re-create the very lock-out the release exists to undo.
  const row = await db.query.consumedTxHashes.findFirst({
    where: and(eq(consumedTxHashes.txHash, normalized), isNull(consumedTxHashes.releasedAt)),
    columns: { purpose: true, referenceId: true },
  })
  return row ?? null
}

/**
 * Full state of a hash for the read-only inspection endpoint (MED-K).
 *
 * Returns the ACTIVE claim when there is one, else the most recent tombstone,
 * so an ADMIN can see what a release would touch — or what a past release
 * already did — BEFORE acting.
 */
export async function describeTxHashClaim(
  db: Pick<DrizzleTx, 'query'>,
  txHash: string,
): Promise<{
  txHash: string
  purpose: string
  referenceId: string | null
  consumedByUserId: string | null
  createdAt: Date
  releasedAt: Date | null
  releasedBy: string | null
  releasedReason: string | null
} | null> {
  const normalized = normalizeOnChainTxHash(txHash)
  if (!normalized) return null

  const rows = await db.query.consumedTxHashes.findMany({
    where: eq(consumedTxHashes.txHash, normalized),
  })
  if (rows.length === 0) return null

  // Prefer the active claim; otherwise the newest tombstone.
  const active = rows.find((r) => r.releasedAt === null)
  const chosen = active ?? rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!
  return {
    txHash: chosen.txHash,
    purpose: chosen.purpose,
    referenceId: chosen.referenceId,
    consumedByUserId: chosen.consumedByUserId,
    createdAt: chosen.createdAt,
    releasedAt: chosen.releasedAt,
    releasedBy: chosen.releasedBy,
    releasedReason: chosen.releasedReason,
  }
}

/**
 * Release a claim so the transfer can be settled again — the ONLY way out of a
 * mis-claim (security-review round 4, MED-G).
 *
 * Why this must exist: a claim is otherwise permanent. A typo'd hash burns a
 * stranger's transfer forever; an unconfirmed deposit that later collides can
 * never be credited; deleting and re-creating the row does not help, because
 * the registry deliberately outlives its referent. Without a release the
 * integrity fix becomes an operational lock-out — and the people locked out are
 * us.
 *
 * Deliberately NOT self-service: callers must be ADMIN and must supply a reason,
 * and the caller is responsible for journaling (see
 * `TransactionsService.releaseOnChainHash`) — swapping "cannot unstick money"
 * for "anyone can silently un-spend a transfer" would be the worse trade.
 *
 * Returns the released row, or null when the hash was not claimed.
 */
export async function releaseConsumedTxHash(
  dbtx: DrizzleTx,
  txHash: string,
  releasedBy: string,
  reason: string,
): Promise<{ txHash: string; purpose: string; referenceId: string | null } | null> {
  const normalized = normalizeOnChainTxHash(txHash)
  if (!normalized) return null

  // MED-J (round 5): TOMBSTONE, not DELETE. The row stays — carrying who
  // released it, when and why — so the "released → spent again" pair is
  // reconstructable. The partial unique index ignores released rows, so the
  // transfer becomes settleable again exactly as intended.
  const [released] = await dbtx
    .update(consumedTxHashes)
    .set({ releasedAt: new Date(), releasedBy, releasedReason: reason })
    .where(and(eq(consumedTxHashes.txHash, normalized), isNull(consumedTxHashes.releasedAt)))
    .returning({
      txHash: consumedTxHashes.txHash,
      purpose: consumedTxHashes.purpose,
      referenceId: consumedTxHashes.referenceId,
    })
  return released ?? null
}
