import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SessionUser, UpsertLegendDto } from '@crm/shared'
import { legendSchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { legends, projectMembers, projects, teamMembers, users } from '../database/schema'

@Injectable()
export class LegendsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Check whether `viewer` is permitted to SEE the legend of `targetId`.
   *
   * RBAC:
   *   - SENIOR themselves  ✓
   *   - ADMIN              ✓ (any)
   *   - HR                 ✓ if target SENIOR is in one of HR's teams
   *   - JUNIOR             ✓ if JUNIOR is active project_member where seniorId = targetId
   *   - ACCOUNTANT / DROP / other SENIOR → false
   */
  async canViewLegend(viewer: SessionUser, targetId: string): Promise<boolean> {
    if (viewer.role === 'ADMIN') return true
    if (viewer.id === targetId && viewer.role === 'SENIOR') return true
    if (viewer.role === 'HR') return this.hrCanViewSeniorLegend(viewer.id, targetId)
    if (viewer.role === 'JUNIOR') return this.juniorCanViewSeniorLegend(viewer.id, targetId)
    return false
  }

  /**
   * HR can view a SENIOR's legend if they share at least one active team.
   * Uses two queries: first fetch HR's team IDs, then check if SENIOR is in any.
   */
  private async hrCanViewSeniorLegend(hrId: string, seniorId: string): Promise<boolean> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
      .limit(50)

    if (hrTeams.length === 0) return false

    const teamIds = hrTeams.map((t) => t.teamId)

    const seniorInTeam = await this.db.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.userId, seniorId),
          inArray(teamMembers.teamId, teamIds),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)

    return seniorInTeam.length > 0
  }

  /**
   * JUNIOR can view a SENIOR's legend if they are an active project_member
   * of a non-archived project where projects.seniorId = seniorId.
   */
  private async juniorCanViewSeniorLegend(juniorId: string, seniorId: string): Promise<boolean> {
    const membership = await this.db.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, juniorId),
          eq(projects.seniorId, seniorId),
          isNull(projectMembers.leftAt),
          isNull(projects.archivedAt),
        ),
      )
      .limit(1)

    return membership.length > 0
  }

  /**
   * GET legend for a given userId.
   * - 400 if target user is not SENIOR.
   * - 403 if viewer lacks permission.
   * - 404 if no legend exists yet.
   */
  async getLegend(viewer: SessionUser, targetId: string) {
    const targetRows = await this.db.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)

    const target = targetRows[0]
    if (!target) throw new NotFoundException('Пользователь не найден')
    if (target.role !== 'SENIOR') {
      throw new BadRequestException('Легенда доступна только для роли SENIOR')
    }

    const allowed = await this.canViewLegend(viewer, targetId)
    if (!allowed) throw new ForbiddenException('Нет доступа к легенде')

    const rows = await this.db.db
      .select()
      .from(legends)
      .where(eq(legends.userId, targetId))
      .limit(1)

    const row = rows[0]
    if (!row) throw new NotFoundException('Легенда не найдена')

    return legendSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }

  /**
   * PUT (upsert) legend for a given userId.
   * Only SENIOR themselves or ADMIN can edit.
   */
  async upsertLegend(viewer: SessionUser, targetId: string, dto: UpsertLegendDto) {
    const targetRows = await this.db.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1)

    const target = targetRows[0]
    if (!target) throw new NotFoundException('Пользователь не найден')
    if (target.role !== 'SENIOR') {
      throw new BadRequestException('Легенда доступна только для роли SENIOR')
    }

    const canEdit = viewer.role === 'ADMIN' || (viewer.id === targetId && viewer.role === 'SENIOR')
    if (!canEdit) {
      throw new ForbiddenException(
        'Редактировать легенду может только сам синьор или администратор',
      )
    }

    const now = new Date()

    const existing = await this.db.db
      .select({ id: legends.id })
      .from(legends)
      .where(eq(legends.userId, targetId))
      .limit(1)

    let row: typeof legends.$inferSelect

    if (existing.length === 0) {
      const inserted = await this.db.db
        .insert(legends)
        .values({
          userId: targetId,
          fullName: dto.fullName,
          dateOfBirth: dto.dateOfBirth ?? null,
          address: dto.address ?? null,
          hobbies: dto.hobbies ?? null,
          notes: dto.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      row = inserted[0]
    } else {
      const updated = await this.db.db
        .update(legends)
        .set({
          fullName: dto.fullName,
          dateOfBirth: dto.dateOfBirth ?? null,
          address: dto.address ?? null,
          hobbies: dto.hobbies ?? null,
          notes: dto.notes ?? null,
          updatedAt: now,
        })
        .where(eq(legends.userId, targetId))
        .returning()
      row = updated[0]
    }

    return legendSchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }
}
