import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { projectFinanceSettings, projects } from '../database/schema'

/**
 * Project finance settings (senior-share / junior-salary overrides): role-gated
 * read and upsert. Moved verbatim out of TransactionsService; depends on the db
 * only (the upsert's read-back is this class's own getProjectFinanceSettings).
 * TransactionsService keeps controller-facing delegates.
 */
@Injectable()
export class ProjectFinanceSettingsService {
  constructor(private db: DatabaseService) {}

  async getProjectFinanceSettings(projectId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    // SR-M-3 (security-review round 3, task-project-draft-status):
    // ACCOUNTANT must not see finance settings for a project
    // ProjectsService.assertAccess would already 404 them on directly (a
    // DRAFT/REJECTED project — ACCOUNTANT is neither ADMIN nor an invited
    // approver, see that method's own existence-oracle comment). ADMIN
    // always passes here too, mirroring assertAccess's own ADMIN exemption
    // — an admin legitimately configures finance settings before
    // confirmation (the SAME seniorSharePercentOverride field `create()`
    // already accepts on a still-DRAFT project).
    if (currentUser.role === 'ACCOUNTANT') {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { status: true },
      })
      if (!project || project.status !== 'ACTIVE') {
        throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
      }
    }

    const settings = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    return settings ?? null
  }

  async upsertProjectFinanceSettings(
    projectId: string,
    data: {
      seniorSharePercentOverride?: number | null | undefined
      juniorSalaryOverride?: number | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })
    if (!project) throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    // SR-M-3 — same ACCOUNTANT-only status gate as getProjectFinanceSettings
    // above (this method already fetches the full project row for the
    // existence check, so the extra query the read-only sibling needs is
    // not needed here).
    if (currentUser.role === 'ACCOUNTANT' && project.status !== 'ACTIVE') {
      throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

    const fsValues = {
      seniorSharePercentOverride: data.seniorSharePercentOverride ?? null,
      juniorSalaryOverride:
        data.juniorSalaryOverride !== undefined && data.juniorSalaryOverride !== null
          ? String(data.juniorSalaryOverride)
          : null,
      updatedBy: currentUser.id,
      updatedAt: new Date(),
    }

    // BIZ-22: upsertProjectFinanceSettings must be the SINGLE SOURCE OF TRUTH
    // for the senior-share override. Before this fix it only wrote to
    // project_finance_settings, but createSeniorIncome reads
    // projects.senior_share_percent_override (via the hierarchy resolver).
    // Resolution: wrap both writes in one transaction — project_finance_settings
    // and projects.senior_share_percent_override are always in sync after this call.
    //
    // Design choice: mirror the write into projects (same strategy as
    // ProjectsService.syncFinanceSettingsOverride) rather than changing the
    // resolver read-path — keeps the hierarchy resolver pure and avoids a JOIN.
    await this.db.db.transaction(async (tx) => {
      const existing = await tx.query.projectFinanceSettings.findFirst({
        where: eq(projectFinanceSettings.projectId, projectId),
      })

      if (existing) {
        await tx
          .update(projectFinanceSettings)
          .set(fsValues)
          .where(eq(projectFinanceSettings.projectId, projectId))
      } else {
        await tx.insert(projectFinanceSettings).values({ projectId, ...fsValues })
      }

      // Mirror seniorSharePercentOverride into projects so the resolver
      // (which reads projects.senior_share_percent_override) picks it up.
      // juniorSalaryOverride lives ONLY in project_finance_settings (used by
      // salary cron) and does NOT exist on the projects table — no mirror needed.
      if (data.seniorSharePercentOverride !== undefined) {
        await tx
          .update(projects)
          .set({ seniorSharePercentOverride: data.seniorSharePercentOverride ?? null })
          .where(eq(projects.id, projectId))
      }
    })

    return this.getProjectFinanceSettings(projectId, currentUser)
  }
}
