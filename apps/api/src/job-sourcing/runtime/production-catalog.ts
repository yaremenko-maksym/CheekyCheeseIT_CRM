import type { JobSourceType } from '@crm/shared'
import type { LedgerCatalog, LedgerCatalogEntry } from '../ownership/ledger-catalog'
import type { BanScope, HostPolicy } from '../scheduling/host-policy'
import { LEDGER_CATALOG_SNAPSHOT } from './ledger-catalog.snapshot'

/**
 * The run ledger's catalog IN PRODUCTION (r5 Task 2.5 T7).
 *
 * The manifest cannot be imported by production code: it reads fixture files and
 * `tsconfig.build.json` drops every `providers/manifest*.ts`. So the facts the ledger needs are
 * GENERATED from the manifest into `ledger-catalog.snapshot.ts` (plain data, part of the build) by
 * `pnpm --filter @crm/api job-sources:manifest:generate`, and read here. The drift spec
 * (`ledger-catalog.snapshot.drift.spec.ts`) fails when the committed snapshot differs from what the
 * manifest produces, and compares this catalog's answers with the manifest catalog's at the
 * instants around every deadline, so the two cannot disagree silently.
 */

export interface SnapshotDeadline {
  readonly kind: 'AUTH_REQUIRED_FROM' | 'POLICY_EXPIRES'
  /** ISO-8601 instant. */
  readonly at: string
}

export interface SnapshotType {
  readonly type: JobSourceType
  /** The type's disposition is the legacy contract (DOU): its readiness is `LEGACY`. */
  readonly legacy: boolean
  readonly blockerCodes: readonly string[]
  readonly deadlines: readonly SnapshotDeadline[]
  readonly payloadVerified: boolean
  readonly quotaDeclared: boolean
  readonly floorHours: number
  readonly banScope: BanScope
}

export interface SnapshotEntry {
  readonly id: string
  readonly type: JobSourceType
  readonly blockerCodes: readonly string[]
  readonly deadlines: readonly SnapshotDeadline[]
  readonly intervalHours: number
}

export interface SnapshotHost {
  readonly hostKey: string
  readonly policy: HostPolicy
}

export interface LedgerCatalogSnapshot {
  readonly types: readonly SnapshotType[]
  readonly entries: readonly SnapshotEntry[]
  readonly hosts: readonly SnapshotHost[]
}

/**
 * The manifest's `readinessAt`, over snapshot data: a legacy type is `LEGACY`; otherwise the
 * standing blockers plus every deadline the clock has reached, `CANDIDATE` only when none stand.
 */
export function snapshotReadinessAt(
  subject: {
    readonly legacy?: boolean
    readonly blockerCodes: readonly string[]
    readonly deadlines: readonly SnapshotDeadline[]
  },
  at: Date,
): { status: 'CANDIDATE' | 'BLOCKED' | 'LEGACY'; blockerCodes: string[] } {
  if (subject.legacy === true) return { status: 'LEGACY', blockerCodes: [] }
  const timed = subject.deadlines
    .filter((d) => at.getTime() >= Date.parse(d.at))
    .map((d) => (d.kind === 'AUTH_REQUIRED_FROM' ? 'AUTH_DEADLINE_PASSED' : 'POLICY_EXPIRED'))
  const blockerCodes = [...subject.blockerCodes, ...timed]
  return { status: blockerCodes.length === 0 ? 'CANDIDATE' : 'BLOCKED', blockerCodes }
}

export function catalogFromSnapshot(snapshot: LedgerCatalogSnapshot): LedgerCatalog {
  const types = new Map(snapshot.types.map((t) => [t.type, t]))
  const entries = new Map<string, LedgerCatalogEntry>()
  for (const e of snapshot.entries) {
    const t = types.get(e.type)
    // An entry whose type the snapshot does not describe is not resolved: the claim refuses it.
    if (t === undefined) continue
    entries.set(e.id, {
      type: e.type,
      activationFacts: (at) => {
        const r = snapshotReadinessAt(t, at)
        return {
          readiness: r.status,
          blockerCodes: r.blockerCodes,
          payloadVerified: t.payloadVerified,
        }
      },
      entryReadiness: (at) => snapshotReadinessAt(e, at).status,
      quotaDeclared: t.quotaDeclared,
      intervalHours: e.intervalHours,
      floorHours: t.floorHours,
      banScope: t.banScope,
    })
  }
  const hosts = new Map(snapshot.hosts.map((h) => [h.hostKey, h.policy]))
  return {
    entry: (manifestId) => entries.get(manifestId),
    hostPolicy: (hostKey) => hosts.get(hostKey),
  }
}

/** The catalog the production worker runs with. */
export function productionLedgerCatalog(): LedgerCatalog {
  return catalogFromSnapshot(LEDGER_CATALOG_SNAPSHOT)
}
