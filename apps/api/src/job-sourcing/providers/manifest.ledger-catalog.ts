import type { LedgerCatalog, LedgerCatalogEntry } from '../ownership/ledger-catalog'
import { type Manifest, readinessAt } from './manifest'
import { hostPolicyOf } from './manifest.hosts'

/**
 * The run ledger's catalog, built from the manifest (r5 Task 2.5 T3). It lives with the manifest
 * because only manifest code may read manifest data; the ledger depends on the `LedgerCatalog`
 * port, never on this file.
 *
 * Every readiness answer is evaluated at the clock the LEDGER passes in -- the database clock read
 * in the claim transaction (SR-L-21) -- never at a clock of this file's own. The host policy is the
 * manifest's merged policy of the key (`hostPolicyOf`), so a claim cannot be handed a looser one by
 * its caller.
 *
 * !! The manifest is excluded from the production build (`tsconfig.build.json`, `manifest*.ts`), and
 * so is this file. Wiring a catalog into the production process is T7's.
 */
export function buildLedgerCatalog(manifest: Manifest): LedgerCatalog {
  const entries = new Map<string, LedgerCatalogEntry>()
  for (const t of manifest.types) {
    for (const e of manifest.entries.filter((x) => x.type === t.type)) {
      entries.set(e.id, {
        type: e.type,
        activationFacts: (at) => {
          const r = readinessAt(t, at)
          return {
            readiness: r.status,
            blockerCodes: r.blockers.map((b) => b.code),
            payloadVerified: t.payloadVerified,
          }
        },
        entryReadiness: (at) => readinessAt(e, at).status,
        quotaDeclared: t.quota !== null,
        intervalHours: e.intervalHours,
        floorHours: t.minIntervalHoursFloor,
      })
    }
  }
  return {
    entry: (manifestId) => entries.get(manifestId),
    hostPolicy: (hostKey) => hostPolicyOf(manifest, hostKey),
  }
}
