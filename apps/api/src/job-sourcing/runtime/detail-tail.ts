import type { JobSourceType } from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { MeterDb } from '../metering/account-meter.store'
import { nativeIdFromIdentityKey } from '../normalize/identity-key'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  type FailOutcome,
  claimDetailFetchForSource,
  completeDirty,
  failDirty,
  releaseDirty,
} from '../ownership/dirty-work.store'
import type { RunHandle } from '../ownership/run-ownership'
import type {
  CollectionContext,
  DetailOutcome,
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../providers/reporting-provider'
import { closeRecordByInventory, saveObservations } from '../store/source-record.store'

/**
 * SFS U10 (ADR 6a, change #4 "Fetch", #6 "Cache", #7 "Failure") — the run worker's DETAIL tail.
 *
 * After a run's list phase (or alone, for a `DETAIL_ONLY` run), the worker claims up to
 * `detailPerRun` pending `DETAIL_FETCH` rows of its OWN source (type + namespace), oldest first, and
 * fetches each posting's detail through the run's context (`ctx.fetchText`), so every rule of the
 * run applies: the host budget and `HOST_BUSY`, the ban pause, fencing, the byte caps and the
 * request meter. The tail is pure orchestration over a `DetailTailPort`; the real port is the DB.
 *
 *   FOUND  write the detail through the source-record store as a new immutable revision
 *          (`saveObservations`, content-addressed; NO list checkpoint is touched) and complete the
 *          row. The new revision advances the record's version, so completing it is `DEFERRED`
 *          (`VERSION_STALE`) — the re-fetch is done; the SOURCE_REVISION the write enqueues drives
 *          re-evaluation.
 *   GONE   a 404: the posting is gone. Recorded as availability evidence (`DETAIL_GONE`) and
 *          completed `DONE`, never retried.
 *   FAILED count an attempt (`DETAIL_<code>`); after `DIRTY_MAX_ATTEMPTS_DEFAULT` the row is FAILED.
 *
 * A transport refusal (401/403/429/451) is thrown by `ctx.fetchText` and PROPAGATES untouched: it
 * ends the run and pauses the host, and the claimed row — still CLAIMED — is recovered on lease
 * expiry and retried after the pause. An `IN_LIST` provider has no `collectDetail`, so its tail is a
 * no-op and nothing is ever claimed (the machinery stays inert until a source's manifest flips).
 */

export interface DetailTailReport {
  readonly claimed: number
  /** FOUND outcomes written through the store. */
  readonly fetched: number
  readonly gone: number
  readonly failed: number
  readonly retried: number
  /** FOUND whose completion was DEFERRED because the write advanced the record's version. */
  readonly deferred: number
  /** Rows whose record carries no native id to fetch by (a data defect: failed, no retry). */
  readonly unfetchable: number
  /** FOUND whose observation identity did not match the claimed record (CR-M-9: failed, no retry). */
  readonly mismatched: number
}

const ZERO: DetailTailReport = {
  claimed: 0,
  fetched: 0,
  gone: 0,
  failed: 0,
  retried: 0,
  deferred: 0,
  unfetchable: 0,
  mismatched: 0,
}

/** One claimed DETAIL_FETCH row with the native id recovered from its record's identity. */
export interface ClaimedDetail {
  readonly handle: ClaimedDirtyWork
  readonly recordId: string
  /** null when the record has no native id (a URL_FALLBACK record cannot be fetched by id). */
  readonly nativeId: string | null
  /**
   * The claimed record's canonical `identityKey`, carried so the tail can prove a FOUND observation
   * is the SAME posting before writing it through (CR-M-9). null only when the record vanished
   * between claim and read — then nativeId is null too and the row never reaches a fetch.
   */
  readonly identityKey: string | null
}

/** The side effects the tail orchestrates; the real one is the database, a fake one in unit tests. */
export interface DetailTailPort {
  claim(batchSize: number): Promise<readonly ClaimedDetail[]>
  /** Persist the FOUND detail as a new revision and complete the row. */
  writeFound(
    row: ClaimedDetail,
    outcome: Extract<DetailOutcome, { kind: 'FOUND' }>,
  ): Promise<CompleteOutcome>
  /** Record the posting as gone (availability evidence) and complete the row DONE. */
  recordGone(row: ClaimedDetail): Promise<void>
  fail(row: ClaimedDetail, code: string, poison: boolean): Promise<FailOutcome>
  /** Hand untried claimed rows back to PENDING without spending an attempt (CR-M-6, aborted tail). */
  release(rows: readonly ClaimedDetail[]): Promise<void>
}

/**
 * Run the detail tail. Provider-agnostic: the host budget, deadline, lease and ban all live inside
 * `ctx`, which `provider.collectDetail` uses, so a refusal throws out of here and ends the run.
 */
export async function runDetailTail<C extends ValidatedSourceConfig>(
  provider: Pick<ReportingJobSourceProvider<C>, 'collectDetail'>,
  config: C,
  ctx: CollectionContext,
  port: DetailTailPort,
  detailPerRun: number,
): Promise<DetailTailReport> {
  if (provider.collectDetail === undefined || detailPerRun < 1) return ZERO
  const rows = await port.claim(detailPerRun)
  const report = { ...ZERO, claimed: rows.length }
  let i = 0
  try {
    for (; i < rows.length; i++) {
      const row = rows[i] as ClaimedDetail
      if (row.nativeId === null) {
        await port.fail(row, 'DETAIL_NO_NATIVE_ID', true)
        report.unfetchable += 1
        report.failed += 1
        continue
      }
      // Throws ContextRefusedError on a transport refusal; it propagates (ends the run, pauses host).
      const outcome = await provider.collectDetail(config, { nativeId: row.nativeId }, ctx)
      if (outcome.kind === 'FOUND') {
        // CR-M-9: the fetched posting MUST be the record we claimed. A mismatch (an adapter that
        // returned detail for a different posting) would write a NEW record through the store while
        // this row settled DONE — a silent duplicate hiding the defect. Fail loud, poison (no write,
        // no DONE, no retry: a wrong-id answer is not transient), exactly like a data defect.
        if (outcome.observation.identity.identityKey !== row.identityKey) {
          await port.fail(row, 'DETAIL_IDENTITY_MISMATCH', true)
          report.mismatched += 1
          report.failed += 1
          continue
        }
        const done = await port.writeFound(row, outcome)
        report.fetched += 1
        if (done === 'DEFERRED') report.deferred += 1
      } else if (outcome.kind === 'GONE') {
        await port.recordGone(row)
        report.gone += 1
      } else {
        const r = await port.fail(row, `DETAIL_${outcome.code}`, false)
        if (r === 'FAILED') report.failed += 1
        else report.retried += 1
      }
    }
  } catch (err) {
    // CR-M-6: the tail aborted (a ban/deadline/fence thrown out of `collectDetail`). Rows AFTER the
    // in-flight one were claimed but never tried; hand them back to PENDING without spending an
    // attempt, or their leases expire and `recoverExpiredDirty` would count each as a spent attempt —
    // ~DIRTY_MAX_ATTEMPTS bans could then FAIL postings nothing ever fetched. The in-flight row
    // rows[i] stays CLAIMED and is recovered on lease expiry (the documented refusal path).
    const untried = rows.slice(i + 1)
    if (untried.length > 0) {
      try {
        await port.release(untried)
      } catch {
        // Best-effort: a failed release leaves those rows to lease-expiry recovery (the prior
        // behaviour). The original abort error, not this one, must end the run.
      }
    }
    throw err
  }
  return report
}

export interface DetailTailPortDeps {
  readonly db: MeterDb
  readonly owner: string
  readonly source: { readonly type: JobSourceType; readonly namespace: string }
  readonly handle: RunHandle
  /** For the DETAIL_GONE availability evidence written on a 404. */
  readonly runId: string
  readonly adapterVersion: string
  readonly configVersion: number
  readonly now: () => Date
  readonly leaseMs?: number
}

/** The real DB port: claim + the two write transactions + fail. */
export function createDetailTailPort(deps: DetailTailPortDeps): DetailTailPort {
  const { db, handle } = deps
  return {
    async claim(batchSize) {
      const claimed = await claimDetailFetchForSource(db, {
        owner: deps.owner,
        source: deps.source,
        batchSize,
        ...(deps.leaseMs === undefined ? {} : { leaseMs: deps.leaseMs }),
      })
      if (claimed.length === 0) return []
      // The ids are the claimed rows' own `entity_id`s (DB uuids); passed as a `uuid[]` array
      // parameter, not spread, so there is no injection surface and no row-constructor spread.
      const ids = sql`${`{${claimed.map((c) => c.entityId).join(',')}}`}::uuid[]`
      const { rows } = await db.execute(
        sql`SELECT id, identity_kind, identity_key FROM job_source_records WHERE id = ANY(${ids})`,
      )
      const byId = new Map(
        rows.map((r) => [
          String(r['id']),
          {
            nativeId: nativeIdFromIdentityKey(
              String(r['identity_kind']),
              String(r['identity_key']),
            ),
            identityKey: String(r['identity_key']),
          },
        ]),
      )
      return claimed.map((c) => {
        const rec = byId.get(c.entityId)
        return {
          handle: c,
          recordId: c.entityId,
          nativeId: rec?.nativeId ?? null,
          identityKey: rec?.identityKey ?? null,
        }
      })
    },
    writeFound(row, outcome) {
      return db.transaction(async (tx) => {
        await saveObservations(tx, handle, [outcome.observation])
        return completeDirty(tx, row.handle)
      })
    },
    async recordGone(row) {
      await db.transaction(async (tx) => {
        // Hold the record so a concurrent observation writer cannot re-list it between read and write.
        await tx.execute(
          sql`SELECT 1 FROM job_source_records WHERE id = ${row.recordId}::uuid FOR UPDATE`,
        )
        await closeRecordByInventory(tx, row.recordId, {
          kind: 'DETAIL_GONE',
          httpStatus: 404,
          adapterVersion: deps.adapterVersion,
          board: deps.source.namespace,
          configVersion: deps.configVersion,
          runId: deps.runId,
          observedAt: deps.now().toISOString(),
        })
        await completeDirty(tx, row.handle)
      })
    },
    fail(row, code, poison) {
      return failDirty(db, row.handle, code, poison ? { maxAttempts: 1 } : {})
    },
    async release(rows) {
      // Only on an aborted tail (rare). Each handle carries its own epoch, so release one by one;
      // one transaction so an interrupted release does not half-release the batch.
      await db.transaction(async (tx) => {
        for (const row of rows) await releaseDirty(tx, row.handle)
      })
    },
  }
}
