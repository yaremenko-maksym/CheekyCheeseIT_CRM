import { type SQL, sql } from 'drizzle-orm'
import { IDENTITY_RULES_VERSION, canAttach } from '../identity/resolver'
import type { MeterDb } from '../metering/account-meter.store'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  type ActiveLink,
  type CanonicalFields,
  type IdentityToken,
  type MemberSnapshot,
  canonicalFields,
  decideAuto,
  decisionOrder,
  keepMayClaim,
  toInstant,
  toResolverRecord,
  trustedTokens,
} from './canonical-plan'
import { RetryableRaceError, setLockTimeout, sortedUniqueIds, withLockRetry } from './lock-order'
import { STORE_LOCK_TIMEOUT_MS } from './source-record.store'

/**
 * The canonical repository (r5 Task 4.5): source record -> opportunity associations, identity
 * tokens and canonical revisions.
 *
 * LOCK ORDER: records by id ascending (one statement), then opportunities by id ascending (one
 * statement), before any write; see `lock-order.ts` for how this sits beside the page path.
 *
 * TOKENS: rows with UNIQUE (namespace_kind, token_key), claimed by `INSERT … ON CONFLICT DO
 * NOTHING` then reading the owner — not advisory locks. The constraint is the arbiter, so no
 * path can claim without it and none has to remember a lock. A claim lost to a winner the plan
 * could not yet see aborts the attempt with `RetryableRaceError`, and the whole transaction is
 * re-run: the winner is visible then, and the plan changes accordingly.
 *
 * AUTHORIZATION: no endpoint here. The ADMIN check lives at the CALLER (Task 4.6 / an ADMIN
 * command); the disposition methods take an `AdminActor`, which only `asAdminActor` mints, and
 * they refuse at runtime anything it did not mint (a cast cannot forge one).
 *
 * VISIBILITY: no method returns opportunities for a viewer; there is no queue read here.
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const
/** `job_dirty_work.reason` of a new canonical revision. */
export const CANONICAL_REVISION_REASON = 'CANONICAL_REVISION'
const REASON_MAX = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

declare const adminBrand: unique symbol
/** An ADMIN, established by the caller. Constructible only through `asAdminActor`. */
export interface AdminActor {
  readonly userId: string
  readonly [adminBrand]: true
}

const minted = new WeakSet<object>()

export class ForbiddenActorError extends Error {
  readonly code = 'FORBIDDEN_ACTOR' as const

  constructor() {
    super('a canonical disposition needs an ADMIN actor')
    this.name = 'ForbiddenActorError'
  }
}

/**
 * The one way to obtain an `AdminActor`: the caller's authenticated user, role ADMIN. It is NOT
 * the authority (SR-M-3): every disposition re-reads the actor's role in the database inside its
 * own transaction, so a demoted or archived ADMIN, or an actor minted from literals, is refused
 * there. `admin-actor.spec.ts` pins the callers of this function.
 */
export function asAdminActor(user: { readonly id: string; readonly role: string }): AdminActor {
  if (user.role !== 'ADMIN' || !UUID.test(user.id)) throw new ForbiddenActorError()
  const actor = Object.freeze({ userId: user.id }) as AdminActor
  minted.add(actor)
  return actor
}

/** The mint check, then the database: an ADMIN now, not archived. In the disposition's tx. */
async function assertAdmin(tx: SqlExecutor, actor: AdminActor): Promise<void> {
  if (!minted.has(actor)) throw new ForbiddenActorError()
  const { rows } = await tx.execute(
    sql`SELECT 1 AS ok FROM users
         WHERE id = ${actor.userId}::uuid AND role = 'ADMIN' AND archived_at IS NULL
           FOR SHARE`,
  )
  if (rows.length !== 1) throw new ForbiddenActorError()
}

