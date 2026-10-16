import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * r5 Task 1.2 (part 1) — the `job_opportunities` store against the REAL
 * Postgres catalog. Every UNIQUE / partial UNIQUE / CHECK / FK / default is
 * proven by inserting and expecting the database itself to accept or reject;
 * nothing here reads Drizzle metadata (that is `job-opportunities-schema.spec.ts`,
 * the unit twin the mutation gate can see).
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_jobopp \
 *     pnpm --filter @crm/api test -- job-opportunities.integration
 *
 * The Drizzle-vs-forward-SQL catalog comparison belongs to Task 1.3 (no forward
 * SQL exists yet) and is intentionally not done here.
 */

const TAG = `it1011-${randomUUID().slice(0, 8)}`
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)

let pool: Pool

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

/** Run a statement that MUST be rejected; return the Postgres error code + constraint. */
async function rejected(text: string, params: unknown[] = []) {
  try {
    await pool.query(text, params)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    return { code: err.code, constraint: err.constraint }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const INVALID_ENUM = '22P02'

let seq = 0
async function newRecord(extra: { namespace?: string; key?: string } = {}): Promise<string> {
  seq += 1
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2) RETURNING id`,
    [extra.namespace ?? `${TAG}-ns`, extra.key ?? `${TAG}-k${seq}`],
  )
  return rows[0].id as string
}
async function newOpportunity(): Promise<string> {
  seq += 1
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [`${TAG} title ${seq}`],
  )
  return rows[0].id as string
}
async function newUser(): Promise<string> {
  seq += 1
  const { rows } = await q(
    `INSERT INTO users (email, display_name, role) VALUES ($1, $2, 'ADMIN') RETURNING id`,
    [`${TAG}-${seq}@test.spec`, `${TAG} user ${seq}`],
  )
  return rows[0].id as string
}
async function newTeam(): Promise<string> {
  seq += 1
  const { rows } = await q(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [
    `${TAG} team ${seq}`,
  ])
  return rows[0].id as string
}

describe.skipIf(!hasDatabaseUrl())('job_opportunities store (real Postgres catalog)', () => {
  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_source_records', column: 'identity_key' },
      { table: 'job_opportunity_team_triage', column: 'grant_version' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db')
    // Writing spec: refuse the live database outright (the vitest guard does too).
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
  })

  afterAll(async () => {
    if (!pool) return
    // Children first: link history is RESTRICT by design.
    await q(
      `DELETE FROM job_opportunity_sources WHERE source_record_id IN
         (SELECT id FROM job_source_records WHERE namespace LIKE $1)`,
      [`${TAG}%`],
    )
    await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_source_records WHERE namespace LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_text_blobs WHERE text LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    await pool.end()
  })

  describe('stored URLs: https with a host, no whitespace, no credentials', () => {
    const BAD = [
      'https://',
      'https:///path',
      'https:// example.com',
      'https://exa mple.com/x',
      'https://example.com/a b',
      'https://user:pass@example.com/x',
      'https://user@example.com',
      'https://@example.com',
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.com',
      '//example.com',
      'example.com',
    ]
    const GOOD = [
      'https://example.com',
      'HTTPS://Example.COM/Path',
      'https://example.com/a?b=c#d',
      'https://example.com:8443/x',
      'https://example.com/in/@handle',
      'https://example.com?next=a@b',
    ]
    const recordColumns = ['original_url', 'display_url', 'source_url', 'application_url']

    for (const column of recordColumns) {
      it(`job_source_records.${column} rejects every bad form and accepts valid ones`, async () => {
        for (const url of BAD) {
          const r = await rejected(
            `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, ${column})
             VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3)`,
            [`${TAG}-url`, randomUUID(), url],
          )
          expect(r, `${column} must reject ${url}`).toEqual({
            code: CHECK_VIOLATION,
            constraint: `ck_job_source_records_${column}_https`,
          })
        }
        for (const url of GOOD) {
          await q(
            `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, ${column})
             VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3)`,
            [`${TAG}-url`, randomUUID(), url],
          )
        }
        await q(
          `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, ${column})
           VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, NULL)`,
          [`${TAG}-url`, randomUUID()],
        )
      })
    }

    it('job_opportunities.application_url rejects every bad form and accepts valid ones', async () => {
      for (const url of BAD) {
        const r = await rejected(
          `INSERT INTO job_opportunities (title, title_key, application_url) VALUES ($1, $1, $2)`,
          [`${TAG} url`, url],
        )
        expect(r, `application_url must reject ${url}`).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_opportunities_application_url_https',
        })
      }
      for (const url of GOOD) {
        await q(
          `INSERT INTO job_opportunities (title, title_key, application_url) VALUES ($1, $1, $2)`,
          [`${TAG} url`, url],
        )
      }
    })
  })

  describe('job_source_records identity', () => {
    it('rejects an empty or whitespace-only identity_key', async () => {
      for (const key of ['', '   ', '\t\n']) {
        const r = await rejected(
          `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
           VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2)`,
          [`${TAG}-ident`, key],
        )
        expect(r).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_source_records_identity_key_nonempty',
        })
      }
    })

    it('UNIQUE(source_type, namespace, identity_key): the same native job is one record, scopes stay apart', async () => {
      const ns = `${TAG}-uq`
      const first = await newRecord({ namespace: ns, key: 'job-1' })
      const dup = await rejected(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', 'job-1')`,
        [ns],
      )
      expect(dup).toEqual({ code: UNIQUE_VIOLATION, constraint: 'uq_job_source_records_identity' })
      // Different namespace OR different provider => a different record.
      const otherNs = await newRecord({ namespace: `${ns}-other`, key: 'job-1' })
      const { rows } = await q(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('LEVER_ATS', $1, 'NATIVE_ID', 'job-1') RETURNING id`,
        [ns],
      )
      expect(new Set([first, otherNs, rows[0].id]).size).toBe(3)
    })

    it('two discovery configs observing one native posting resolve to ONE record and ONE revision', async () => {
      const ns = `${TAG}-disc`
      const upsert = (config: string) =>
        q(
          `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
           VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', 'native-42')
           ON CONFLICT (source_type, namespace, identity_key)
             DO UPDATE SET last_observed_at = now()
           RETURNING id, $2::text AS seen_by`,
          [ns, config],
        )
      const a = await upsert('config-A')
      const b = await upsert('config-B')
      expect(b.rows[0].id).toBe(a.rows[0].id)
      const { rows: count } = await q(
        `SELECT count(*)::int AS n FROM job_source_records WHERE namespace = $1`,
        [ns],
      )
      expect(count[0].n).toBe(1)

      const observe = () =>
        q(
          `INSERT INTO job_source_record_revisions
             (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
           VALUES ($1, 'a1', 'n1', $2, '{}', '{}')
           ON CONFLICT (source_record_id, normalizer_version, content_hash) DO NOTHING
           RETURNING id`,
          [a.rows[0].id, HEX_A],
        )
      expect((await observe()).rowCount).toBe(1)
      expect((await observe()).rowCount).toBe(0)
      const { rows: revs } = await q(
        `SELECT count(*)::int AS n FROM job_source_record_revisions WHERE source_record_id = $1`,
        [a.rows[0].id],
      )
      expect(revs[0].n).toBe(1)
    })

    it('applies defaults: namespace is never NULL, availability UNKNOWN, evidence {}', async () => {
      const { rows } = await q(
        `INSERT INTO job_source_records (source_type, identity_kind, identity_key)
         VALUES ('DOU_RSS', 'URL_FALLBACK', $1) RETURNING namespace, availability, availability_evidence`,
        [`https://example.com/${TAG}`],
      )
      expect(rows[0]).toEqual({ namespace: '', availability: 'UNKNOWN', availability_evidence: {} })
      await q(`DELETE FROM job_source_records WHERE identity_key = $1`, [
        `https://example.com/${TAG}`,
      ])
      const nullNs = await rejected(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('DOU_RSS', NULL, 'URL_FALLBACK', 'x')`,
      )
      expect(nullNs.code).toBe('23502')
    })

    it('rejects values outside the enums', async () => {
      const kind = await rejected(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('GREENHOUSE_ATS', $1, 'MYSTERY', 'x')`,
        [`${TAG}-enum`],
      )
      expect(kind.code).toBe(INVALID_ENUM)
      const type = await rejected(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
         VALUES ('NOPE_API', $1, 'NATIVE_ID', 'x')`,
        [`${TAG}-enum`],
      )
      expect(type.code).toBe(INVALID_ENUM)
      const avail = await rejected(
        `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, availability)
         VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', 'x', 'MAYBE')`,
        [`${TAG}-enum`],
      )
      expect(avail.code).toBe(INVALID_ENUM)
    })
  })

  describe('job_text_blobs and revisions', () => {
    it('sha256 must be 64 lowercase hex', async () => {
      for (const bad of [
        '',
        'abc',
        'A'.repeat(64),
        'g'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
      ]) {
        const r = await rejected(`INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2)`, [
          bad,
          `${TAG} blob`,
        ])
        expect(r).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_text_blobs_sha256_hex' })
      }
    })

    it('content-addressed: the same hash is stored once', async () => {
      await q(`INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2)`, [HEX_B, `${TAG} blob`])
      const dup = await rejected(`INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2)`, [
        HEX_B,
        `${TAG} blob`,
      ])
      expect(dup.code).toBe(UNIQUE_VIOLATION)
    })

    it('revision content_hash must be 64 lowercase hex; description must reference an existing blob', async () => {
      const rec = await newRecord()
      const badHash = await rejected(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'a', 'n', 'XYZ', '{}', '{}')`,
        [rec],
      )
      expect(badHash).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_source_record_revisions_content_hash_hex',
      })
      const noBlob = await rejected(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity, description_sha256)
         VALUES ($1, 'a', 'n', $2, '{}', '{}', $3)`,
        [rec, HEX_A, 'f'.repeat(64)],
      )
      expect(noBlob).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_source_record_revisions_description',
      })
    })

    it('a referenced text blob cannot be deleted (RESTRICT) from either referencing table', async () => {
      await q(`INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        HEX_C,
        `${TAG} restrict blob`,
      ])
      const rec = await newRecord()
      await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity, description_sha256)
         VALUES ($1, 'a', 'n', $2, '{}', '{}', $3)`,
        [rec, HEX_C, HEX_C],
      )
      const opp = await newOpportunity()
      await q(`UPDATE job_opportunities SET description_sha256 = $2 WHERE id = $1`, [opp, HEX_C])
      expect((await rejected(`DELETE FROM job_text_blobs WHERE sha256 = $1`, [HEX_C])).code).toBe(
        FK_VIOLATION,
      )
    })

    it('revision UNIQUE(record, normalizer_version, content_hash): same content under a NEW normalizer is a new revision', async () => {
      const rec = await newRecord()
      const ins = (normalizer: string, hash: string) =>
        q(
          `INSERT INTO job_source_record_revisions
             (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
           VALUES ($1, 'a', $2, $3, '{}', '{}')`,
          [rec, normalizer, hash],
        )
      await ins('n1', HEX_A)
      const dup = await rejected(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'a-other-adapter', 'n1', $2, '{}', '{}')`,
        [rec, HEX_A],
      )
      expect(dup).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_source_record_revisions_content',
      })
      await ins('n2', HEX_A)
    })

    it('out-of-order revisions: received_seq follows ARRIVAL, not the provider publish date', async () => {
      const rec = await newRecord()
      const ins = (hash: string, published: string) =>
        q(
          `INSERT INTO job_source_record_revisions
             (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity, published_at)
           VALUES ($1, 'a', 'n', $2, '{}', '{}', $3) RETURNING id, received_seq::int AS seq`,
          [rec, hash, published],
        )
      const newer = await ins('1'.repeat(64), '2026-10-10T00:00:00Z')
      const older = await ins('2'.repeat(64), '2026-01-01T00:00:00Z') // arrives LATER, published EARLIER
      expect(older.rows[0].seq).toBeGreaterThan(newer.rows[0].seq)
      const { rows } = await q(
        `SELECT id FROM job_source_record_revisions WHERE source_record_id = $1
         ORDER BY received_seq DESC LIMIT 1`,
        [rec],
      )
      expect(rows[0].id).toBe(older.rows[0].id)
      // received_seq is GENERATED ALWAYS: callers cannot forge arrival order.
      const forged = await rejected(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity, received_seq)
         VALUES ($1, 'a', 'n', $2, '{}', '{}', 1)`,
        [rec, '3'.repeat(64)],
      )
      expect(forged.code).toBe('428C9')
    })

    it('latest_revision_id points at a real revision and falls back to NULL when it is deleted', async () => {
      const rec = await newRecord()
      const bogus = await rejected(
        `UPDATE job_source_records SET latest_revision_id = $2 WHERE id = $1`,
        [rec, randomUUID()],
      )
      expect(bogus).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_source_records_latest_revision',
      })
      const { rows } = await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'a', 'n', $2, '{}', '{}') RETURNING id`,
        [rec, '4'.repeat(64)],
      )
      await q(`UPDATE job_source_records SET latest_revision_id = $2 WHERE id = $1`, [
        rec,
        rows[0].id,
      ])
      await q(`DELETE FROM job_source_record_revisions WHERE id = $1`, [rows[0].id])
      const { rows: after } = await q(
        `SELECT latest_revision_id FROM job_source_records WHERE id = $1`,
        [rec],
      )
      expect(after[0].latest_revision_id).toBeNull()
    })

    it('deleting a source record cascades its revisions', async () => {
      const rec = await newRecord()
      await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'a', 'n', $2, '{}', '{}')`,
        [rec, '5'.repeat(64)],
      )
      await q(`DELETE FROM job_source_records WHERE id = $1`, [rec])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_source_record_revisions WHERE source_record_id = $1`,
        [rec],
      )
      expect(rows[0].n).toBe(0)
    })

    it('normalized and original_identity are mandatory; provenance/evidence default to {}', async () => {
      const rec = await newRecord()
      const missing = await rejected(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, original_identity)
         VALUES ($1, 'a', 'n', $2, '{}')`,
        [rec, '6'.repeat(64)],
      )
      expect(missing.code).toBe('23502')
      const { rows } = await q(
        `INSERT INTO job_source_record_revisions
           (source_record_id, adapter_version, normalizer_version, content_hash, normalized, original_identity)
         VALUES ($1, 'a', 'n', $2, '{}', '{}') RETURNING field_provenance, evidence`,
        [rec, '6'.repeat(64)],
      )
      expect(rows[0]).toEqual({ field_provenance: {}, evidence: {} })
    })
  })

  describe('job_opportunities', () => {
    it('applies defaults', async () => {
      const id = await newOpportunity()
      const { rows } = await q(
        `SELECT availability, seniority, stack_keywords, revision, employer_verified, field_revisions
           FROM job_opportunities WHERE id = $1`,
        [id],
      )
      expect(rows[0]).toEqual({
        availability: 'UNKNOWN',
        seniority: 'UNKNOWN',
        stack_keywords: [],
        revision: 1,
        employer_verified: false,
        field_revisions: {},
      })
    })

    it('revision must be positive', async () => {
      for (const revision of [0, -1]) {
        const r = await rejected(
          `INSERT INTO job_opportunities (title, title_key, revision) VALUES ($1, $1, $2)`,
          [`${TAG} rev`, revision],
        )
        expect(r).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_opportunities_revision_positive',
        })
      }
    })

    it('a verified employer must carry an employer_key', async () => {
      const r = await rejected(
        `INSERT INTO job_opportunities (title, title_key, employer_verified) VALUES ($1, $1, true)`,
        [`${TAG} verified`],
      )
      expect(r).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_opportunities_verified_has_key',
      })
      await q(
        `INSERT INTO job_opportunities (title, title_key, employer_verified, employer_key)
         VALUES ($1, $1, true, 'acme')`,
        [`${TAG} verified ok`],
      )
    })

    it('deliberately has NO unique company/title: two real openings may share both', async () => {
      const ins = () =>
        q(
          `INSERT INTO job_opportunities (title, title_key, employer_key) VALUES ($1, 'same', 'acme') RETURNING id`,
          [`${TAG} twin`],
        )
      const a = await ins()
      const b = await ins()
      expect(a.rows[0].id).not.toBe(b.rows[0].id)
    })
  })

  describe('job_opportunity_sources: association split with preserved history', () => {
    it('one ACTIVE owner per record; unlinked rows are history; relinking elsewhere keeps the trail', async () => {
      const rec1 = await newRecord()
      const rec2 = await newRecord()
      const oppA = await newOpportunity()
      const oppB = await newOpportunity()
      const link = (rec: string, opp: string) =>
        q(
          `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
           VALUES ($1, $2, 'r1') RETURNING id, decision`,
          [rec, opp],
        )

      const l1 = await link(rec1, oppA)
      const l2 = await link(rec2, oppA)
      expect(l1.rows[0].decision).toBe('AUTO')

      // A second ACTIVE owner for the same record is rejected, even for another opportunity.
      const second = await rejected(
        `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
         VALUES ($1, $2, 'r1')`,
        [rec2, oppB],
      )
      expect(second).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_opportunity_sources_active_record',
      })

      // unlinked_at and unlink_reason move together.
      const half = await rejected(
        `UPDATE job_opportunity_sources SET unlinked_at = now() WHERE id = $1`,
        [l2.rows[0].id],
      )
      expect(half).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_opportunity_sources_unlink_pair',
      })
      const halfReason = await rejected(
        `UPDATE job_opportunity_sources SET unlink_reason = 'x' WHERE id = $1`,
        [l2.rows[0].id],
      )
      expect(halfReason.constraint).toBe('ck_job_opportunity_sources_unlink_pair')

      // Split: unlink rec2 from A, link it to B.
      await q(
        `UPDATE job_opportunity_sources SET unlinked_at = now(), unlink_reason = 'split' WHERE id = $1`,
        [l2.rows[0].id],
      )
      await link(rec2, oppB)

      const { rows } = await q(
        `SELECT opportunity_id, unlinked_at IS NULL AS active, unlink_reason
           FROM job_opportunity_sources WHERE source_record_id = $1 ORDER BY linked_at, id`,
        [rec2],
      )
      expect(rows).toHaveLength(2)
      expect(rows.filter((r: { active: boolean }) => r.active)).toHaveLength(1)
      expect(rows.find((r: { active: boolean }) => !r.active)).toMatchObject({
        opportunity_id: oppA,
        unlink_reason: 'split',
      })
      // rec1 is untouched by the split.
      const { rows: r1 } = await q(
        `SELECT opportunity_id FROM job_opportunity_sources
          WHERE source_record_id = $1 AND unlinked_at IS NULL`,
        [rec1],
      )
      expect(r1).toEqual([{ opportunity_id: oppA }])
    })

    it('link history is RESTRICT both ways: neither side can be deleted out from under it', async () => {
      const rec = await newRecord()
      const opp = await newOpportunity()
      await q(
        `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
         VALUES ($1, $2, 'r1')`,
        [rec, opp],
      )
      expect(
        (await rejected(`DELETE FROM job_source_records WHERE id = $1`, [rec])).constraint,
      ).toBe('fk_job_opportunity_sources_record')
      expect(
        (await rejected(`DELETE FROM job_opportunities WHERE id = $1`, [opp])).constraint,
      ).toBe('fk_job_opportunity_sources_opportunity')
    })

    it('rejects dangling references and unknown decisions', async () => {
      const rec = await newRecord()
      const opp = await newOpportunity()
      expect(
        (
          await rejected(
            `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
             VALUES ($1, $2, 'r1')`,
            [randomUUID(), opp],
          )
        ).constraint,
      ).toBe('fk_job_opportunity_sources_record')
      expect(
        (
          await rejected(
            `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
             VALUES ($1, $2, 'r1')`,
            [rec, randomUUID()],
          )
        ).constraint,
      ).toBe('fk_job_opportunity_sources_opportunity')
      expect(
        (
          await rejected(
            `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version, decision)
             VALUES ($1, $2, 'r1', 'GUESSED')`,
            [rec, opp],
          )
        ).code,
      ).toBe(INVALID_ENUM)
    })
  })

  describe('job_opportunity_matches', () => {
    it('UNIQUE(opportunity, senior); outcome enum; evidence default; cascades with the opportunity', async () => {
      const opp = await newOpportunity()
      const senior = await newUser()
      const ins = (outcome: string) =>
        q(
          `INSERT INTO job_opportunity_matches
             (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
           VALUES ($1, $2, 1, 'p1', 'e1', 'r1', $3) RETURNING evidence`,
          [opp, senior, outcome],
        )
      expect((await ins('LEAD')).rows[0].evidence).toEqual({})
      const dup = await rejected(
        `INSERT INTO job_opportunity_matches
           (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
         VALUES ($1, $2, 2, 'p1', 'e1', 'r1', 'TRIAGE')`,
        [opp, senior],
      )
      expect(dup).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_opportunity_matches_opportunity_senior',
      })
      const senior2 = await newUser()
      expect(
        (
          await rejected(
            `INSERT INTO job_opportunity_matches
               (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
             VALUES ($1, $2, 1, 'p1', 'e1', 'r1', 'MAYBE')`,
            [opp, senior2],
          )
        ).code,
      ).toBe(INVALID_ENUM)

      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opp])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_opportunity_matches WHERE opportunity_id = $1`,
        [opp],
      )
      expect(rows[0].n).toBe(0)
    })

    it('deleting the senior cascades their matches; unknown opportunity/senior are rejected', async () => {
      const opp = await newOpportunity()
      const senior = await newUser()
      await q(
        `INSERT INTO job_opportunity_matches
           (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
         VALUES ($1, $2, 1, 'p1', 'e1', 'r1', 'LEAD')`,
        [opp, senior],
      )
      await q(`DELETE FROM users WHERE id = $1`, [senior])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_opportunity_matches WHERE senior_id = $1`,
        [senior],
      )
      expect(rows[0].n).toBe(0)
      expect(
        (
          await rejected(
            `INSERT INTO job_opportunity_matches
               (opportunity_id, senior_id, opportunity_revision, senior_profile_version, exclusion_version, rule_version, outcome)
             VALUES ($1, $2, 1, 'p1', 'e1', 'r1', 'LEAD')`,
            [opp, randomUUID()],
          )
        ).code,
      ).toBe(FK_VIOLATION)
    })
  })

  describe('job_opportunity_team_triage', () => {
    const grant = (opp: string, team: string, by: string) =>
      q(
        `INSERT INTO job_opportunity_team_triage
           (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision, expires_at)
         VALUES ($1, $2, $3, 1, 1, now() + interval '7 days') RETURNING id, grant_version, revoked_at`,
        [opp, team, by],
      )

    it('one row per (opportunity, team); re-grant after revoke is an UPDATE that bumps grant_version', async () => {
      const opp = await newOpportunity()
      const team = await newTeam()
      const admin = await newUser()
      const first = await grant(opp, team, admin)
      expect(first.rows[0]).toMatchObject({ grant_version: 1, revoked_at: null })

      const dup = await rejected(
        `INSERT INTO job_opportunity_team_triage
           (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision, expires_at)
         VALUES ($1, $2, $3, 1, 1, now())`,
        [opp, team, admin],
      )
      expect(dup).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_opportunity_team_triage_opportunity_team',
      })

      await q(`UPDATE job_opportunity_team_triage SET revoked_at = now() WHERE id = $1`, [
        first.rows[0].id,
      ])
      await q(
        `UPDATE job_opportunity_team_triage
            SET revoked_at = NULL, grant_version = grant_version + 1, expires_at = now() + interval '7 days'
          WHERE id = $1`,
        [first.rows[0].id],
      )
      const { rows } = await q(
        `SELECT grant_version, revoked_at FROM job_opportunity_team_triage
          WHERE opportunity_id = $1 AND team_id = $2`,
        [opp, team],
      )
      expect(rows).toEqual([{ grant_version: 2, revoked_at: null }])
    })

    it('assigned_by is RESTRICT (an ADMIN with grants cannot vanish); team and opportunity cascade', async () => {
      const opp = await newOpportunity()
      const team = await newTeam()
      const admin = await newUser()
      await grant(opp, team, admin)
      expect((await rejected(`DELETE FROM users WHERE id = $1`, [admin])).code).toBe(FK_VIOLATION)

      await q(`DELETE FROM teams WHERE id = $1`, [team])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_opportunity_team_triage WHERE opportunity_id = $1`,
        [opp],
      )
      expect(rows[0].n).toBe(0)

      const team2 = await newTeam()
      await grant(opp, team2, admin)
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opp])
      const { rows: after } = await q(
        `SELECT count(*)::int AS n FROM job_opportunity_team_triage WHERE team_id = $1`,
        [team2],
      )
      expect(after[0].n).toBe(0)
    })

    it('requires expires_at and a real opportunity/team/assigner', async () => {
      const opp = await newOpportunity()
      const team = await newTeam()
      const admin = await newUser()
      const noExpiry = await rejected(
        `INSERT INTO job_opportunity_team_triage
           (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision)
         VALUES ($1, $2, $3, 1, 1)`,
        [opp, team, admin],
      )
      expect(noExpiry.code).toBe('23502')
      for (const [o, t, a] of [
        [randomUUID(), team, admin],
        [opp, randomUUID(), admin],
        [opp, team, randomUUID()],
      ]) {
        expect(
          (
            await rejected(
              `INSERT INTO job_opportunity_team_triage
             (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision, expires_at)
           VALUES ($1, $2, $3, 1, 1, now())`,
              [o, t, a],
            )
          ).code,
        ).toBe(FK_VIOLATION)
      }
    })
  })

  describe('catalog: FK-child and lookup indexes exist', () => {
    it('has the indexes added for FK probes and history lookups', async () => {
      const { rows } = await q(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1)`,
        [
          [
            'idx_job_opportunity_sources_record',
            'idx_job_source_record_revisions_description',
            'idx_job_opportunities_description',
            'idx_job_opportunity_team_triage_assigned_by',
            'idx_job_opportunity_sources_opportunity',
            'idx_job_source_record_revisions_record_seq',
            'uq_job_opportunity_sources_active_record',
            'idx_job_opportunities_stack_keywords',
          ],
        ],
      )
      expect(rows.map((r: { indexname: string }) => r.indexname).sort()).toEqual(
        [
          'idx_job_opportunity_sources_record',
          'idx_job_source_record_revisions_description',
          'idx_job_opportunities_description',
          'idx_job_opportunity_team_triage_assigned_by',
          'idx_job_opportunity_sources_opportunity',
          'idx_job_source_record_revisions_record_seq',
          'uq_job_opportunity_sources_active_record',
          'idx_job_opportunities_stack_keywords',
        ].sort(),
      )
    })

    it('the active-link unique index is partial (WHERE unlinked_at IS NULL)', async () => {
      const { rows } = await q(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_job_opportunity_sources_active_record'`,
      )
      expect(rows[0].indexdef).toMatch(/UNIQUE/i)
      expect(rows[0].indexdef).toMatch(/WHERE \(?unlinked_at IS NULL\)?/i)
    })
  })
})
