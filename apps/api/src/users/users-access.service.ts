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
    const targetIsDrop = target.role === 'DROP'
    // Legend subjects: SENIOR or DROP. Subject themselves cannot view/edit own legend.
    const targetIsLegendSubject = targetIsSenior || targetIsDrop

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
      // adminNote — ADMIN only, never self (internal staff note, not surfaced to subject)
      fields.adminNote = !isSelf
      // FOP PII (registrationAddress, usrRecord) — ADMIN + self
      fields.fopPii = true
      // Real contacts (email, phone, telegram) — visible to ADMIN always
      fields.realContacts = true
      // ADMIN can view/edit any SENIOR's or DROP's legend (subject excluded by isSelf check)
      fields.legend = targetIsLegendSubject && !isSelf
      // task-junior-ut-round2 §6: ADMIN sees + edits a JUNIOR's project credentials
      // section in that junior's profile. Never for self / non-JUNIOR targets.
      fields.projectCredentials = target.role === 'JUNIOR' && !isSelf
      fields.editCredentials = target.role === 'JUNIOR' && !isSelf
    } else if (isSelf) {
      // task-junior-ut-round2 §3 (security, data-leak): JUNIOR self-view is an
      // EXPLICIT allow-list — overview/requisites/documents only. JUNIOR must NOT
      // get projects/team/finance tabs: those surface the senior/drop identity and
      // project/team internals (same class as mapProject allow-list + RBAC audit
      // 2026-06-10). The junior hub (/crm/project) is their project surface.
      if (isJunior) {
        // task-junior-ut-round3 §6a: 'documents' removed from JUNIOR self-view
        // (data-privacy: /crm/project hub is the junior's primary project surface).
        tabs.push('overview', 'requisites')
      } else if (isDrop) {
        // task-drop-profile-rbac-r2 (Finding A): DROP self-view is trimmed to an
        // EXPLICIT allow-list — overview + requisites ONLY (UT decision: «карточка»).
        // Removed from the profile tab surface:
        //   - 'finance'  → DROP финансы видит на /crm/routing (роутинг-хаб), не во вкладке.
        //   - 'team'     → reachable via /crm/team/$teamId, not as a profile tab.
        //   - 'contract' → DROP смотрит контракт через /crm/documents (page-not-tab model),
        //                  не во вкладке профиля (раньше включался в UT finding 3a — теперь
        //                  перенесён на documents-страницу).
        //   - 'documents'→ already a dedicated /crm/documents page (like JUNIOR page-not-tab).
        //   - 'projects' → routing hub (/crm/routing) is the canonical surface.
        tabs.push('overview', 'requisites')
      } else {
        tabs.push('overview', 'projects', 'team', 'requisites', 'documents')
        // SENIOR, HR, ACCOUNTANT: finance access
        if (isSenior || isHr || isAccountant) tabs.push('finance')
      }
      // SENIOR: interviews moved to header link; no separate tab here
      fields.salary = targetIsSalaryRole
      fields.share = targetIsShareRole
      fields.paymentMethodKpi = true
      fields.registrationDate = true
      fields.techStack = targetHasTechStack
      fields.requisites = true
      // legalFullName (passport PII) — owner always sees own legal name
      fields.legalName = true
      // adminNote — self does NOT see their own admin note (internal staff memo)
      fields.adminNote = false
      // FOP PII — owner always sees own registrationAddress/usrRecord
      fields.fopPii = true
      // Real contacts — owner sees own contacts
      fields.realContacts = true
      // Subject cannot view/edit their own legend (new model: self-access removed)
      fields.legend = false
    } else if (isAccountant) {
      tabs.push('overview', 'finance', 'projects', 'team', 'requisites', 'documents')
      fields.salary = targetIsSalaryRole
      fields.share = targetIsShareRole
      fields.paymentMethodKpi = true
      fields.registrationDate = true
      fields.techStack = targetHasTechStack
      fields.requisites = true
      // adminNote — ACCOUNTANT does not see admin notes
      fields.adminNote = false
      // FOP PII — ACCOUNTANT does not see registrationAddress/usrRecord
      fields.fopPii = false
      // Real contacts — ACCOUNTANT sees contacts (email/phone/telegram)
      fields.realContacts = true
    } else if (isHr) {
      if (await this.isHrInTargetTeam(viewer.id, target)) {
        tabs.push('overview', 'projects', 'team')
        if (targetIsSenior) tabs.push('interviews')
        fields.techStack = targetHasTechStack
        fields.registrationDate = true
        // adminNote — HR does not see admin notes
        fields.adminNote = false
        // FOP PII — HR does not see registrationAddress/usrRecord
        fields.fopPii = false
        // Real contacts — HR sees contacts (email/phone/telegram)
        fields.realContacts = true
        // HR can view/edit their SENIOR's or DROP's legend
        fields.legend = targetIsLegendSubject
        // task-junior-ut-round2 §6: HR (sharing the target junior's team) sees +
        // edits that junior's project credentials in their profile. JUNIOR only.
        fields.projectCredentials = target.role === 'JUNIOR'
        fields.editCredentials = target.role === 'JUNIOR'
      }
    } else if (isSenior) {
      // SENIOR cannot view JUNIOR profiles (identity hidden per RBAC rule #1).
      // SENIOR can view profiles of other non-JUNIOR members of their own projects —
      // but only when the target is also a project_member (HR/ACCOUNTANT in that project).
      // task-junior-ux-1-backend §6: SENIOR must NOT see other SENIOR/DROP profiles —
      // only JUNIOR members of their own projects are accessible (and those are blocked
      // above). In practice this means SENIOR→non-JUNIOR always gets zero tabs.
      // The isSeniorViewingOwnProjectMember helper is now restricted to JUNIOR-role
      // targets only, so SENIOR→SENIOR and SENIOR→DROP are blocked at the role check.
      if (target.role !== 'JUNIOR') {
        // SENIOR cannot view another SENIOR, DROP, HR, ADMIN, or ACCOUNTANT profile
        // via the project-member path. Zero tabs — 403 at route level.
        // (Future: a separate "team-mate" path for HR/ACCOUNTANT could be added,
        //  but is explicitly out of scope per task-junior-ux-1-backend §2 side-fix.)
      }
      // target.role === 'JUNIOR': intentionally fall through with no tabs (403 at route level).
    } else if (isJunior && targetIsLegendSubject) {
      // JUNIOR can view the legend of the SENIOR or DROP associated with their active project.
      // For SENIOR: projects.seniorId = target. For DROP: projects.dropId = target.
      // surfaces overview/projects/team tabs so the profile is reachable.
      // RBAC: JUNIOR sees SENIOR/DROP only through their legend persona.
      // Real contacts (email/phone/telegram) and FOP PII are hidden — these are
      // identity fields of the real person behind the legend.
      if (await this.isJuniorUnderLegendSubject(viewer.id, target.id)) {
        tabs.push('overview', 'projects', 'team')
        fields.techStack = targetHasTechStack
        fields.registrationDate = true
        fields.adminNote = false
        fields.fopPii = false
        // CRITICAL: JUNIOR must NOT see real contacts of their SENIOR/DROP.
        // The legend persona boundary requires this: JUNIOR interacts with the
        // client-facing persona, not the real identity behind it (OWASP A01).
        fields.realContacts = false
        fields.legend = true
      }
    }
    // task-drop-profile-lockdown: DROP has NO access to ANY other user's profile.
    // The previous "own-team open card" branch (Finding B from #202) is removed —
    // DROP→non-self always yields zero tabs → 403. DROP sees teammates' inline
    // contacts on the team page (/crm/team/$teamId), which is sufficient; there is
    // no profile surface for them. This tightens the model (less exposure) and
    // partially reverts finding B1 from #202. DROP self-view (overview+requisites,
    // Finding A) is unchanged — handled in the isSelf branch above.
    //
    // Other JUNIOR viewing non-SENIOR/non-DROP, ACCOUNTANT, DROP viewing ANY other
    // user: no tabs → 403.

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
   * JUNIOR viewing a SENIOR or DROP: true if the JUNIOR is an active project_member
   * on a non-archived project where projects.seniorId = targetId OR projects.dropId = targetId.
   * Mirrors LegendsService.juniorCanViewLegend.
   */
  private async isJuniorUnderLegendSubject(juniorId: string, targetId: string): Promise<boolean> {
    // Step 1: collect active project IDs for this JUNIOR
    const membership = await this.db.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, juniorId),
          isNull(projectMembers.leftAt),
          isNull(projects.archivedAt),
        ),
      )
      .limit(50)

    if (membership.length === 0) return false

    const projectIds = membership.map((m) => m.projectId)

    // Step 2: check if targetId is senior OR drop on any of those projects
    const matched = await this.db.db
      .select({ id: projects.id, seniorId: projects.seniorId, dropId: projects.dropId })
      .from(projects)
      .where(inArray(projects.id, projectIds))

    return matched.some((p) => p.seniorId === targetId || p.dropId === targetId)
  }
}
