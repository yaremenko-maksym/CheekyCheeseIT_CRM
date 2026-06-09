import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { ActionKey, TabKey, ViewPermissions } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { projectMembers, projects, teamMembers, users, type User } from '../database/schema'

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
    const isDrop = viewer.role === 'DROP'
    const targetIsSenior = target.role === 'SENIOR'

    const tabs: TabKey[] = []
    const actions: ActionKey[] = []
    const fields: Record<string, boolean> = {}

    const targetIsSalaryRole =
      target.role === 'JUNIOR' || target.role === 'HR' || target.role === 'ACCOUNTANT'
    // Drop role - phase 1: DROP also has a share (drop_share_percent default 5).
    const targetIsShareRole =
      target.role === 'SENIOR' || target.role === 'ADMIN' || target.role === 'DROP'
    // HR and ACCOUNTANT have soft-skill tech stacks ("Рекрутинг", "Account Support", "1С") —
    // visible like dev stacks.
    const targetHasTechStack = true

    if (isAdmin) {
      // 'interviews' is no longer a profile tab — replaced by a header link
      // (showInterviewsLink) rendered in UserProfileShell for any SENIOR target.
      tabs.push('overview', 'finance', 'projects', 'team', 'requisites', 'documents')
      // 'contract' tab: ADMIN viewing a non-ADMIN employee (not self — admins have no contracts).
      if (!isSelf && target.role !== 'ADMIN') tabs.push('contract')
      if (!isSelf) {
        actions.push(
          'edit-profile',
          'change-role',
          'change-salary',
          'change-requisites',
          'set-note',
          'archive',
        )
      }
      // ADMIN viewing self: hide own salary/share/payment-method/registration-date KPIs (own
      // share is 50/50 with partner — not surfaced as user data). Otherwise full visibility.
      fields.salary = !isSelf && targetIsSalaryRole
      fields.share = !isSelf && targetIsShareRole
      fields.paymentMethodKpi = !isSelf
      fields.registrationDate = !isSelf
      fields.techStack = targetHasTechStack
      fields.requisites = true
      // legalFullName (passport PII) — ADMIN always sees it (including self)
      fields.legalName = true
      // ADMIN can view any SENIOR's legend
      fields.legend = targetIsSenior
    } else if (isSelf) {
      tabs.push('overview', 'projects', 'team', 'requisites', 'documents')
      // Drop role - phase 1: DROP has finance access (read), same as senior/etc.
      if (isSenior || isJunior || isHr || isAccountant || isDrop) tabs.push('finance')
      // SENIOR: interviews moved to header link; no separate tab here
      fields.salary = targetIsSalaryRole
      fields.share = targetIsShareRole
      fields.paymentMethodKpi = true
      fields.registrationDate = true
      fields.techStack = targetHasTechStack
      fields.requisites = true
      // legalFullName (passport PII) — owner always sees own legal name
      fields.legalName = true
      // SENIOR can always view/edit their own legend
      fields.legend = isSenior
    } else if (isAccountant) {
      tabs.push('overview', 'finance', 'projects', 'team', 'requisites', 'documents')
      fields.salary = targetIsSalaryRole
      fields.share = targetIsShareRole
      fields.paymentMethodKpi = true
      fields.registrationDate = true
      fields.techStack = targetHasTechStack
      fields.requisites = true
    } else if (isHr) {
      if (await this.isHrInTargetTeam(viewer.id, target)) {
        tabs.push('overview', 'projects', 'team')
        if (targetIsSenior) tabs.push('interviews')
        fields.techStack = targetHasTechStack
        fields.registrationDate = true
        // HR can view their SENIOR's legend
        fields.legend = targetIsSenior
      }
    } else if (isSenior) {
      // SENIOR can view profiles of JUNIOR members active on their projects
      if (await this.isSeniorViewingOwnProjectMember(viewer.id, target.id)) {
        tabs.push('overview', 'projects', 'team')
        fields.techStack = targetHasTechStack
        fields.registrationDate = true
      }
    } else if (isJunior && targetIsSenior) {
      // JUNIOR can view the legend-holding SENIOR of their active project.
      // Same predicate as LegendsService.juniorCanViewSeniorLegend — also
      // surfaces overview/projects/team tabs so the profile is reachable.
      if (await this.isJuniorUnderSenior(viewer.id, target.id)) {
        tabs.push('overview', 'projects', 'team')
        fields.techStack = targetHasTechStack
        fields.registrationDate = true
        fields.legend = true
      }
    }
    // Other JUNIOR viewing non-SENIOR, ACCOUNTANT, DROP viewing others: no tabs

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
      // Find seniors in HR's teams, then projects of those seniors,
      // then check if target is an active member of any of those projects.
      const hrTeams = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, hrId))
      if (hrTeams.length === 0) return false
      const teamIds = hrTeams.map((t) => t.teamId)

      // Get SENIOR users in those teams
      const seniorMembers = await this.db.db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(and(inArray(teamMembers.teamId, teamIds), eq(users.role, 'SENIOR')))
      const seniorIds = seniorMembers.map((s) => s.userId)
      if (seniorIds.length === 0) return false

      // Find projects owned by those seniors
      const seniorProjects = await this.db.db
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.seniorId, seniorIds))
      const projectIds = seniorProjects.map((p) => p.id)
      if (projectIds.length === 0) return false

      // Check if target (JUNIOR) is active in any of those projects
      const targetActive = await this.db.db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, target.id),
            inArray(projectMembers.projectId, projectIds),
            isNull(projectMembers.leftAt),
          ),
        )
      return targetActive.length > 0
    }
    return false
  }

  /**
   * SENIOR viewing a JUNIOR: true if the JUNIOR is an active project_member
   * on any project where projects.seniorId = seniorId.
   * (SENIOR lives in projects.seniorId, not in project_members.)
   */
  private async isSeniorViewingOwnProjectMember(
    seniorId: string,
    targetId: string,
  ): Promise<boolean> {
    // Find active projects owned by this SENIOR
    const seniorProjects = await this.db.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.seniorId, seniorId))
    if (seniorProjects.length === 0) return false
    const projectIds = seniorProjects.map((p) => p.id)

    // Check if target is an active member of any of those projects
    const targetActive = await this.db.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, targetId),
          inArray(projectMembers.projectId, projectIds),
          isNull(projectMembers.leftAt),
        ),
      )
      .limit(1)
    return targetActive.length > 0
  }

  /**
   * JUNIOR viewing a SENIOR: true if the JUNIOR is an active project_member
   * on a non-archived project where projects.seniorId = seniorId.
   * Mirrors LegendsService.juniorCanViewSeniorLegend.
   */
  private async isJuniorUnderSenior(juniorId: string, seniorId: string): Promise<boolean> {
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
}
