import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { ActionKey, TabKey, ViewPermissions } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projectMembers, teamMembers, type User } from '../database/schema'

@Injectable()
export class UsersAccessService {
  constructor(private db: DatabaseService) {}

  async getViewPermissions(viewer: User, target: User): Promise<ViewPermissions> {
    const isSelf = viewer.id === target.id
    const isAdmin = viewer.role === 'ADMIN'
    const isAccountant = viewer.role === 'ACCOUNTANT'
    const isHr = viewer.role === 'HR'
    const isSenior = viewer.role === 'SENIOR'
    const isJunior = viewer.role === 'JUNIOR'
    const targetIsSenior = target.role === 'SENIOR'

    const tabs: TabKey[] = []
    const actions: ActionKey[] = []
    const fields: Record<string, boolean> = {}

    if (isAdmin) {
      tabs.push('overview', 'finance', 'projects', 'team', 'requisites', 'audit')
      if (targetIsSenior) tabs.push('interviews')
      if (!isSelf) {
        actions.push(
          'edit-profile',
          'change-role',
          'change-salary',
          'change-requisites',
          'manage-team',
          'reassign-project',
          'set-note',
          'archive',
        )
      }
      fields.salary = true
      fields.requisites = true
    } else if (isSelf) {
      tabs.push('overview', 'projects', 'team', 'requisites')
      if (isSenior || isJunior || isHr || isAccountant) tabs.push('finance')
      if (isSenior) tabs.push('interviews')
      fields.salary = true
      fields.requisites = true
    } else if (isAccountant) {
      tabs.push('overview', 'finance', 'projects', 'team', 'requisites')
      fields.salary = true
      fields.requisites = true
    } else if (isHr) {
      if (await this.isHrInTargetTeam(viewer.id, target)) {
        tabs.push('overview', 'projects', 'team')
        if (targetIsSenior) tabs.push('interviews')
      }
    } else if (isSenior) {
      if (await this.isSharedProject(viewer.id, target.id)) {
        tabs.push('overview', 'projects', 'team')
      }
    }
    // JUNIOR viewing other: no tabs

    return { tabs, actions, fields }
  }

  private async isHrInTargetTeam(hrId: string, target: User): Promise<boolean> {
    if (target.role === 'SENIOR') {
      const hrMemberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, hrId))
      if (hrMemberships.length === 0) return false
      const teamIds = hrMemberships.map((m) => m.teamId)
      const seniorInTeams = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, target.id), inArray(teamMembers.teamId, teamIds)))
      return seniorInTeams.length > 0
    }
    if (target.role === 'JUNIOR') {
      const hrTeams = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, hrId))
      if (hrTeams.length === 0) return false
      const teamIds = hrTeams.map((t) => t.teamId)
      const seniorsInTeams = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
      const seniorIds = seniorsInTeams.map((s) => s.userId)
      if (seniorIds.length === 0) return false
      const juniorProjects = await this.db.db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, target.id), isNull(projectMembers.leftAt)))
      return juniorProjects.length > 0
    }
    return false
  }

  private async isSharedProject(viewerId: string, targetId: string): Promise<boolean> {
    const viewerProjects = await this.db.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, viewerId), isNull(projectMembers.leftAt)))
    if (viewerProjects.length === 0) return false
    const projectIds = viewerProjects.map((p) => p.projectId)
    const targetInProjects = await this.db.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, targetId),
          inArray(projectMembers.projectId, projectIds),
          isNull(projectMembers.leftAt),
        ),
      )
    return targetInProjects.length > 0
  }
}
