import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projects, users, visibleProjects } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * AC2 (task-project-draft-status): `visible_projects` returns EXACTLY
 * `status = 'ACTIVE' AND archived_at IS NULL` rows — proven against a real
 * Postgres, not a mock, because the view's own predicate
 * (`VISIBLE_PROJECTS_PREDICATE` in schema.ts) is a DB-level construct a
 * mocked `db.select()` cannot execute at all. Stryker cannot run this file
 * (`.claude/rules/common/mutation-gate-integration-specs.md`) — this is what
 * justifies the `// Stryker disable next-line` on the predicate's own
 * 'ACTIVE' literal in schema.ts, which names this file as the proof.
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api exec vitest run visible-projects-view.integration
 */

let pool: Pool

const SENIOR_ID = randomUUID()
const DRAFT_ID = randomUUID()
const ACTIVE_ID = randomUUID()
const REJECTED_ID = randomUUID()
const ARCHIVED_ACTIVE_ID = randomUUID()
const ALL_PROJECT_IDS = [DRAFT_ID, ACTIVE_ID, REJECTED_ID, ARCHIVED_ACTIVE_ID]

describe.skipIf(!hasDatabaseUrl())('visible_projects VIEW — against real Postgres', () => {
  let db: ReturnType<typeof drizzle>

  beforeAll(async () => {
    const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const which = await probe.query('SELECT current_database() AS db')
    if (which.rows[0]?.db === 'crm_db') {
      await probe.end()
      throw new Error('[visible_projects] REFUSING to run against the live crm_db')
    }
    const check = await probe.query(
      `SELECT 1 FROM information_schema.views WHERE table_name = 'visible_projects' LIMIT 1`,
    )
    await probe.end()
    if (check.rowCount === 0) {
      throw new Error(
        '[visible_projects] FAILED — view not migrated. Apply ' +
          'apps/api/drizzle/manual/2026-09-02_project_status.sql against this DATABASE_URL first.',
      )
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool)

    await db.insert(users).values({
      id: SENIOR_ID,
      email: `visible-projects-spec-${SENIOR_ID}@test.spec`,
      displayName: 'Visible Projects Spec Senior',
      role: 'SENIOR',
    })

    const baseProject = {
      companyName: 'Test Co',
      domain: 'Other',
      startDate: new Date('2026-01-01'),
      seniorId: SENIOR_ID,
      rate: 100,
      currency: 'USDT' as const,
    }
    await db.insert(projects).values([
      { id: DRAFT_ID, name: 'Draft', status: 'DRAFT', ...baseProject },
      { id: ACTIVE_ID, name: 'Active', status: 'ACTIVE', ...baseProject },
      { id: REJECTED_ID, name: 'Rejected', status: 'REJECTED', ...baseProject },
      {
        id: ARCHIVED_ACTIVE_ID,
        name: 'Archived-but-active',
        status: 'ACTIVE',
        archivedAt: new Date(),
        ...baseProject,
      },
    ])
  })

  afterAll(async () => {
    await db.delete(projects).where(inArray(projects.id, ALL_PROJECT_IDS))
    await db.delete(users).where(eq(users.id, SENIOR_ID))
    await pool.end()
  })

  it('returns ONLY the status=ACTIVE, non-archived project — DRAFT/REJECTED/archived-ACTIVE all excluded', async () => {
    const rows = await db
      .select({ id: visibleProjects.id })
      .from(visibleProjects)
      .where(inArray(visibleProjects.id, ALL_PROJECT_IDS))
    expect(rows.map((r) => r.id)).toEqual([ACTIVE_ID])
  })

  it('a raw select on projects (no filter) still returns all four — proves the exclusion is the VIEW, not the fixture', async () => {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, ALL_PROJECT_IDS))
    expect(rows.map((r) => r.id).sort()).toEqual([...ALL_PROJECT_IDS].sort())
  })

  it('the project_status enum has exactly DRAFT/ACTIVE/REJECTED, and the column DEFAULT is ACTIVE', async () => {
    const enumRows = await pool.query<{ unnest: string }>(
      'SELECT unnest(enum_range(NULL::project_status)) ORDER BY 1',
    )
    expect(enumRows.rows.map((r) => r.unnest).sort()).toEqual(['ACTIVE', 'DRAFT', 'REJECTED'])

    const defaultRow = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'projects' AND column_name = 'status'`,
    )
    // Postgres renders an enum default as "'ACTIVE'::project_status".
    expect(defaultRow.rows[0]?.column_default).toContain("'ACTIVE'")
  })
})
