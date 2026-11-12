import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
} from '../../job-sourcing/runtime/recompute-inputs'
import { leadEvidence, SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'
import type { SeedCtx } from './shared'

/** Source namespace of every seeded record: keeps the identity keys apart from collected ones. */
const SEED_NAMESPACE = 'seed'
/** The two source types a card can show (React Platform has both). */
const SOURCE_TYPES = ['GREENHOUSE_ATS', 'LEVER_ATS'] as const

/**
 * Task 7.6a — the job-queue rows behind the Task 7.6 E2E rights scenarios (data and contract in
 * `job-queue.data.ts`). Row shapes follow `job-queue-rbac.integration.spec.ts`: an OPEN
 * opportunity evaluated OPEN at the LIVE inputs, live source links, and LEAD matches stamped with
 * each senior's LIVE profile and exclusion versions, which is what makes a match visible to the
 * senior's teams. Runs after every phase that writes users or teams, so those versions are final.
 *
 * Timestamps are relative to the moment the seed runs, never a fixed date, so the rows stay fresh.
 * No generation, submission, dismissal, triage grant or action rows: the queue publishes its own
 * generation on the first read, and every card starts untouched.
 *
 * Re-runnable: `job_opportunities` (and with it sources and matches) is emptied by the users/teams
 * TRUNCATE ... CASCADE; `job_source_records` and `job_text_blobs` are not, so both upsert.
 */
export async function seedJobQueue({ db }: SeedCtx): Promise<void> {
  console.log('\n[7b/8] Inserting job-queue opportunities...')
  const roster = await loadRoster(db)
  const inputsVersion = opportunityInputsVersion(
    roster.exclusions.filter((e) => e.seniorId === null),
  )

  for (const o of SEED_QUEUE_OPPORTUNITIES) {
    const sha = createHash('sha256').update(o.description, 'utf8').digest('hex')
    await db.execute(
      sql`INSERT INTO job_text_blobs (sha256, text) VALUES (${sha}, ${o.description})
          ON CONFLICT DO NOTHING`,
    )
    const firstSeenDays = o.publishedDaysAgo ?? 1
    const published =
      o.publishedDaysAgo === null
        ? sql`NULL`
        : sql`now() - make_interval(days => ${o.publishedDaysAgo}::int)`
    const { rows } = await db.execute(
      sql`INSERT INTO job_opportunities
            (title, title_key, revision, availability, employer_name, employer_key,
             employer_verified, stack_keywords, description_sha256, published_at,
             first_seen_at, last_observed_at, evaluated_revision, evaluation_verdict,
             evaluated_inputs_version, role_family)
          VALUES (${o.title}, ${`seed-${o.key}`}, 1, 'OPEN', ${o.employer},
                  ${o.employer.toLowerCase()}, ${o.employerVerified},
                  ARRAY[${sql.join(
                    o.stackKeywords.map((k) => sql`${k}`),
                    sql`, `,
                  )}]::text[], ${sha},
                  ${published}, now() - make_interval(days => ${firstSeenDays}::int), now(),
                  1, 'OPEN', ${inputsVersion}, ${o.roleFamily})
          RETURNING id`,
    )
    const opportunityId = String(rows[0]!['id'])

    for (let n = 0; n < o.sourceCount; n++) {
      const identityKey = `seed-${o.key}-${n + 1}`
      const rec = await db.execute(
        sql`INSERT INTO job_source_records
              (source_type, namespace, identity_kind, identity_key, source_url)
            VALUES (${SOURCE_TYPES[n % SOURCE_TYPES.length]}::job_source_type, ${SEED_NAMESPACE},
                    'NATIVE_ID', ${identityKey},
                    ${`https://jobs.example.test/seed/${o.key}/${n + 1}`})
            ON CONFLICT (source_type, namespace, identity_key)
              DO UPDATE SET last_observed_at = now()
            RETURNING id`,
      )
      // `linked_at` apart by a second, so the primary source (the earliest link) is the first.
      await db.execute(
        sql`INSERT INTO job_opportunity_sources
              (source_record_id, opportunity_id, rule_version, linked_at)
            VALUES (${String(rec.rows[0]!['id'])}::uuid, ${opportunityId}::uuid, 'r1',
                    now() - make_interval(secs => ${o.sourceCount - n}::int))`,
      )
    }

    for (const lead of o.leads) {
      const v = roster.versions.get(lead.seniorId)
      if (v === undefined) throw new Error(`job-queue seed: senior ${lead.seniorId} not on a team`)
      await db.execute(
        sql`INSERT INTO job_opportunity_matches
              (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
               exclusion_version, rule_version, outcome, evidence)
            VALUES (${opportunityId}::uuid, ${lead.seniorId}::uuid, 1, ${v.profile},
                    ${v.exclusion}, ${MATCH_RULE_VERSION}, 'LEAD',
                    ${JSON.stringify(leadEvidence(lead))}::jsonb)`,
      )
    }
  }
  const leads = SEED_QUEUE_OPPORTUNITIES.reduce((n, o) => n + o.leads.length, 0)
  console.log(
    `  ✓ ${SEED_QUEUE_OPPORTUNITIES.length} opportunities, ${leads} LEAD matches inserted`,
  )
}