export class CanonicalStateError extends Error {
  constructor(
    readonly code:
      'RECORD_NOT_LINKED' | 'RECORD_HAS_NO_REVISION' | 'OPPORTUNITY_NOT_FOUND' | 'TOKEN_NOT_FOUND',
  ) {
    super(code)
    this.name = 'CanonicalStateError'
  }
}

export type ResolveOutcome =
  | { recordId: string; kind: 'SKIPPED' }
  | { recordId: string; kind: 'ATTACH' | 'NEW'; opportunityId: string }
  /** `unclaimed`: new trusted keys KEEP refused to claim — the record no longer associates. */
  | { recordId: string; kind: 'KEEP'; opportunityId: string; unclaimed: readonly string[] }
  | { recordId: string; kind: 'CONFLICT'; opportunityId: string; owners: readonly string[] }

type Row = Record<string, unknown>

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

async function lockRecords(tx: SqlExecutor, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await tx.execute(
    sql`SELECT id FROM job_source_records WHERE id IN (${uuidList(ids)}) ORDER BY id FOR UPDATE`,
  )
}

/** Locks the opportunities by id ascending; returns the ids that exist. */
async function lockOpportunities(tx: SqlExecutor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { rows } = await tx.execute(
    sql`SELECT id FROM job_opportunities WHERE id IN (${uuidList(ids)}) ORDER BY id FOR UPDATE`,
  )
  return new Set(rows.map((r) => String(r['id'])))
}

function snapshotOf(r: Row): MemberSnapshot {
  const normalized = (r['normalized'] ?? {}) as Record<string, unknown>
  const original = (r['original_identity'] ?? {}) as Record<string, unknown>
  const tags = normalized['tags']
  return {
    recordId: String(r['record_id']),
    revisionId: String(r['revision_id']),
    receivedSeq: Number(r['received_seq']),
    receivedAt: toInstant(r['received_at']),
    provider: String(r['source_type']),
    namespace: String(r['namespace']),
    nativeId: typeof original['nativeId'] === 'string' ? original['nativeId'] : null,
    title: String(normalized['title'] ?? ''),
    companyName: String(normalized['companyName'] ?? ''),
    location: typeof normalized['location'] === 'string' ? normalized['location'] : null,
    sourceUrl: (r['source_url'] as string | null) ?? null,
    applicationUrl: (r['application_url'] as string | null) ?? null,
    descriptionSha256: (r['description_sha256'] as string | null) ?? null,
    publishedAt: typeof normalized['publishedAt'] === 'string' ? normalized['publishedAt'] : null,
    tags: Array.isArray(tags) ? tags.map(String) : [],
  }
}

const SNAPSHOT_COLUMNS = sql`r.id AS record_id, r.source_type, r.namespace, r.source_url, r.application_url,
  v.id AS revision_id, v.received_seq, v.received_at, v.normalized, v.original_identity, v.description_sha256`

async function snapshots(
  tx: SqlExecutor,
  ids: readonly string[],
): Promise<Map<string, MemberSnapshot>> {
  if (ids.length === 0) return new Map()
  const { rows } = await tx.execute(
    sql`SELECT ${SNAPSHOT_COLUMNS}
          FROM job_source_records r JOIN job_source_record_revisions v ON v.id = r.latest_revision_id
         WHERE r.id IN (${uuidList(ids)})`,
  )
  return new Map(rows.map((r) => [String(r['record_id']), snapshotOf(r)]))
}

/** The active members of an opportunity, read under its lock (links change only under it). */
async function members(tx: SqlExecutor, opportunityId: string): Promise<MemberSnapshot[]> {
  const { rows } = await tx.execute(
    sql`SELECT ${SNAPSHOT_COLUMNS}
          FROM job_opportunity_sources s
          JOIN job_source_records r ON r.id = s.source_record_id
          JOIN job_source_record_revisions v ON v.id = r.latest_revision_id
         WHERE s.opportunity_id = ${opportunityId}::uuid AND s.unlinked_at IS NULL
         ORDER BY r.id`,
  )
  return rows.map(snapshotOf)
}

