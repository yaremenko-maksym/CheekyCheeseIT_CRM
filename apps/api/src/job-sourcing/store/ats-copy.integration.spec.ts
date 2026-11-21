import { randomUUID } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import {
  LedgerFixtures,
  LedgerKit,
  SpecCatalog,
  handleOf,
  specCheckpoint,
  specRegistry,
} from '../../test/ledger-fixtures'
import { type ObservationSeed, cleanupStore, observation } from '../../test/record-store-fixtures'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { IDENTITY_RULES_VERSION } from '../identity/resolver'
import { IDENTITY_REKEY_REASON, enqueueIdentityRekey } from '../ownership/dirty-work.store'
import { JobRunLedger } from '../ownership/job-run-ledger'
import type { RunHandle } from '../ownership/run-ownership'
import { type AdminActor, asAdminActor, resolveRecordsTx, splitRecord } from './canonical.store'
import { saveObservationPage } from './source-record.store'

/**
 * Task sources-18 against real Postgres, as `crm_app`: an aggregator copy and the employer's own
 * ATS posting of one job become ONE opportunity (ATS_COPY), in either order, and every false-merge
 * guard ends with two. Each case has its own company and title, so no case sees another's records.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `t3spec-${TAG}`
const LEVER: JobSourceType = 'LEVER_ATS'
const ASHBY: JobSourceType = 'ASHBY_ATS'
const GH: JobSourceType = 'GREENHOUSE_ATS'
const HUB: JobSourceType = 'THEHUB_HTML'
const NOFLUFF: JobSourceType = 'NOFLUFF_HTML'
const NLJ: JobSourceType = 'NEXTLEVELJOBS_HTML'
const DJINNI: JobSourceType = 'DJINNI_RSS'
const TYPES = [LEVER, ASHBY, GH, HUB, NOFLUFF, NLJ, DJINNI]

let session: CrmAppSession
let fx: LedgerFixtures
let kit: LedgerKit
let admin: AdminActor
let db: ReturnType<typeof drizzle<typeof schema>>
const runs = new Map<JobSourceType, RunHandle>()
let seq = 0
let n = 0

async function runFor(type: JobSourceType): Promise<RunHandle> {
  const existing = runs.get(type)
  if (existing !== undefined) return existing
  const h = handleOf(await kit.claimOne(await kit.reporting({ type })))
  runs.set(type, h)
  return h
}

async function record(seed: Omit<ObservationSeed, 'tag'>): Promise<string> {
  const o = observation({ ...seed, tag: TAG })
  seq += 1
  const [saved] = await saveObservationPage(db, await runFor(o.identity.provider), {
    observations: [o],
    checkpoint: specCheckpoint(seq),
  })
  return saved?.recordId as string
}

/** A fresh company and title per case: the candidate keys are the company and the title. */
function newCase() {
  n += 1
  return { company: `${PREFIX} Co ${n}`, title: `Go Engineer ${n}`, slug: `${PREFIX}-b${n}` }
}

const uuid = () => randomUUID()
const leverUrl = (slug: string, job: string) => `https://jobs.lever.co/${slug}/${job}`

function leverRecord(c: ReturnType<typeof newCase>, over: Partial<ObservationSeed> = {}) {
  const job = uuid()
  return record({
    provider: LEVER,
    namespace: `lever:global:${c.slug}`,
    nativeId: job,
    company: c.company,
    title: c.title,
    postingUrl: leverUrl(c.slug, job),
    ...over,
  })
}

function copyRecord(
  c: ReturnType<typeof newCase>,
  provider: JobSourceType = HUB,
  over: Partial<ObservationSeed> = {},
) {
  return record({
    provider,
    namespace: `${PREFIX}-${provider.toLowerCase()}`,
    nativeId: uuid(),
    company: c.company,
    title: c.title,
    ...over,
  })
}

async function resolveOne(id: string) {
  const [outcome] = await resolveRecordsTx(db, [id])
  return outcome
}

