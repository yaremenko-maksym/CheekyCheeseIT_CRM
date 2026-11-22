import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import type { SessionUser } from '@crm/shared'
import { vi } from 'vitest'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { type CrmAppSession, openCrmAppSession } from '../database/__test-helpers__/crm-app-session'
import { DatabaseService } from '../database/database.service'
import { S3Service } from '../documents/s3.service'
import { JobQueueScopeService } from '../job-sourcing/queue/queue-scope.service'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  type SeniorVersions,
} from '../job-sourcing/runtime/recompute-inputs'
import { TailoredResumesController } from '../tailored-resumes/tailored-resumes.controller'
import { TailoredResumesService } from '../tailored-resumes/tailored-resumes.service'
import { TailoredRunner } from '../tailored-resumes/tailored-runner'
import { AuditLogService } from '../users/audit-log.service'
import { ZodExceptionFilter } from '../zod-exception.filter'

/**
 * The tailored resume routes through the REAL guard chain (global `JwtAuthGuard`, the controller's
 * own `RolesGuard`), the real controller and service, over Fastify, against a real Postgres as the
 * API role (`crm_app`), as `job-queue-rbac.integration.spec.ts` does. The runner and S3 are fakes:
 * these specs prove access and the run start, not generation. NEVER `crm_db`: `openCrmAppSession`
 * refuses it, and `open` refuses it again.
 */
export type Method = 'GET' | 'POST'
export interface Answer {
  status: number
  raw: string
  json: Record<string, unknown>
  headers: Record<string, unknown>
}

const JWT_SECRET = 'tailored-rbac-integration-secret-000000000000'

export class TailoredHarness {
  readonly ids: Record<string, string> = {}
  readonly records: Record<string, string> = {}
  readonly people: Record<string, SessionUser> = {}
  readonly runner = { enqueue: vi.fn() }
  readonly s3 = { getObject: vi.fn(async () => Buffer.from('%PDF-previous')) }
  /** `TAILORED_RESUME_ENABLED`, read on every request. */
  enabled = true
  live: ReadonlyMap<string, SeniorVersions> = new Map()
  service!: TailoredResumesService
  private session!: CrmAppSession
  private app!: NestFastifyApplication
  private jwt!: JwtService
  private seq = 0

  constructor(readonly tag: string) {}

  id = (key: string): string => this.ids[key] as string
  sql = (text: string, params: unknown[] = []) => this.session.admin.query(text, params)