type Link = ActiveLink & { linkId: string }

/** The active link of each record that has one, in one statement (CR-M-4). */
async function activeLinks(
  tx: SqlExecutor,
  recordIds: readonly string[],
): Promise<Map<string, Link>> {
  if (recordIds.length === 0) return new Map()
  const { rows } = await tx.execute(
    sql`SELECT id, source_record_id, opportunity_id, decision FROM job_opportunity_sources
         WHERE source_record_id IN (${uuidList(recordIds)}) AND unlinked_at IS NULL`,
  )
  return new Map(
    rows.map((r) => [
      String(r['source_record_id']),
      {
        linkId: String(r['id']),
        opportunityId: String(r['opportunity_id']),
        decision: r['decision'] === 'CONFIRMED' ? 'CONFIRMED' : 'AUTO',
      },
    ]),
  )
}

async function activeLink(tx: SqlExecutor, recordId: string): Promise<Link | null> {
  return (await activeLinks(tx, [recordId])).get(recordId) ?? null
}

/** token key -> owning opportunity, for the ACTIVE (unreleased) tokens that have an owner. */
async function tokenOwners(
  tx: SqlExecutor,
  tokens: readonly IdentityToken[],
): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map()
  const { rows } = await tx.execute(
    sql`SELECT token_key, opportunity_id FROM job_opportunity_identity_tokens
         WHERE namespace_kind = 'ATS_JOB_KEY' AND released_at IS NULL
           AND token_key IN (${sql.join(
             tokens.map((t) => sql`${t.key}`),
             sql`, `,
           )})`,
  )
  return new Map(rows.map((r) => [String(r['token_key']), String(r['opportunity_id'])]))
}

/**
 * Claim, for `opportunityId`, the CLAIMABLE tokens no one owns (SR-M-2: only the ATS's own adapter
 * claims its keys). A lost claim re-runs the transaction.
 */
async function claimTokens(
  tx: SqlExecutor,
  tokens: readonly IdentityToken[],
  owned: Map<string, string>,
  opportunityId: string,
  recordId: string,
): Promise<void> {
  const free = sortedUniqueIds(
    tokens.filter((t) => t.claimable && !owned.has(t.key)).map((t) => t.key),
  )
  for (const key of free) {
    const { rows } = await tx.execute(
      sql`INSERT INTO job_opportunity_identity_tokens
            (namespace_kind, token_key, opportunity_id, source_record_id, rule_version)
          VALUES ('ATS_JOB_KEY', ${key}, ${opportunityId}::uuid, ${recordId}::uuid, ${IDENTITY_RULES_VERSION})
          ON CONFLICT (namespace_kind, token_key) WHERE released_at IS NULL DO NOTHING
          RETURNING id`,
    )
    if (rows[0] === undefined) throw new RetryableRaceError('identity token claim')
  }
}

