/**
 * Pure availability derivation (r5 Task 4.6 S8b; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decisions 1, 3, 6).
 *
 * No I/O, no DB, no Nest. Ships dark: the reconciliation worker (S8c/S8d) maps DB rows to these
 * plain value objects and persists the results. The owner-frozen D4 floor lives in
 * `transitionInventoryMissCounter`, not only in a later worker.
 */
import type { AvailabilityEvidence, JobAvailability, JobCollectionCoverage } from '@crm/shared'

/** D4: consecutive VALID FULL_INVENTORY misses required to close. Owner-frozen. */
export const REQUIRED_INVENTORY_MISSES = 3
/** D4: minimum span between the first miss and the closing run. Owner-frozen. */
export const MIN_MISS_SPAN_MS = 24 * 60 * 60 * 1000
/** D4: an inventory below this fraction of the previous size is a collection fault, not closures. */
const MIN_INVENTORY_FRACTION = 0.5

// ---------- 1. record-grain ----------

export interface RecordObservationFacts {
  /** Was the record seen in this run's observation of its board? */
  present: boolean
  coverage: JobCollectionCoverage
  runId: string
  board: string
  configVersion: number
  /** ISO datetime. */
  observedAt: string
}

export type RecordAvailabilityDecision =
  | { kind: 'open'; availability: 'OPEN'; evidence: AvailabilityEvidence }
  /** Absent from a FULL_INVENTORY inventory: feeds the D4 counter, never closes by itself. */
  | { kind: 'miss' }
  /** Not decided here (the WINDOW/PARTIAL expiry path is S8e). */
  | { kind: 'unchanged' }

export function deriveRecordAvailability(
  facts: RecordObservationFacts,
): RecordAvailabilityDecision {
  if (facts.present) {
    return {
      kind: 'open',
      availability: 'OPEN',
      evidence: {
        kind: 'OBSERVED_OPEN',
        basis: 'OBSERVED',
        runId: facts.runId,
        board: facts.board,
        configVersion: facts.configVersion,
        observedAt: facts.observedAt,
      },
    }
  }
  // EXPIRED (window-drop) is S8e: absence outside a full inventory decides nothing here.
  return facts.coverage === 'FULL_INVENTORY' ? { kind: 'miss' } : { kind: 'unchanged' }
}

// ---------- 2. opportunity-grain ----------

/** Most-open ordering; the first present state wins. */
const OPENNESS_ORDER: readonly JobAvailability[] = ['OPEN', 'UNKNOWN', 'EXPIRED', 'CLOSED']

/**
 * Most-open over the ACTIVE source records: OPEN > UNKNOWN > EXPIRED > CLOSED. One live OPEN record
 * keeps the opportunity OPEN; CLOSED only when every record is CLOSED. No active records -> UNKNOWN.
 */
export function deriveOpportunityAvailability(
  recordStates: readonly JobAvailability[],
): JobAvailability {
  return OPENNESS_ORDER.find((s) => recordStates.includes(s)) ?? 'UNKNOWN'
}

// ---------- 3. D4 counter ----------

export interface InventoryMissCounter {
  board: string
  configVersion: number
  consecutiveMisses: number
  firstMissRunId: string | null
  firstMissAt: string | null
  lastMissRunId: string | null
  lastMissAt: string | null
  lastInventorySize: number
}

export interface InventoryRunFact {
  runId: string
  board: string
  configVersion: number
  outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | (string & {})
  coverage: JobCollectionCoverage
  /** Was the record listed in this run's inventory? */
  recordPresent: boolean
  /** Total records the run listed (for the >50% drop guard). */
  inventorySize: number
  /** ISO datetime of the run's observation. */
  observedAt: string
}

export type CounterTransition =
  | { kind: 'unchanged'; next: InventoryMissCounter | null }
  | { kind: 'reset'; next: InventoryMissCounter }
  | { kind: 'advance'; next: InventoryMissCounter }
  /** >50% inventory drop: counter untouched, source flagged for review. */
  | { kind: 'review'; next: InventoryMissCounter | null }
  | { kind: 'close'; next: InventoryMissCounter; evidence: AvailabilityEvidence }

