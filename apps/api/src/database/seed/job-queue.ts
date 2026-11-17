import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
  type SeniorVersions,
} from '../../job-sourcing/runtime/recompute-inputs'
import { leadEvidence, SEED_QUEUE_MEMBERSHIPS, SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'
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
  // The exact call `JobQueueScopeService` makes, so the two inputs versions cannot diverge.
  const inputsVersion = opportunityInputsVersion(roster.exclusions)

  for (const o of SEED_QUEUE_OPPORTUNITIES) {
    const sha = createHash('sha256').update(o.description).digest('hex')
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

/** What `verifyJobQueueSeed` reads back: the facts the queue's visibility depends on. */
export interface JobQueueSeedFacts {
  /** Active (`unlinked_at IS NULL`) source links per seeded title. */
  readonly sources: readonly { readonly title: string; readonly sources: number }[]
  readonly leads: readonly {
    readonly title: string
    readonly seniorId: string
    readonly profile: string
    readonly exclusion: string
    readonly ruleVersion: string
    /** `opportunity_revision` of the match; the queue lists it only at the opportunity's `revision`. */
    readonly matchRevision: number
    readonly revision: number
  }[]
  /** Active memberships of the `SEED_QUEUE_MEMBERSHIPS` users in live SENIOR teams, by name. */
  readonly memberships: readonly { readonly userId: string; readonly team: string }[]
  /** The live versions the queue compares a match against (`loadRoster`). */
  readonly versions: ReadonlyMap<string, SeniorVersions>
}

/** Every way the read-back seed differs from the contract; empty = the seed is what Task 7.6 needs. */
export function jobQueueSeedProblems(f: JobQueueSeedFacts): string[] {
  const problems: string[] = []
  for (const o of SEED_QUEUE_OPPORTUNITIES) {
    const sources = f.sources.find((r) => r.title === o.title)?.sources ?? 0
    if (sources !== o.sourceCount) {
      problems.push(`${o.title}: ${sources} linked sources, expected ${o.sourceCount}`)
    }
    const leads = f.leads.filter((l) => l.title === o.title)
    const want = new Set(o.leads.map((l) => l.seniorId))
    if (leads.length !== want.size || leads.some((l) => !want.has(l.seniorId))) {
      problems.push(`${o.title}: LEAD seniors differ from the contract`)
    }
    for (const l of leads) {
      const v = f.versions.get(l.seniorId)
      if (v?.profile !== l.profile || v.exclusion !== l.exclusion) {
        problems.push(`${o.title}: the match of ${l.seniorId} is not at the live roster versions`)
      }
      if (l.ruleVersion !== MATCH_RULE_VERSION) {
        problems.push(`${o.title}: the match of ${l.seniorId} is not at the current rule version`)
      }
      if (l.matchRevision !== l.revision) {
        problems.push(`${o.title}: the match of ${l.seniorId} is not at the opportunity's revision`)
      }
    }
  }
  for (const m of SEED_QUEUE_MEMBERSHIPS) {
    const teams = f.memberships
      .filter((r) => r.userId === m.userId)
      .map((r) => r.team)
      .sort()
      .join(', ')
    if (teams !== m.teams.join(', ')) {
      problems.push(`${m.who}: teams [${teams}], expected [${m.teams.join(', ')}]`)
    }
  }
  return problems
}

/**
 * Task 7.6a — fails the seed when the job-queue rows would not show the cards the Task 7.6 E2E
 * expects: a missing title, an unlinked source, a moved match, a lost membership, or a match
 * whose versions are no longer the live roster's (the queue hides such a match silently).
 */
export async function verifyJobQueueSeed({ db }: SeedCtx): Promise<void> {
  const titles = SEED_QUEUE_OPPORTUNITIES.map((o) => o.title)
  const sources = await db.execute(
    sql`SELECT o.title, count(s.source_record_id)::int AS sources
          FROM job_opportunities o
          LEFT JOIN job_opportunity_sources s ON s.opportunity_id = o.id AND s.unlinked_at IS NULL
         WHERE o.title IN ${titles}
         GROUP BY o.title`,
  )
  const leads = await db.execute(
    sql`SELECT o.title, m.senior_id::text AS "seniorId", m.senior_profile_version AS profile,
               m.exclusion_version AS exclusion, m.rule_version AS "ruleVersion",
               m.opportunity_revision AS "matchRevision", o.revision
          FROM job_opportunity_matches m JOIN job_opportunities o ON o.id = m.opportunity_id
         WHERE m.outcome = 'LEAD' AND o.title IN ${titles}`,
  )
  // Live SENIOR teams only, as the queue's `liveTeam` / `liveTeamIds` count them.
  const memberships = await db.execute(
    sql`SELECT tm.user_id::text AS "userId", t.name AS team
          FROM team_members tm JOIN teams t ON t.id = tm.team_id
         WHERE tm.left_at IS NULL AND t.archived_at IS NULL AND t.type = 'SENIOR'
           AND tm.user_id IN ${SEED_QUEUE_MEMBERSHIPS.map((m) => m.userId)}`,
  )
  const { versions } = await loadRoster(db)
  const problems = jobQueueSeedProblems({
    sources: sources.rows as unknown as JobQueueSeedFacts['sources'],
    leads: leads.rows as unknown as JobQueueSeedFacts['leads'],
    memberships: memberships.rows as unknown as JobQueueSeedFacts['memberships'],
    versions,
  })
  console.log(`  Job-queue seed opportunities: ${sources.rows.length} (expected: ${titles.length})`)
  if (problems.length > 0) throw new Error(`job-queue seed incomplete: ${problems.join('; ')}`)
}