/** A text[] parameter, without drizzle spreading the JS array into a row constructor. */
const textArray = (values: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

const fieldValues = (c: CanonicalFields) => sql`
  title = ${c.title}, title_key = ${c.titleKey}, employer_name = ${c.employerName},
  employer_key = ${c.employerKey}, location = ${c.location}, application_url = ${c.applicationUrl},
  published_at = ${c.publishedAt}::timestamptz, description_sha256 = ${c.descriptionSha256},
  stack_keywords = ${textArray(c.stackKeywords)},
  field_revisions = ${JSON.stringify(c.fieldRevisions)}::jsonb`

async function enqueueOpportunity(tx: SqlExecutor, id: string, revision: number): Promise<void> {
  await tx.execute(
    sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
        VALUES ('OPPORTUNITY', ${id}::uuid, ${revision}, ${CANONICAL_REVISION_REASON})
        ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING`,
  )
}

/** A new opportunity from one member (the default: distinct). Revision 1, enqueued. */
async function createOpportunity(tx: SqlExecutor, m: MemberSnapshot): Promise<string> {
  const c = canonicalFields([m], null)
  const { rows } = await tx.execute(
    sql`INSERT INTO job_opportunities
          (title, title_key, employer_name, employer_key, location, application_url, published_at,
           description_sha256, stack_keywords, field_revisions)
        VALUES (${c.title}, ${c.titleKey}, ${c.employerName}, ${c.employerKey}, ${c.location},
                ${c.applicationUrl}, ${c.publishedAt}::timestamptz, ${c.descriptionSha256},
                ${textArray(c.stackKeywords)},
                ${JSON.stringify(c.fieldRevisions)}::jsonb)
        RETURNING id, revision`,
  )
  const row = rows[0] as Row
  await enqueueOpportunity(tx, String(row['id']), Number(row['revision']))
  return String(row['id'])
}

/**
 * Recompute an opportunity's canonical fields from its active members. `bump` (membership
 * changed) always advances the revision; otherwise only a real change does. Every advance
 * enqueues re-evaluation in this transaction. An opportunity left with no member keeps its
 * fields and advances its revision, so its matches go stale.
 */
async function refreshOpportunity(tx: SqlExecutor, id: string, bump: boolean): Promise<void> {
  const current = await members(tx, id)
  const { rows: titleRows } = await tx.execute(
    sql`SELECT title FROM job_opportunities WHERE id = ${id}::uuid`,
  )
  const previous = (titleRows[0]?.['title'] as string | undefined) ?? null
  const c = current.length === 0 ? null : canonicalFields(current, previous)
  const changed =
    c === null
      ? sql`false`
      : sql`(title, title_key, employer_name, employer_key, location, application_url, published_at,
             description_sha256, stack_keywords, field_revisions) IS DISTINCT FROM (${canonicalRow(c)})`
  const { rows } = await tx.execute(
    sql`UPDATE job_opportunities
           SET ${c === null ? sql`` : sql`${fieldValues(c)},`} revision = revision + 1,
               updated_at = clock_timestamp(), last_observed_at = clock_timestamp()
         WHERE id = ${id}::uuid ${bump ? sql`` : sql`AND ${changed}`}
     RETURNING revision`,
  )
  if (rows[0] !== undefined) await enqueueOpportunity(tx, id, Number(rows[0]['revision']))
}

/** The new values as one row constructor, typed like the columns, for IS DISTINCT FROM. */
const canonicalRow = (c: CanonicalFields) => sql`
  ${c.title}::text, ${c.titleKey}::text, ${c.employerName}::text, ${c.employerKey}::text,
  ${c.location}::text, ${c.applicationUrl}::text, ${c.publishedAt}::timestamptz,
  ${c.descriptionSha256}::text,
  ${textArray(c.stackKeywords)},
  ${JSON.stringify(c.fieldRevisions)}::jsonb`

async function insertLink(
  tx: SqlExecutor,
  recordId: string,
  opportunityId: string,
  decision: 'AUTO' | 'CONFIRMED',
  evidence: Record<string, unknown>,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, decision, evidence, rule_version)
        VALUES (${recordId}::uuid, ${opportunityId}::uuid, ${decision}::job_opportunity_link_decision,
                ${JSON.stringify(evidence)}::jsonb, ${IDENTITY_RULES_VERSION})`,
  )
}

async function unlink(tx: SqlExecutor, linkId: string, reason: string): Promise<void> {
  await tx.execute(
    sql`UPDATE job_opportunity_sources SET unlinked_at = clock_timestamp(), unlink_reason = ${reason.slice(0, REASON_MAX)}
         WHERE id = ${linkId}::uuid AND unlinked_at IS NULL`,
  )
}

/**
 * AUTO resolution of records whose latest revision changed (Task 4.6 calls it from the dirty
 * worker). Records are locked by id, then every opportunity the plan touches, by id; then each
 * record is decided by `decideAuto` with token owners re-read after the previous record's writes.
 * A record linked by an ADMIN (CONFIRMED) is never moved: a disagreeing token is reported as
 * CONFLICT and nothing is written for it.
 */
export async function resolveRecords(
  tx: SqlExecutor,
  recordIds: readonly string[],
): Promise<ResolveOutcome[]> {
  const ids = sortedUniqueIds(recordIds)
  await lockRecords(tx, ids)
  const snaps = await snapshots(tx, ids)
  // A record's link changes only under its lock, which this transaction holds: read once, in one
  // statement; the plan's token owners in one statement too (CR-M-4).
  const links = await activeLinks(tx, ids)
  const planOwners = await tokenOwners(tx, [...snaps.values()].flatMap(trustedTokens))
  const planned = [...[...links.values()].map((l) => l.opportunityId), ...planOwners.values()]
  const locked = await lockOpportunities(tx, sortedUniqueIds(planned))

  const outcomes: ResolveOutcome[] = []
  for (const id of decisionOrder(ids, snaps)) {
    const snap = snaps.get(id)
    if (snap === undefined) {
      outcomes.push({ recordId: id, kind: 'SKIPPED' })
      continue
    }
    const tokens = trustedTokens(snap)
    const link = links.get(id) ?? null
    // Re-read after the previous records' writes in this transaction (deliberate, per record).
    const owned = await tokenOwners(tx, tokens)
    const owners = sortedUniqueIds([...owned.values()])
    // An owner committed after the plan was read: lock it now (out of order, so a deadlock here
    // is the bounded-retry case).
    const late = owners.filter((o) => !locked.has(o))
    for (const o of await lockOpportunities(tx, late)) locked.add(o)
    const single = link === null && owners.length === 1 ? (owners[0] as string) : null
    const attach =
      single === null
        ? null
        : canAttach((await members(tx, single)).map(toResolverRecord), toResolverRecord(snap))
    const decision = decideAuto({ link, owners, attach })
    switch (decision.kind) {
      case 'CONFLICT':
        outcomes.push({ recordId: id, ...decision })
        break
      case 'KEEP': {
        // SR-M-2: new keys only after the same every-member check ATTACH passes.
        const others = (await members(tx, decision.opportunityId)).filter((m) => m.recordId !== id)
        const fresh = tokens.filter((t) => t.claimable && !owned.has(t.key))
        const mayClaim = keepMayClaim(others, snap)
        if (mayClaim) await claimTokens(tx, tokens, owned, decision.opportunityId, id)
        await refreshOpportunity(tx, decision.opportunityId, false)
        outcomes.push({
          recordId: id,
          kind: 'KEEP',
          opportunityId: decision.opportunityId,
          unclaimed: mayClaim ? [] : fresh.map((t) => t.key),
        })
        break
      }
      case 'ATTACH':
        await insertLink(tx, id, decision.opportunityId, 'AUTO', {
          actor: 'SYSTEM',
          rule: 'ATS_JOB_KEY',
          associations: decision.associations,
        })
        await claimTokens(tx, tokens, owned, decision.opportunityId, id)
        await refreshOpportunity(tx, decision.opportunityId, true)
        outcomes.push({ recordId: id, kind: 'ATTACH', opportunityId: decision.opportunityId })
        break
      case 'NEW': {
        const opportunityId = await createOpportunity(tx, snap)
        locked.add(opportunityId)
        await insertLink(tx, id, opportunityId, 'AUTO', {
          actor: 'SYSTEM',
          reason: decision.reason,
        })
        await claimTokens(tx, tokens, owned, opportunityId, id)
        outcomes.push({ recordId: id, kind: 'NEW', opportunityId })
        break
      }
    }
  }
  return outcomes
}

/** `resolveRecords` in its own short transaction, retried as a whole on contention. */
export function resolveRecordsTx(
  db: MeterDb,
  recordIds: readonly string[],
  { lockTimeoutMs = STORE_LOCK_TIMEOUT_MS } = {},
) {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      await setLockTimeout(tx, lockTimeoutMs)
      return resolveRecords(tx, recordIds)
    }, READ_COMMITTED),
  )
}

