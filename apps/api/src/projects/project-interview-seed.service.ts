import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  projects,
  teamMembers,
  type Interview,
  type User,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { NotificationsService } from '../notifications/notifications.service'
import { PROJECT_APPROVAL_SUBJECT_TYPE } from './project-access.service'

/**
 * Seeds a DRAFT project (plus its approval proposal, senior notification and
 * HR/ACCOUNTANT teammates) from a HIRED interview. Extracted verbatim from
 * ProjectsService.createFromInterview; the facade keeps a thin delegate.
 */
@Injectable()
export class ProjectInterviewSeedService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Create a project from a HIRED interview.
   *
   * Audit (HIGH): accepts an optional `tx` so the caller (`InterviewsService.move`)
   * can run this INSIDE the same transaction that flips the interview to HIRED.
   * Without it, the interview stage update committed before this insert, so a
   * failure here orphaned the interview in HIRED with no project. With `tx`
   * threaded through every write, a failure rolls the stage change back too.
   * When `tx` is omitted, behaviour is unchanged (`this.db.db`).
   *
   * Backlog #136: the HR/ACCOUNTANT this seeds onto the new project come from
   * the senior's team membership below — see the `isNull(teamMembers.leftAt)`
   * filters on both queries it runs. Both must stay: one keeps a team the
   * senior has LEFT from contributing staff at all, the other keeps a
   * teammate who left THAT team from being seated even while the team is
   * still active for the senior.
   *
   * security-review round 2 (SR-H-6): this is the SECOND door into
   * `insert(projects)` — `create()` above is the first — and round 1 missed
   * it entirely: no explicit `status: 'DRAFT'` and no approval proposal, so a
   * project hired straight out of an interview shipped fully `ACTIVE` (the
   * column DEFAULT) with zero rows in `approvals`, unconfirmable by
   * construction (`approveDraft` 404s everyone — there is no live row to
   * confirm). BIZ-07 reaches this from `PATCH /api/interviews/:id/move`,
   * which HR and SENIOR can call too, not just ADMIN. Same gate, same
   * reason as `create()`: the senior whose money this project will move
   * should agree to it in CRM before it starts, regardless of which door
   * created the row. Interview-sourced projects never carry a `dropId` (no
   * such field exists on `Interview`), so the senior is the sole invited
   * approver here — no `[seniorId, dropId]` branch to mirror from `create()`.
   */
  async createFromInterview(
    interview: Interview & { senior: User | null },
    currentUser: SessionUser,
    tx?: DrizzleTx,
  ) {
    const conn = tx ?? this.db.db
    const domain = interview.notesDomain ?? 'Other'

    const [project] = await conn
      .insert(projects)
      .values({
        name: interview.companyName,
        companyName: interview.companyName,
        domain,
        logoDocumentId: null,
        logoExternalUrl: null,
        startDate: new Date(),
        seniorId: interview.seniorId,
        rate: 0,
        currency: 'USDT',
        techStack: interview.notesTechStack ?? null,
        teamSize: interview.notesTeamSize ?? null,
        benefits: interview.notesBenefits ?? null,
        // task-drop-share-override-and-receiver (D1 / C10). `interview.notesPaymentType`
        // is a free-text interview note — NOT a project_payment_type enum value.
        // Leave paymentType at the DB default ('FOP'); ADMIN/ACCOUNTANT set the
        // real enum later via the project edit form.
        salaryReview: interview.notesSalaryReview ?? null,
        corpTech: interview.notesCorpTech ?? null,
        notesGeneral: interview.notesGeneral ?? null,
        // security-review round 2 (SR-H-6). See the method doc above — this
        // is the door round 1 left open.
        status: 'DRAFT',
      })
      .returning()

    if (!project) return project

    // security-review round 2 (SR-H-6). Open the approval proposal in the
    // SAME connection as the insert above — when the caller passed a `tx`
    // (the only real caller, `InterviewsService.move`, always does), this is
    // the SAME transaction, so a DRAFT project without its approval row
    // stays impossible here too (decision Д1's own invariant, see `create()`
    // above). `conn` is `DrizzleTx | NodePgDatabase` depending on whether a
    // `tx` was passed; `proposeInTx` only ever calls query-builder methods
    // both share, so the cast is the same shape already used elsewhere in
    // this codebase for the identical mismatch (e.g.
    // `transactions.service.ts`'s `this.db.db as unknown as DrizzleTx`).
    const [approval] = await this.approvals.proposeInTx(conn as unknown as DrizzleTx, {
      subjectType: PROJECT_APPROVAL_SUBJECT_TYPE,
      subjectId: project.id,
      approverUserIds: [interview.seniorId],
      proposedByUserId: currentUser.id,
    })
    // Stryker disable next-line all: defensive-only (и условие, и текст сообщения) — `proposeInTx` возвращает `.returning()` по строке на подтверждающего; пустой массив при непустом `approverUserIds` на настоящем Postgres невозможен.
    if (!approval) throw new Error('Failed to open project approval')

    // SR-L-1 (security-review круг 1): ВТОРАЯ дверь в черновик проекта — и
    // производитель обязан стоять у обеих. `create` выше уже просит синьора
    // подтвердить; проект, приехавший из нанятого собеседования, открывает
    // ровно такое же согласование, и без этой строки синьор о нём не узнавал
    // (кнопка «подтвердить» есть, просьбы нет).
    //
    // Тот же контур, что и у `create`: получатели — приглашённые
    // подтверждающие, автор действия исключён (§8.1 — своё подтверждает тост,
    // а не колокольчик), запись идёт по тому же соединению, что и сам
    // черновик, поэтому откат события уносит и её.
    // SR-H-2 (security-review круг 2): именно ЗДЕСЬ вето и поймали
    // исполнением — `TypeError` на этом пути откатывал переход собеседования в
    // HIRED вместе с созданием проекта и записью `created_project_id` (BIZ-07).
    // Теперь путь производителя идёт во вложенной транзакции (SAVEPOINT):
    // ошибка откатывает ровно её, а событие живёт.
    await this.notifications.emitInTx(conn as unknown as DrizzleTx, async (sp) => {
      if (interview.seniorId !== (currentUser.impersonatorId ?? currentUser.id)) {
        await this.notifications.createInTx(sp, {
          userId: interview.seniorId,
          type: 'PROJECT_CONFIRM_REQUIRED',
          title: NOTIFICATION_TITLES.PROJECT_CONFIRM_REQUIRED,
          subjectType: 'PROJECT',
          subjectId: project.id,
          // ORCH-3 (fix-round 7): companyName, не projects.name (здесь равны при
          // создании из собеседования, но источник — companyName).
          // QA-H-1 (круг 3): плюс идентификатор открывшейся строки согласования.
          data: { projectName: project.companyName, approvalId: approval.id },
        })
      }
    })

    // Find all teams where this senior is CURRENTLY a member. Backlog #136:
    // this query used to ignore `leftAt`, so a team the senior had already
    // left still fed its HR/ACCOUNTANT into a brand-new project — a stale
    // team membership was outliving the membership itself.
    const seniorTeamMemberships = await conn.query.teamMembers.findMany({
      where: and(eq(teamMembers.userId, interview.seniorId), isNull(teamMembers.leftAt)),
    })
    const teamIds = seniorTeamMemberships.map((m) => m.teamId)

    if (teamIds.length > 0) {
      // task-archived-user-completeness (AC1, security-review MED-3). This is
      // the SECOND door into `project_members`, and it was open. `addMember`
      // now refuses to seat a dismissed person on a live project; seeding a
      // project from a HIRED interview has to obey the same invariant, or the
      // rule holds only on the door someone happened to look at.
      //
      // TWO filters, because a dismissed teammate could arrive here by two
      // different routes:
      //
      //   • `isNull(leftAt)` — `UsersService.archive` closes an HR's /
      //     ACCOUNTANT's team memberships by stamping `leftAt`, and this query
      //     did not look at it. A dismissed HR whose membership had been
      //     closed months ago was still returned here and handed a fresh
      //     ACTIVE row on a brand-new project.
      //   • `archivedAt` — belt and braces for the row that is archived while
      //     its membership is somehow still open (a cascade that missed, a
      //     hand-edited row, a future archive path that forgets). `leftAt`
      //     tracks TEAM membership; `archivedAt` tracks EMPLOYMENT, and the
      //     question "may this person be seated on a project" belongs to the
      //     second one — the same split spelled out on `addMember`.
      //
      // No money moves through this today (only the JUNIOR branch of
      // `createMonthlySalaries` mints from project membership, and it re-reads
      // `user.archivedAt`; HR/ACCOUNTANT salaries come from a separate query
      // that already filters archived). This is about the invariant being true
      // wherever it is stated, not about a live leak.
      const teammates = await conn.query.teamMembers.findMany({
        where: and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)),
        with: { user: { columns: { id: true, role: true, archivedAt: true } } },
      })

      const addedUserIds = new Set<string>()
      for (const m of teammates) {
        const u = (
          m as typeof m & { user: { id: string; role: string; archivedAt: Date | null } | null }
        ).user
        if (!u) continue
        if (u.archivedAt) continue
        if (u.role !== 'HR' && u.role !== 'ACCOUNTANT') continue
        if (addedUserIds.has(u.id)) continue
        addedUserIds.add(u.id)
        await conn.insert(projectMembers).values({
          projectId: project.id,
          userId: u.id,
        })
      }
    }

    return project
  }
}