async function linkOf(recordId: string) {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id, decision, evidence, rule_version FROM job_opportunity_sources
      WHERE source_record_id = $1 AND unlinked_at IS NULL`,
    [recordId],
  )
  return rows[0] as
    | {
        opportunity_id: string
        decision: string
        evidence: Record<string, unknown>
        rule_version: string
      }
    | undefined
}

const opportunityOf = async (recordId: string) => (await linkOf(recordId))?.opportunity_id

async function tokenOwnersOf(
  recordId: string,
): Promise<{ opportunity_id: string; rule_version: string }[]> {
  const { rows } = await session.admin.query(
    `SELECT opportunity_id, rule_version FROM job_opportunity_identity_tokens
      WHERE released_at IS NULL AND source_record_id = $1`,
    [recordId],
  )
  return rows as { opportunity_id: string; rule_version: string }[]
}

describe.skipIf(!hasDatabaseUrl())('sources-18: ATS_COPY dedup (real Postgres)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, TAG)
    const catalog = new SpecCatalog()
    db = drizzle(session.pool, { schema })
    const ledger = new JobRunLedger(db, specRegistry(TYPES), catalog)
    const { rows: users } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'sources-18 spec', 'ADMIN') RETURNING id`,
      [`s18-${TAG}@example.test`],
    )
    kit = new LedgerKit(ledger, fx, catalog, users[0].id as string)
    admin = asAdminActor({ id: kit.actor, role: 'ADMIN' })
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await cleanupStore(session.admin, PREFIX, TAG)
      await fx.cleanup()
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [kit.actor])
    } finally {
      await session.close()
    }
  })

  it('AC 2 + 8 (a): ATS first, then a The Hub copy: one opportunity, the copy linked by ATS_COPY', async () => {
    const c = newCase()
    const a = await leverRecord(c)
    expect(await resolveOne(a)).toMatchObject({ kind: 'NEW' })
    const h = await copyRecord(c)
    const opp = await opportunityOf(a)
    expect(await resolveOne(h)).toEqual({ recordId: h, kind: 'ATTACH', opportunityId: opp })
    const link = await linkOf(h)
    expect(link?.decision).toBe('AUTO')
    expect(link?.evidence).toMatchObject({ actor: 'SYSTEM', rule: 'ATS_COPY' })
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM job_opportunity_sources WHERE opportunity_id = $1 AND unlinked_at IS NULL`,
      [opp],
    )
    expect(rows[0].n).toBe(2)
    // AC 8: new links and tokens carry the v2 rules.
    expect(link?.rule_version).toBe(IDENTITY_RULES_VERSION)
    expect((await linkOf(a))?.rule_version).toBe('identity-rules-v2')
    expect(await tokenOwnersOf(a)).toEqual([
      { opportunity_id: opp, rule_version: 'identity-rules-v2' },
    ])
    // A re-resolve keeps both where they are.
    expect(await resolveOne(h)).toMatchObject({ kind: 'KEEP', opportunityId: opp })
  })

  it('AC 3 (b): a No Fluff copy, then the Lever record: one opportunity, the ATS fields win', async () => {
    const c = newCase()
    const copy = await copyRecord(c, NOFLUFF, { title: c.title.replace(' ', '-'), location: null })
    expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
    // An HR action made now references this opportunity id; the ATS record must join it, not replace it.
    const opp = await opportunityOf(copy)
    const a = await leverRecord(c, {
      location: 'Berlin',
      applicationUrl: 'https://jobs.lever.co/x/apply',
    })
    expect(await resolveOne(a)).toEqual({ recordId: a, kind: 'ATTACH', opportunityId: opp })
    expect(await tokenOwnersOf(a)).toEqual([
      { opportunity_id: opp, rule_version: 'identity-rules-v2' },
    ])
    const { rows } = await session.admin.query(
      `SELECT title, location, application_url FROM job_opportunities WHERE id = $1`,
      [opp],
    )
    expect(rows[0]).toEqual({
      title: c.title,
      location: 'Berlin',
      application_url: 'https://jobs.lever.co/x/apply',
    })
  })

  describe('AC 4 (c): a copy carrying the ATS button, both orders', () => {
    const ashby = () => {
      const c = newCase()
      const job = uuid()
      const nlj = () =>
        copyRecord(c, NLJ, {
          // The employer's apply button names the org by UUID; the board names it by slug.
          postingUrl: `https://jobs.ashbyhq.com/${uuid()}/${job}`,
          applicationUrl: `https://jobs.ashbyhq.com/${uuid()}/${job}`,
        })
      const ats = () =>
        record({
          provider: ASHBY,
          namespace: `ashby:${c.slug}`,
          nativeId: job,
          company: c.company,
          title: c.title,
          postingUrl: `https://jobs.ashbyhq.com/${c.slug}/${job}`,
        })
      return { nlj, ats }
    }
    const greenhouse = () => {
      const c = newCase()
      const job = String(700_000 + n)
      const url = `https://boards.greenhouse.io/${c.slug}/jobs/${job}`
      return {
        nlj: () => copyRecord(c, NLJ, { postingUrl: url, applicationUrl: url }),
        ats: () =>
          record({
            provider: GH,
            namespace: `greenhouse:${c.slug}`,
            nativeId: job,
            company: c.company,
            title: c.title,
            postingUrl: url,
          }),
      }
    }

    for (const [vendor, make] of [
      ['Ashby', ashby],
      ['Greenhouse', greenhouse],
    ] as const) {
      it(`${vendor}: the copy first, then the ATS record`, async () => {
        const m = make()
        const copy = await m.nlj()
        expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
        const a = await m.ats()
        expect(await resolveOne(a)).toMatchObject({
          kind: 'ATTACH',
          opportunityId: await opportunityOf(copy),
        })
        expect(await tokenOwnersOf(a)).toEqual([
          { opportunity_id: await opportunityOf(copy), rule_version: 'identity-rules-v2' },
        ])
        expect(await resolveOne(copy)).toMatchObject({ kind: 'KEEP' })
      })

      it(`${vendor}: the ATS record first, then the copy`, async () => {
        const m = make()
        const a = await m.ats()
        expect(await resolveOne(a)).toMatchObject({ kind: 'NEW' })
        const copy = await m.nlj()
        expect(await resolveOne(copy)).toMatchObject({
          kind: 'ATTACH',
          opportunityId: await opportunityOf(a),
        })
      })
    }
  })

  describe('AC 5: false-merge guards end with two opportunities', () => {
    it('(i) a copy, then a board running the title three times: no attach, all apart', async () => {
      const c = newCase()
      const copy = await copyRecord(c)
      await resolveOne(copy)
      const boards = [await leverRecord(c), await leverRecord(c), await leverRecord(c)]
      const outcomes = await resolveRecordsTx(db, boards)
      expect(outcomes.map((o) => o.kind)).toEqual(['NEW', 'NEW', 'NEW'])
      const opps = new Set(await Promise.all([copy, ...boards].map(opportunityOf)))
      expect(opps.size).toBe(4)
      expect((await linkOf(boards[0]!))?.evidence).toMatchObject({ reason: 'ATS_COPY_SIBLING' })
    })

    it('(ii) two opportunities each with one ATS job of the same title, then a copy: ambiguous', async () => {
      const c = newCase()
      const a1 = await leverRecord(c)
      const a2 = await leverRecord({ ...c, slug: `${c.slug}-2` })
      await resolveRecordsTx(db, [a1, a2])
      expect(await opportunityOf(a1)).not.toBe(await opportunityOf(a2))
      const copy = await copyRecord(c)
      expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
      expect((await linkOf(copy))?.evidence).toMatchObject({ reason: 'ATS_COPY_AMBIGUOUS' })
    })

    it('(iii) a copy whose location contradicts the ATS posting', async () => {
      const c = newCase()
      const a = await leverRecord(c, { location: 'Berlin' })
      await resolveOne(a)
      const copy = await copyRecord(c, HUB, { location: 'Lisbon' })
      expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(copy)).not.toBe(await opportunityOf(a))
    })

    it('(iv) an ATS record last observed more than 14 days before the copy was first seen', async () => {
      const c = newCase()
      const a = await leverRecord(c)
      await resolveOne(a)
      await session.admin.query(
        `UPDATE job_source_records SET first_seen_at = now() - interval '40 days',
                last_observed_at = now() - interval '15 days' WHERE id = $1`,
        [a],
      )
      const copy = await copyRecord(c)
      expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(copy)).not.toBe(await opportunityOf(a))
    })

    it('(v) two aggregator copies with no ATS record (copy-copy is out of scope)', async () => {
      const c = newCase()
      const h = await copyRecord(c)
      await resolveOne(h)
      const f = await copyRecord(c, NOFLUFF)
      expect(await resolveOne(f)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(f)).not.toBe(await opportunityOf(h))
    })

    it('(vi) a Djinni record (employer withheld)', async () => {
      const c = newCase()
      const a = await leverRecord(c)
      await resolveOne(a)
      const d = await copyRecord(c, DJINNI, { employerWithheld: true })
      expect(await resolveOne(d)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(d)).not.toBe(await opportunityOf(a))
    })

    it('(vii) a record an ADMIN split earlier is never re-merged', async () => {
      const c = newCase()
      const a = await leverRecord(c)
      await resolveOne(a)
      const copy = await copyRecord(c)
      expect(await resolveOne(copy)).toMatchObject({ kind: 'ATTACH' })
      const split = await db.transaction((tx) => splitRecord(tx, admin, copy, 'different opening'))
      expect(await resolveOne(copy)).toMatchObject({ kind: 'KEEP', opportunityId: split })
      // Even unlinked, the split record does not rejoin: it opens its own opportunity.
      await session.admin.query(
        `UPDATE job_opportunity_sources SET unlinked_at = clock_timestamp(), unlink_reason = 'spec: unlinked'
          WHERE source_record_id = $1 AND unlinked_at IS NULL`,
        [copy],
      )
      expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(copy)).not.toBe(await opportunityOf(a))
      // And the ATS record's opportunity, which held the split record, takes no new copy either.
      const other = await copyRecord(c, NOFLUFF)
      expect(await resolveOne(other)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(other)).not.toBe(await opportunityOf(a))
    })

    it('(viii) an opportunity with a CONFIRMED link', async () => {
      const c = newCase()
      const a = await leverRecord(c)
      await resolveOne(a)
      await session.admin.query(
        `UPDATE job_opportunity_sources SET decision = 'CONFIRMED'
          WHERE source_record_id = $1 AND unlinked_at IS NULL`,
        [a],
      )
      const copy = await copyRecord(c)
      expect(await resolveOne(copy)).toMatchObject({ kind: 'NEW' })
      expect(await opportunityOf(copy)).not.toBe(await opportunityOf(a))
    })
  })

  it('AC 7: the boot rekey re-resolves a linked Ashby record onto the new key, once', async () => {
    const c = newCase()
    const job = uuid()
    const rec = await record({
      provider: ASHBY,
      namespace: `ashby:${c.slug}`,
      nativeId: job,
      company: c.company,
      title: c.title,
      postingUrl: `https://jobs.ashbyhq.com/${c.slug}/${job}`,
    })
    const lever = await leverRecord(newCase())
    expect((await resolveOne(rec))?.kind).toBe('NEW')
    expect((await resolveOne(lever))?.kind).toBe('NEW')
    const opp = await opportunityOf(rec)
    const [token] = (
      await session.admin.query(
        `SELECT token_key FROM job_opportunity_identity_tokens
          WHERE released_at IS NULL AND source_record_id = $1`,
        [rec],
      )
    ).rows as { token_key: string }[]
    expect(token?.token_key).toContain(job)
    // The state before sources-18: the opportunity holds only the old slug-scoped key.
    await session.admin.query(
      `UPDATE job_opportunity_identity_tokens SET token_key = $2
        WHERE released_at IS NULL AND source_record_id = $1`,
      [rec, `${c.slug}|${job}`],
    )
    const rekeyRows = async (id: string) =>
      (
        await session.admin.query(
          `SELECT d.status, d.target_version = h.observation_seq AS at_head
             FROM job_dirty_work d JOIN job_source_record_heads h ON h.source_record_id = d.entity_id
            WHERE d.entity_kind = 'SOURCE_RECORD' AND d.entity_id = $1 AND d.reason = $2`,
          [id, IDENTITY_REKEY_REASON],
        )
      ).rows as { status: string; at_head: boolean }[]
    try {
      expect(await enqueueIdentityRekey(db)).toBeGreaterThanOrEqual(1)
      expect(await rekeyRows(rec)).toEqual([{ status: 'PENDING', at_head: true }])
      expect(await rekeyRows(lever)).toEqual([])
      await enqueueIdentityRekey(db)
      expect(await rekeyRows(rec)).toHaveLength(1)
      // The drain: the recompute worker resolves a SOURCE_RECORD row with `resolveRecords`.
      expect((await resolveOne(rec))?.kind).toBe('KEEP')
      expect(await opportunityOf(rec)).toBe(opp)
      const { rows } = await session.admin.query(
        `SELECT opportunity_id FROM job_opportunity_identity_tokens
          WHERE released_at IS NULL AND token_key = $1`,
        [token?.token_key],
      )
      expect(rows).toEqual([{ opportunity_id: opp }])
    } finally {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE reason = $1`, [
        IDENTITY_REKEY_REASON,
      ])
    }
  })

  it('concurrent resolves of one copy link it once', async () => {
    const c = newCase()
    const a = await leverRecord(c)
    await resolveOne(a)
    const copy = await copyRecord(c)
    const outcomes = await Promise.all([resolveOne(copy), resolveOne(copy)])
    expect(outcomes.map((o) => o?.kind).sort()).toEqual(['ATTACH', 'KEEP'])
    const { rows } = await session.admin.query(
      `SELECT count(*)::int AS n FROM job_opportunity_sources WHERE source_record_id = $1 AND unlinked_at IS NULL`,
      [copy],
    )
    expect(rows[0].n).toBe(1)
  })
})