/**
 * ADMIN disposition: link a record to an opportunity as CONFIRMED, superseding whatever link it
 * had (AUTO or CONFIRMED). The old link is unlinked with the reason (history kept) and the new
 * one names the actor and the link it supersedes. Both opportunities get a new revision.
 */
export async function linkRecord(
  tx: SqlExecutor,
  actor: AdminActor,
  recordId: string,
  opportunityId: string,
  reason: string,
): Promise<void> {
  await assertAdmin(tx, actor)
  await lockRecords(tx, [recordId])
  const link = await activeLink(tx, recordId)
  const targets = sortedUniqueIds(
    link === null ? [opportunityId] : [opportunityId, link.opportunityId],
  )
  const exists = await lockOpportunities(tx, targets)
  if (!exists.has(opportunityId)) throw new CanonicalStateError('OPPORTUNITY_NOT_FOUND')
  if (link?.opportunityId === opportunityId && link.decision === 'CONFIRMED') return
  if (link !== null) await unlink(tx, link.linkId, `ADMIN_RELINK: ${reason}`)
  await insertLink(tx, recordId, opportunityId, 'CONFIRMED', {
    actor: actor.userId,
    action: 'LINK',
    reason: reason.slice(0, REASON_MAX),
    supersedes: link?.linkId ?? null,
  })
  await refreshOpportunity(tx, opportunityId, true)
  if (link !== null && link.opportunityId !== opportunityId)
    await refreshOpportunity(tx, link.opportunityId, true)
}

