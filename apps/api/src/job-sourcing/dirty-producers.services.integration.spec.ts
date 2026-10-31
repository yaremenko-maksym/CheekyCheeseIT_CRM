import { randomUUID } from 'node:crypto'
import type { SessionUser } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalsService } from '../approvals/approvals.service'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { ProjectsService } from '../projects/projects.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import { AuditLogService } from '../users/audit-log.service'
import { UsersService } from '../users/users.service'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'

/**
 * r5 Task 4.6 S5 fix round 1 (CR-M-2, SPEC-M-1): the producer HOOKS, driven through the real
 * services on a real Postgres. For each path: the write commits -> its dirty row exists; a failure
 * injected right AFTER the producer has written its dirty row -> the write AND the dirty row are
 * both gone. The fault sits in `enqueueDerivedDirty` (it runs the real enqueue, then throws once
 * when armed), so a hook that ran on another connection than its write would leave its row behind.
 */
const fault = vi.hoisted(() => ({ armed: false }))
vi.mock('./ownership/dirty-work.store', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ownership/dirty-work.store')>()
  return {
    ...real,
    enqueueDerivedDirty: async (...args: Parameters<typeof real.enqueueDerivedDirty>) => {
      const out = await real.enqueueDerivedDirty(...args)
      if (fault.armed) {
        fault.armed = false
        throw new Error('injected after the dirty row')
      }
      return out
    },
  }
})

