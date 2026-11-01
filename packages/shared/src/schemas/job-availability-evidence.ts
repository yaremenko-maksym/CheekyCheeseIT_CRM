import { z } from 'zod'

/**
 * Shape of `job_source_records.availability_evidence` (r5 Task 4.6 S8a; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decisions 1-3).
 *
 * One evidence object per availability transition: the kind, the run that produced it, the board
 * and `configVersion` it was observed under. Nothing writes it yet (the reconciliation worker is
 * S8d); the writer parses with this schema at the trust boundary. The column default `{}` is NOT
 * valid evidence by design.
 */
export const AVAILABILITY_EVIDENCE_KINDS = [
  'DETAIL_GONE',
  'INVENTORY_MISSING',
  'WINDOW_DROPPED',
  'OBSERVED_OPEN',
] as const

const common = {
  /** The collection run (or cycle) that produced the evidence. */
  runId: z.string().uuid(),
  /** The source scope the observation was made under. */
  board: z.string().trim().min(1).max(200),
  /** A config bump is a different observation regime (ADR D4). */
  configVersion: z.number().int().positive(),
  observedAt: z.string().datetime(),
}

/** A tested-adapter `GONE`: only 404/410 close a record (Decision 2). */
const detailGoneSchema = z
  .object({
    ...common,
    kind: z.literal('DETAIL_GONE'),
    httpStatus: z.union([z.literal(404), z.literal(410)]),
    adapterVersion: z.string().trim().min(1).max(100),
  })
  .strict()

/** The D4 counter reached its threshold on VALID FULL_INVENTORY runs (Decision 3). */
const inventoryMissingSchema = z
  .object({
    ...common,
    kind: z.literal('INVENTORY_MISSING'),
    consecutiveMisses: z.number().int().positive(),
    requiredMisses: z.number().int().positive(),
    firstMissRunId: z.string().uuid(),
    firstMissAt: z.string().datetime(),
    lastInventorySize: z.number().int().nonnegative(),
  })
  .strict()
  .refine((e) => e.consecutiveMisses >= e.requiredMisses, {
    message: 'closing evidence must have reached the miss threshold',
    path: ['consecutiveMisses'],
  })

/** Aggregator expiry: the posting left a window; this is visibility loss, not employer closure. */
const windowDroppedSchema = z.object({ ...common, kind: z.literal('WINDOW_DROPPED') }).strict()

/** Current open evidence: a fresh observation or a detail re-fetch that returned FOUND. */
const observedOpenSchema = z
  .object({
    ...common,
    kind: z.literal('OBSERVED_OPEN'),
    basis: z.enum(['OBSERVED', 'DETAIL_FOUND']),
  })
  .strict()

export const availabilityEvidenceSchema = z.union([
  detailGoneSchema,
  inventoryMissingSchema,
  windowDroppedSchema,
  observedOpenSchema,
])

export type AvailabilityEvidenceKind = (typeof AVAILABILITY_EVIDENCE_KINDS)[number]
export type AvailabilityEvidence = z.infer<typeof availabilityEvidenceSchema>
