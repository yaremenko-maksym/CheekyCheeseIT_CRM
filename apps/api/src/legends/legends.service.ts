import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type {
  AddLegendEntryDto,
  Legend,
  LegendEntry,
  SessionUser,
  UpsertLegendDto,
} from '@crm/shared'
import { legendSchema } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { legendEntries, legends, projectMembers, projects, users } from '../database/schema'

type ProjectRow = { id: string; seniorId: string; dropId: string | null }

/** Defaults prefilled from the real subject (drop ?? senior) for ADMIN/HR viewers. */
interface LegendDefaults {
  fullName: string | null
  address: string | null
}

@Injectable()
export class LegendsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly hrAccess: HrAccessService,
  ) {}

  /**
   * RBAC check: can `viewer` access the legend for `project`?
   *
   * Contract (execution order matters — see task-admin-as-senior reorder):
   *   ADMIN                         → true  ← FIRST (before subject-exclusion)
   *                                           When seniorId = ADMIN_ID, subject-exclusion
   *                                           would wrongly deny the admin access to the
   *                                           legend of their own project. Checking ADMIN
   *                                           first prevents that. ADMIN always has full
   *                                           legend access regardless of being the subject.
   *   viewer.id === project.seniorId → false (subject excluded — applies to SENIOR/DROP
   *                                           only; ADMIN is already returned true above)
   *   viewer.id === project.dropId   → false (subject excluded)
   *   HR sharing active team with project.seniorId → true
   *   HR with no shared team         → false
   *   JUNIOR active project_member of this project → true
   *   JUNIOR not a member            → false
   *   ACCOUNTANT                     → false
   *   any other SENIOR/DROP          → false
   *
   * view-access == edit-access.
   */
  async canAccess(viewer: SessionUser, project: ProjectRow): Promise<boolean> {
    // task-admin-as-senior: ADMIN check runs FIRST — before subject-exclusion.
    // When seniorId = ADMIN_ID, subject-exclusion would otherwise wrongly deny
    // the admin access to the legend of their own project. ADMIN always has
    // full legend access regardless of whether they are the project's subject.
    if (viewer.role === 'ADMIN') return true

    // Subject explicitly excluded (SENIOR/DROP who is the project persona
    // must not see/edit their own legend — they ARE the subject).
    if (viewer.id === project.seniorId) return false
    if (project.dropId && viewer.id === project.dropId) return false

    // HR can access if they share an active team with the project's senior.
    // Consolidated into HrAccessService (was a private hrCanAccess copy).
    if (viewer.role === 'HR')
      return this.hrAccess.hrSharesActiveTeamWith(viewer.id, project.seniorId)

    if (viewer.role === 'JUNIOR') return this.juniorCanAccess(viewer.id, project.id)

    return false
  }

  /**
   * JUNIOR can access if they are an active project_member of this exact project.
   */
  private async juniorCanAccess(juniorId: string, projectId: string): Promise<boolean> {
    const membership = await this.db.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, juniorId),
          eq(projectMembers.projectId, projectId),
          isNull(projectMembers.leftAt),
        ),
      )
      .limit(1)

    return membership.length > 0
  }

  /**
   * Load project row — throws NotFoundException if not found.
   */
  private async loadProject(projectId: string): Promise<ProjectRow> {
    const rows = await this.db.db
      .select({ id: projects.id, seniorId: projects.seniorId, dropId: projects.dropId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    const project = rows[0]
    if (!project) throw new NotFoundException('Проект не найден')
    return project
  }

  /**
   * Load legend row for the project (no entries).
   * Returns null if no legend exists yet — caller decides whether to throw or return null.
   */
  private async loadLegendRow(projectId: string) {
    const rows = await this.db.db
      .select()
      .from(legends)
      .where(eq(legends.projectId, projectId))
      .limit(1)

    return rows[0] ?? null
  }

  /**
   * Load legend entries for a legend, ordered by eventDate (fallback createdAt) ASC.
   * Includes eventDate field added in migration 0010.
   */
  private async loadEntries(legendId: string): Promise<LegendEntry[]> {
    const rows = await this.db.db
      .select({
        id: legendEntries.id,
        legendId: legendEntries.legendId,
        authorId: legendEntries.authorId,
        authorName: users.displayName,
        text: legendEntries.text,
        eventDate: legendEntries.eventDate,
        createdAt: legendEntries.createdAt,
      })
      .from(legendEntries)
      .leftJoin(users, eq(legendEntries.authorId, users.id))
      .where(eq(legendEntries.legendId, legendId))
      // Sort by event_date when present, falling back to created_at date.
      // Both compared as text (YYYY-MM-DD format) for consistent ordering.
      .orderBy(
        asc(
          sql`COALESCE(${legendEntries.eventDate}, to_char(${legendEntries.createdAt}, 'YYYY-MM-DD'))`,
        ),
        asc(legendEntries.createdAt),
      )

    return rows.map((r) => ({
      id: r.id,
      legendId: r.legendId,
      authorId: r.authorId,
      authorName: r.authorName ?? 'Неизвестный',
      text: r.text,
      eventDate: r.eventDate ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  /**
   * Load prefill defaults from the real subject (drop ?? senior).
   * Returns legalFullName + registrationAddress.
   * Only called for ADMIN/HR viewers — NEVER for JUNIOR (AC8 / bug class #157/#158).
   */
  private async loadDefaults(project: ProjectRow): Promise<LegendDefaults> {
    // Subject is drop if set, else senior
    const subjectId = project.dropId ?? project.seniorId
    const row = await this.db.db
      .select({
        legalFullName: users.legalFullName,
        registrationAddress: users.registrationAddress,
      })
      .from(users)
      .where(eq(users.id, subjectId))
      .limit(1)

    const subject = row[0]
    if (!subject) return { fullName: null, address: null }

    return {
      fullName: subject.legalFullName ?? null,
      address: subject.registrationAddress ?? null,
    }
  }

  /**
   * Assemble a full Legend DTO from a DB row + entries + optional defaults.
   */
  private buildLegend(
    row: NonNullable<Awaited<ReturnType<typeof this.loadLegendRow>>>,
    entries: LegendEntry[],
    defaults?: LegendDefaults | null,
  ): Legend {
    return legendSchema.parse({
      id: row.id,
      projectId: row.projectId,
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth ?? null,
      address: row.address ?? null,
      presentedRole: row.presentedRole ?? null,
      presentedStack: row.presentedStack ?? null,
      backstory: row.backstory ?? null,
      hobbies: row.hobbies ?? null,
      notes: row.notes ?? null,
      entries,
      defaults: defaults ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  /**
   * Returns true if viewer is ADMIN or HR (can receive defaults).
   * JUNIOR must never receive real identity data (AC8 — bug class #157/#158).
   */
  private canReceiveDefaults(viewer: SessionUser): boolean {
    return viewer.role === 'ADMIN' || viewer.role === 'HR'
  }

  /**
   * GET legend for a given projectId.
   * - 404 if project not found
   * - 403 if viewer lacks permission
   * - null if no legend exists yet (accessible project, no legend created yet)
   * - defaults: non-null only for ADMIN/HR (AC8)
   */
  async getLegend(viewer: SessionUser, projectId: string): Promise<Legend | null> {
    const project = await this.loadProject(projectId)

    const allowed = await this.canAccess(viewer, project)
    if (!allowed) throw new ForbiddenException('Нет доступа к легенде проекта')

    const row = await this.loadLegendRow(projectId)
    if (!row) return null

    const [entries, defaults] = await Promise.all([
      this.loadEntries(row.id),
      this.canReceiveDefaults(viewer) ? this.loadDefaults(project) : Promise.resolve(null),
    ])

    return this.buildLegend(row, entries, defaults)
  }

  /**
   * PUT (upsert) legend for a given projectId.
   *
   * Edit permission = view permission (same canAccess check).
   * Subject (seniorId/dropId) is excluded.
   * Atomic upsert on the UNIQUE(project_id) constraint — race-safe.
   */
  async upsertLegend(
    viewer: SessionUser,
    projectId: string,
    dto: UpsertLegendDto,
  ): Promise<Legend> {
    const project = await this.loadProject(projectId)

    const canEdit = await this.canAccess(viewer, project)
    if (!canEdit) throw new ForbiddenException('Нет доступа к редактированию легенды проекта')

    const now = new Date()

    const rows = await this.db.db
      .insert(legends)
      .values({
        projectId,
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth ?? null,
        address: dto.address ?? null,
        presentedRole: dto.presentedRole ?? null,
        presentedStack: dto.presentedStack ?? null,
        backstory: dto.backstory ?? null,
        hobbies: dto.hobbies ?? null,
        notes: dto.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: legends.projectId,
        set: {
          fullName: dto.fullName,
          dateOfBirth: dto.dateOfBirth ?? null,
          address: dto.address ?? null,
          presentedRole: dto.presentedRole ?? null,
          presentedStack: dto.presentedStack ?? null,
          backstory: dto.backstory ?? null,
          hobbies: dto.hobbies ?? null,
          notes: dto.notes ?? null,
          updatedAt: now,
          // createdAt is intentionally absent here: it is set once on INSERT
          // and must not be overwritten on subsequent updates (immutable audit
          // timestamp — tells us when the legend was first created).
        },
      })
      .returning()

    const row = rows[0]
    if (!row) throw new NotFoundException('Upsert failed — legend not returned')

    const [entries, defaults] = await Promise.all([
      this.loadEntries(row.id),
      this.canReceiveDefaults(viewer) ? this.loadDefaults(project) : Promise.resolve(null),
    ])

    return this.buildLegend(row, entries, defaults)
  }

  /**
   * POST entry to legend journal for a given projectId.
   * - 403 if viewer lacks access
   * - 404 if project not found
   * - 404 if legend does not exist yet (must upsert first)
   */
  async addEntry(viewer: SessionUser, projectId: string, dto: AddLegendEntryDto): Promise<Legend> {
    const project = await this.loadProject(projectId)

    const canEdit = await this.canAccess(viewer, project)
    if (!canEdit) throw new ForbiddenException('Нет доступа к легенде проекта')

    const legendRow = await this.loadLegendRow(projectId)
    // Guard against a race with project cascade-delete: if the legend was
    // removed between the canAccess check above and this point, we return
    // 404 (NotFoundException) instead of letting the FK insert fail with a
    // cryptic 500. Callers should upsert the legend first.
    if (!legendRow)
      throw new NotFoundException('Легенда проекта не найдена — сначала создайте легенду')

    await this.db.db.insert(legendEntries).values({
      legendId: legendRow.id,
      authorId: viewer.id,
      text: dto.text,
      eventDate: dto.eventDate ?? null,
      createdAt: new Date(),
    })

    const [entries, defaults] = await Promise.all([
      this.loadEntries(legendRow.id),
      this.canReceiveDefaults(viewer) ? this.loadDefaults(project) : Promise.resolve(null),
    ])

    return this.buildLegend(legendRow, entries, defaults)
  }
}