const TAG = randomUUID().slice(0, 8)
const id = () => randomUUID()
const ADMIN_ID = id()
const admin: SessionUser = {
  id: ADMIN_ID,
  email: `s5f-${TAG}-admin@test.spec`,
  displayName: 'S5F Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

let pool: Pool
let dbSvc: DatabaseService
let users: UsersService
let teams: TeamsService
let projects: ProjectsService
let jobs: JobSourcingService
const userIds: string[] = [ADMIN_ID]
const teamIds: string[] = []
const projectIds: string[] = []
const exclusionIds: string[] = []

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

/** `[kind, reason]` of the entity's dirty rows, oldest first. */
async function dirty(entityId: string): Promise<string[][]> {
  const { rows } = await q(
    `SELECT entity_kind, reason FROM job_dirty_work WHERE entity_id = $1 ORDER BY target_version`,
    [entityId],
  )
  return rows.map((r) => [String(r.entity_kind), String(r.reason)])
}

async function senior(name: string, techStack = ['Go', 'Rust', 'SQL']): Promise<string> {
  const uid = id()
  await q(
    `INSERT INTO users (id, email, display_name, role, tech_stack) VALUES ($1, $2, $3, 'SENIOR', $4)`,
    [uid, `s5f-${TAG}-${name}@test.spec`, `S5F ${name}`, techStack],
  )
  userIds.push(uid)
  return uid
}

async function team(type: 'SENIOR' | 'DROP', memberIds: string[]): Promise<string> {
  const tid = id()
  await q(`INSERT INTO teams (id, name, type) VALUES ($1, $2, $3)`, [
    tid,
    `S5F ${TAG} ${tid}`,
    type,
  ])
  for (const m of memberIds)
    await q(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [tid, m])
  teamIds.push(tid)
  return tid
}

describe.skipIf(!hasDatabaseUrl())('roster producer hooks through the real services (S5)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db: drizzle(pool, { schema }) })
    const teamAudit = new TeamAuditLogService(dbSvc)
    const projectAudit = new ProjectAuditLogService(dbSvc)
    teams = new TeamsService(dbSvc, {} as never, teamAudit, makeNotificationsStub())
    users = new UsersService(
      dbSvc,
      {} as never,
      new AuditLogService(dbSvc),
      {} as never,
      teamAudit,
      projectAudit,
      teams,
      {} as never,
      { getStatus: async () => 'NONE' as const } as never,
      makeNotificationsStub(),
    )
    ;(teams as unknown as { usersService: UsersService }).usersService = users
    projects = new ProjectsService(
      dbSvc,
      projectAudit,
      users,
      {} as never,
      new ApprovalsService(dbSvc, makeNotificationsStub()),
      makeNotificationsStub(),
    )
    jobs = new JobSourcingService(dbSvc, new HrAccessService(dbSvc), new JobSourceRegistry([]))
    await q(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'S5F Admin', 'ADMIN')`,
      [ADMIN_ID, admin.email],
    )
  }, 60_000)

  beforeEach(() => {
    fault.armed = false
  })

  afterAll(async () => {
    if (pool === undefined) return
    try {
      const all = [...userIds, ...teamIds, ...projectIds, ...exclusionIds]
      await q(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [all])
      await q(`DELETE FROM job_exclusion_filters WHERE id = ANY($1::uuid[])`, [exclusionIds])
      await q(`DELETE FROM approvals WHERE subject_id = ANY($1::uuid[])`, [projectIds])
      await q(`DELETE FROM project_audit_log WHERE target_id = ANY($1::uuid[])`, [projectIds])
      await q(`DELETE FROM project_members WHERE project_id = ANY($1::uuid[])`, [projectIds])
      await q(`DELETE FROM projects WHERE id = ANY($1::uuid[]) OR senior_id = ANY($2::uuid[])`, [
        projectIds,
        userIds,
      ])
      await q(`DELETE FROM team_audit_log WHERE target_id = ANY($1::uuid[])`, [teamIds])
      await q(
        `DELETE FROM team_members WHERE team_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])`,
        [teamIds, userIds],
      )
      await q(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [teamIds])
      await q(`DELETE FROM notifications WHERE recipient_id = ANY($1::uuid[])`, [userIds]).catch(
        () => undefined,
      )
      await q(`DELETE FROM user_audit_log WHERE target_id = ANY($1::uuid[])`, [userIds])
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds])
    } finally {
      await pool.end()
    }
  })

  it('UsersService.archive: commit -> SENIOR row (uppercase route id, SR-L-1); fault -> neither', async () => {
    const a = await senior('archive')
    await team('SENIOR', [a])
    await rolledBack(() => users.archive(a, ADMIN_ID))
    expect(
      (await q(`SELECT archived_at FROM users WHERE id = $1`, [a])).rows[0].archived_at,
    ).toBeNull()
    expect(await dirty(a)).toEqual([])

    await users.archive(a.toUpperCase(), ADMIN_ID)
    expect(await dirty(a)).toEqual([['SENIOR', 'senior.archive']])
  })

  it('TeamsService.addMember (join): commit -> SENIOR row; fault -> no membership, no row', async () => {
    const j = await senior('join')
    const t = await team('SENIOR', [])
    await rolledBack(() => teams.addMember(t, j, admin))
    const count = async () =>
      Number((await q(`SELECT count(*) AS n FROM team_members WHERE user_id = $1`, [j])).rows[0].n)
    expect(await count()).toBe(0)
    expect(await dirty(j)).toEqual([])

    await teams.addMember(t, j, admin)
    expect(await count()).toBe(1)
    expect(await dirty(j)).toEqual([['SENIOR', 'senior.team']])
  })

  it('TeamsService.rotateSenior (leave + join): both seniors, or neither', async () => {
    const out = await senior('out')
    const into = await senior('in')
    const t = await team('DROP', [out])
    await rolledBack(() => teams.rotateSenior(t, into, admin))
    expect(await dirty(out)).toEqual([])
    expect(await dirty(into)).toEqual([])
    const active = async () =>
      (
        await q(`SELECT user_id FROM team_members WHERE team_id = $1 AND left_at IS NULL`, [t])
      ).rows.map((r) => String(r.user_id))
    expect(await active()).toEqual([out])

    await teams.rotateSenior(t, into, admin)
    expect(await active()).toEqual([into])
    expect(await dirty(out)).toEqual([['SENIOR', 'senior.team']])
    expect(await dirty(into)).toEqual([['SENIOR', 'senior.team']])
  })

  it('JobSourcingService.createExclusion / deleteExclusion: commit -> row; fault -> neither', async () => {
    const value = `S5F Co ${TAG}`
    const dto = { scope: 'GLOBAL', kind: 'COMPANY', value } as never
    await rolledBack(() => jobs.createExclusion(dto, admin))
    const named = async () =>
      (await q(`SELECT id FROM job_exclusion_filters WHERE value = $1`, [value])).rows.map((r) =>
        String(r.id),
      )
    expect(await named()).toEqual([])

    const created = await jobs.createExclusion(dto, admin)
    exclusionIds.push(created.id)
    expect(await dirty(created.id)).toEqual([['EXCLUSION', 'exclusion.create']])

    await rolledBack(() => jobs.deleteExclusion(created.id, admin))
    expect(await named()).toEqual([created.id])
    expect(await dirty(created.id)).toEqual([['EXCLUSION', 'exclusion.create']])
    await jobs.deleteExclusion(created.id, admin)
    expect(await named()).toEqual([])
    expect(await dirty(created.id)).toEqual([
      ['EXCLUSION', 'exclusion.create'],
      ['EXCLUSION', 'exclusion.delete'],
    ])
  })

  it('ProjectsService.create: commit -> PROJECT_CLIENT row; fault -> no project, no row', async () => {
    const s = await senior('project')
    await team('SENIOR', [s])
    const dto = {
      name: `S5F P ${TAG}`,
      companyName: `S5F Client ${TAG}`,
      domain: 'Other',
      startDate: '2026-01-01T00:00:00.000Z',
      seniorId: s,
      rate: 1000,
      currency: 'USDT',
    } as never
    await rolledBack(() => projects.create(dto, admin))
    const owned = async () =>
      (await q(`SELECT id FROM projects WHERE senior_id = $1`, [s])).rows.map((r) => String(r.id))
    expect(await owned()).toEqual([])

    const created = (await projects.create(dto, admin)) as { id: string }
    projectIds.push(created.id)
    expect(await owned()).toEqual([created.id])
    expect(await dirty(created.id)).toEqual([['PROJECT_CLIENT', 'project.create']])
  })

  it('ProjectsService.createFromInterview (CR-H-1): in the caller tx -> row; fault -> neither', async () => {
    const s = await senior('hired')
    await team('SENIOR', [s])
    const interview = {
      id: id(),
      seniorId: s,
      hrId: null,
      companyName: `S5F Hired ${TAG}`,
      stage: 'HIRED',
      notesDomain: 'ai',
      senior: null,
    } as unknown as Parameters<ProjectsService['createFromInterview']>[0]
    const owned = async () =>
      (await q(`SELECT id FROM projects WHERE senior_id = $1`, [s])).rows.map((r) => String(r.id))
    await rolledBack(() =>
      dbSvc.db.transaction((tx) => projects.createFromInterview(interview, admin, tx)),
    )
    expect(await owned()).toEqual([])

    const created = await dbSvc.db.transaction((tx) =>
      projects.createFromInterview(interview, admin, tx),
    )
    projectIds.push(created!.id)
    expect(await owned()).toEqual([created!.id])
    expect(await dirty(created!.id)).toEqual([['PROJECT_CLIENT', 'project.create']])
  })
})

/** Run `work` once with the fault armed; it must reject with the injected error. */
async function rolledBack(work: () => Promise<unknown>): Promise<void> {
  fault.armed = true
  try {
    await expect(work()).rejects.toThrow('injected after the dirty row')
  } finally {
    fault.armed = false
  }
}
