import type { DepositVerification } from '../etherscan.service'

/**
 * task-onchain-payment-integrity — shared shaping for the scripted
 * `EtherscanService.verifyDeposit` fakes used across the finance integration
 * suites (each file keeps its own `Map<hash, verification>` script).
 *
 * Two jobs:
 *
 *  1. DEFAULT for an unscripted hash — "not found", nothing creditable.
 *  2. DERIVE `amountUsdtMinor` from `amountUsdt` when a test only states the
 *     human figure. The payout path compares EXACT minor units, so a fake that
 *     set `amountUsdt` alone would silently make every payout unsettleable —
 *     and a fake that set the two fields by hand could drift apart. Deriving
 *     here keeps "the on-chain transfer is exactly this many USDT" a single
 *     statement in the test. A test that needs them to DISAGREE (off-by-one-
 *     minor-unit cases) still passes `amountUsdtMinor` explicitly and it wins.
 */
/**
 * What a test writes into its `verifyScript` map: any subset of a verification.
 * Unstated fields fall back to the "nothing creditable" default.
 */
export type ScriptedVerification = Partial<DepositVerification> & { amountUsdt?: number | null }

export function withDerivedMinorUnits(
  scripted: ScriptedVerification | undefined,
): DepositVerification {
  if (!scripted) {
    return {
      found: false,
      toMatches: false,
      fromAddress: null,
      confirmed: false,
      confirmations: 0,
      amountUsdt: null,
      amountUsdtMinor: null,
    }
  }

  const amountUsdt = scripted.amountUsdt ?? null
  const derivedMinor =
    amountUsdt === null ? null : BigInt(Math.round(amountUsdt * 1_000_000)).toString()

  return {
    found: scripted.found ?? false,
    toMatches: scripted.toMatches ?? false,
    fromAddress: scripted.fromAddress ?? null,
    confirmed: scripted.confirmed ?? false,
    confirmations: scripted.confirmations ?? 0,
    amountUsdt,
    amountUsdtMinor: scripted.amountUsdtMinor ?? derivedMinor,
    ...(scripted.onChainSuccess !== undefined && { onChainSuccess: scripted.onChainSuccess }),
    ...(scripted.error !== undefined && { error: scripted.error }),
  }
}