/**
 * ADMIN disposition: split a record off its opportunity into a new, distinct one (CONFIRMED, so
 * AUTO never re-merges it). The old link is kept as history, the payloads are untouched, the
 * trusted tokens stay with the old opportunity. Returns the new opportunity's id.
 */
export async function splitRecord(
  tx: SqlExecutor,
  actor: AdminActor,
  recordId: string,
  reason: string,
): Promise<string> {
  await assertAdmin(tx, actor)
  await lockRecords(tx, [recordId])
  const link = await activeLink(tx, recordId)
  if (link === null) throw new CanonicalStateError('RECORD_NOT_LINKED')
  const snap = (await snapshots(tx, [recordId])).get(recordId)
  if (snap === undefined) throw new CanonicalStateError('RECORD_HAS_NO_REVISION')
  await lockOpportunities(tx, [link.opportunityId])
  await unlink(tx, link.linkId, `ADMIN_SPLIT: ${reason}`)
  const opportunityId = await createOpportunity(tx, snap)
  await insertLink(tx, recordId, opportunityId, 'CONFIRMED', {
    actor: actor.userId,
    action: 'SPLIT',
    reason: reason.slice(0, REASON_MAX),
    supersedes: link.linkId,
  })
  await refreshOpportunity(tx, link.opportunityId, true)
  return opportunityId
}

/**
 * ADMIN disposition (SR-M-2): release an active identity token, so a squatted key can be claimed
 * again by the record that really owns it. The row stays as history, with when, who and why.
 */
export async function releaseToken(
  tx: SqlExecutor,
  actor: AdminActor,
  tokenKey: string,
  reason: string,
): Promise<void> {
  await assertAdmin(tx, actor)
  const { rows } = await tx.execute(
    sql`UPDATE job_opportunity_identity_tokens
           SET released_at = clock_timestamp(), released_by = ${actor.userId}::uuid,
               release_reason = ${reason.slice(0, REASON_MAX)}
         WHERE namespace_kind = 'ATS_JOB_KEY' AND token_key = ${tokenKey} AND released_at IS NULL
     RETURNING opportunity_id`,
  )
  const owner = rows[0]?.['opportunity_id']
  if (owner === undefined) throw new CanonicalStateError('TOKEN_NOT_FOUND')
  await lockOpportunities(tx, [String(owner)])
  await refreshOpportunity(tx, String(owner), true)
}