/**
 * Evidence is parsed through `availabilityEvidenceSchema` in the spec only: the S8d persisting caller
 * MUST `.parse()` it before writing.
 *
 * `lastInventorySize` is the baseline for the >50% drop guard: the HIGHEST size ever seen for this
 * counter (so step-shrinking 100 -> 50 -> 25 trips review), kept through a reset, never <= 0.
 * `lastMissRunId` / `lastMissAt` double as the replay watermark: the last run processed, advanced by
 * a miss AND by a reset, so old runs replayed after a reset cannot rebuild a chain. A `reset` zeroes
 * only the miss chain (S8d must UPDATE the row, never delete it).
 */
export function transitionInventoryMissCounter(
  current: InventoryMissCounter | null,
  run: InventoryRunFact,
): CounterTransition {
  const valid = run.outcome === 'SUCCEEDED' && run.coverage === 'FULL_INVENTORY'
  const sameScope =
    current === null || (current.board === run.board && current.configVersion === run.configVersion)
  if (!valid || !sameScope) return { kind: 'unchanged', next: current }

  // A replayed or out-of-order run must not count as another miss (SR-H-1).
  if (
    current !== null &&
    current.lastMissAt !== null &&
    (run.runId === current.lastMissRunId ||
      Date.parse(run.observedAt) <= Date.parse(current.lastMissAt))
  ) {
    return { kind: 'unchanged', next: current }
  }

  // Drop guard runs before the present-reset so a collapsed run never touches the counter (SR-M-1).
  // Limit: no drop guard on the first miss when current===null; bounded by the 3x FULL_INVENTORY/24h
  // floor (it cannot close alone). A per-board baseline is S8c's job.
  if (current !== null && run.inventorySize < current.lastInventorySize * MIN_INVENTORY_FRACTION) {
    return { kind: 'review', next: current }
  }

  if (run.recordPresent) {
    if (current === null || current.consecutiveMisses === 0)
      return { kind: 'unchanged', next: current }
    return {
      kind: 'reset',
      next: {
        ...current,
        consecutiveMisses: 0,
        firstMissRunId: null,
        firstMissAt: null,
        lastMissRunId: run.runId,
        lastMissAt: run.observedAt,
        lastInventorySize: Math.max(current.lastInventorySize, run.inventorySize),
      },
    }
  }

  // An empty inventory is a collection fault, never a mass closure; no baseline <= 0 (SR-H-2).
  if (run.inventorySize <= 0) return { kind: 'review', next: current }

  const chain = current !== null && current.consecutiveMisses > 0 ? current : null
  const consecutiveMisses = (chain?.consecutiveMisses ?? 0) + 1
  const firstMissRunId = chain?.firstMissRunId ?? run.runId
  const firstMissAt = chain?.firstMissAt ?? run.observedAt
  const next: InventoryMissCounter = {
    board: run.board,
    configVersion: run.configVersion,
    consecutiveMisses,
    firstMissRunId,
    firstMissAt,
    lastMissRunId: run.runId,
    lastMissAt: run.observedAt,
    lastInventorySize: Math.max(current?.lastInventorySize ?? 0, run.inventorySize),
  }

  const spanMs = Date.parse(run.observedAt) - Date.parse(firstMissAt)
  if (consecutiveMisses >= REQUIRED_INVENTORY_MISSES && spanMs >= MIN_MISS_SPAN_MS) {
    return {
      kind: 'close',
      next,
      evidence: {
        kind: 'INVENTORY_MISSING',
        runId: run.runId,
        board: run.board,
        configVersion: run.configVersion,
        observedAt: run.observedAt,
        consecutiveMisses,
        requiredMisses: REQUIRED_INVENTORY_MISSES,
        firstMissRunId,
        firstMissAt,
        lastInventorySize: run.inventorySize,
      },
    }
  }
  return { kind: 'advance', next }
}