  async open(): Promise<void> {
    this.session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await this.sql(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
  }

  async mkUser(key: string, role: SessionUser['role']): Promise<void> {
    const email = `${this.tag}-${key}@example.test`
    const { rows } = await this.sql(
      `INSERT INTO users (email, display_name, role, tech_stack) VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, `${this.tag} name ${key}`, role, ['Go']],
    )
    this.ids[key] = rows[0].id as string
    this.people[key] = { id: this.id(key), email, role } as SessionUser
  }
  async mkTeam(key: string): Promise<void> {
    const { rows } = await this.sql(
      `INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`,
      [`${this.tag}-${key}`],
    )
    this.ids[key] = rows[0].id as string
  }
  join = (team: string, member: string) =>
    this.sql(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
      this.id(team),
      this.id(member),
    ])
  /** A VERIFIED base resume in English: the senior is READY unless the posting is pending. */
  verified = (senior: string) =>
    this.sql(
      `INSERT INTO senior_resumes (user_id, content, version, verification_status)
       VALUES ($1, $2::jsonb, 3, 'VERIFIED')`,
      [
        this.id(senior),
        JSON.stringify({
          links: [],
          skills: ['Go'],
          summary: 'Backend engineer',
          education: [],
          languages: [],
          experience: [],
        }),
      ],
    )
  /** An OPEN opportunity with one live GREENHOUSE source link (no head: never on-demand missing). */
  async mkOpp(key: string, title = key): Promise<void> {
    const { rows } = await this.sql(
      `INSERT INTO job_opportunities
         (title, title_key, revision, availability, technical_roles, role_status)
       VALUES ($1, $2, 1, 'OPEN', ARRAY['BACKEND_ENGINEER'], 'RULE') RETURNING id`,
      [`${this.tag} ${title}`, `${this.tag}-${key}`],
    )
    this.ids[key] = rows[0].id as string
    this.seq += 1
    const rec = await this.sql(
      `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
       VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
      [
        `${this.tag}-ns`,
        `${this.tag}-k${this.seq}`,
        `https://jobs.example.test/${this.tag}/${this.seq}`,
      ],
    )
    this.records[key] = rec.rows[0].id as string
    await this.sql(
      `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
       VALUES ($1, $2, 'r1')`,
      [this.records[key], this.id(key)],
    )
  }
  /** Reads the roster: call after every membership and exclusion fixture, before `lead`. */
  async loadLive(): Promise<void> {
    this.live = (await loadRoster(this.session.databaseService.db)).versions
  }
  /** A LEAD match stamped with the senior's live versions: what makes it visible to their teams. */
  lead(opp: string, senior: string) {
    const v = this.live.get(this.id(senior)) as SeniorVersions
    return this.sql(
      `INSERT INTO job_opportunity_matches
         (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
          exclusion_version, rule_version, outcome, evidence)
       VALUES ($1, $2, 1, $3, $4, $5, 'LEAD', $6::jsonb)`,
      [
        this.id(opp),
        this.id(senior),
        v.profile,
        v.exclusion,
        MATCH_RULE_VERSION,
        JSON.stringify({
          score: 50,
          reasons: [{ code: 'TECH_MATCH', evidence: ['Go:CORE'], ruleVersion: 'r' }],
          rankWarnings: [],
        }),
      ],
    )
  }

  async boot(): Promise<void> {
    const dbSvc = {
      pool: this.session.pool,
      db: this.session.databaseService.db,
    } as unknown as DatabaseService
    const config = {
      get: (key: string) => (key === 'TAILORED_RESUME_ENABLED' ? this.enabled : undefined),
    }

    @Global()
    @Module({
      providers: [{ provide: DatabaseService, useFactory: () => dbSvc }],
      exports: [DatabaseService],
    })
    class TestDatabaseModule {}

    @Module({
      imports: [
        TestDatabaseModule,
        JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [TailoredResumesController],
      providers: [
        Reflector,
        // Explicit factories: the vitest/esbuild env emits no `design:paramtypes`.
        { provide: JobQueueScopeService, useFactory: () => new JobQueueScopeService() },
        { provide: ConfigService, useValue: config },
        {
          provide: TailoredResumesService,
          useFactory: (db: DatabaseService, scopes: JobQueueScopeService) =>
            new TailoredResumesService(
              db,
              scopes,
              new AuditLogService(db),
              this.s3 as unknown as S3Service,
              this.runner as unknown as TailoredRunner,
            ),
          inject: [DatabaseService, JobQueueScopeService],
        },
        {
          provide: APP_GUARD,
          useFactory: (j: JwtService, reflector: Reflector) => new JwtAuthGuard(j, reflector),
          inject: [JwtService, Reflector],
        },
      ],
    })
    class TailoredTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TailoredTestModule] })
      // A properly constructed real guard: the injector leaves its reflector undefined here.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    this.app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await this.app.register(cookie, { secret: 'tailored-rbac-cookie-secret' })
    this.app.setGlobalPrefix('api')
    this.app.useGlobalFilters(new ZodExceptionFilter())
    await this.app.init()
    await this.app.getHttpAdapter().getInstance().ready()
    this.jwt = moduleRef.get(JwtService)
    this.service = moduleRef.get(TailoredResumesService)
  }

  async call(method: Method, url: string, who: string, payload?: unknown): Promise<Answer> {
    const p = this.people[who] as SessionUser
    const res = await this.app.inject({
      method,
      url: `/api/job-queue${url}`,
      cookies: { jwt: this.jwt.sign({ id: p.id, email: p.email, role: p.role }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    })
    const json = res.headers['content-type']?.toString().includes('application/json')
      ? (JSON.parse(res.body) as Record<string, unknown>)
      : {}
    return { status: res.statusCode, raw: res.body, json, headers: res.headers }
  }

  async close(): Promise<void> {
    if (this.app !== undefined) await this.app.close()
    if (this.session === undefined) return
    const t = `${this.tag}%`
    try {
      const users = `SELECT id FROM users WHERE email LIKE $1`
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      await this.sql(`DELETE FROM user_audit_log WHERE actor_id IN (${users})`, [t])
      await this.sql(`DELETE FROM tailored_resumes WHERE job_opportunity_id IN (${opps})`, [t])
      await this.sql(
        `DELETE FROM job_dirty_work WHERE entity_id IN
           (SELECT id FROM job_source_records WHERE namespace = $1)`,
        [`${this.tag}-ns`],
      )
      await this.sql(`DELETE FROM job_opportunity_matches WHERE opportunity_id IN (${opps})`, [t])
      await this.sql(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [t])
      await this.sql(`DELETE FROM job_opportunities WHERE title LIKE $1`, [t])
      await this.sql(`DELETE FROM job_source_records WHERE namespace = $1`, [`${this.tag}-ns`])
      await this.sql(`DELETE FROM job_exclusion_filters WHERE senior_id IN (${users})`, [t])
      await this.sql(`DELETE FROM senior_resumes WHERE user_id IN (${users})`, [t])
      const teams = `SELECT id FROM teams WHERE name LIKE $1`
      await this.sql(`DELETE FROM team_members WHERE team_id IN (${teams})`, [t])
      await this.sql(`DELETE FROM teams WHERE name LIKE $1`, [t])
      await this.sql(`DELETE FROM users WHERE email LIKE $1`, [t])
    } finally {
      await this.session.close()
    }
  }
}
