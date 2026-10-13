import { Inject, Injectable, forwardRef } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import { teamMembers, teams, users, type User } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { assertTeamStaffRoles } from './team-staff.util'

/**
 * Team-composition reconcile for a SENIOR's team, extracted from UsersService
 * (behavior-preserving move). Writes only `team_members` / `teams` (reads
 * `users` via a JOIN); never writes `users`. Reached through UsersService's
 * lazy `teamReconcile` getter so prototype-built spec factories keep working.
 */
@Injectable()
export class TeamReconcileService {
  constructor(
    @Inject(forwardRef(() => TeamAuditLogService))
    private teamAuditLogService: TeamAuditLogService,
  ) {}

  /**
   * Update `teams.telegram_channel` for the team owned by `seniorId` and write
   * a `team_updated` audit row inside the SAME transaction. No-op if the value
   * hasn't actually changed (avoids spurious audit entries for re-saves).
   */
  async updateSeniorTeamTelegramChannelTx(
    tx: DrizzleTx,
    seniorId: string,
    value: string | null,
    actorId: string | null,
  ): Promise<void> {
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const team = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .then((rows) => rows[0])
    if (!team) return

    const previous = team.telegramChannel ?? null
    const next = value ?? null
    if (previous === next) return

    await tx
      .update(teams)
      .set({ telegramChannel: next, updatedAt: new Date() })
      .where(eq(teams.id, teamId))

    await this.teamAuditLogService.record(
      {
        actorId,
        targetId: teamId,
        action: 'team_updated',
        changes: { telegramChannel: { before: previous, after: next } },
      },
      tx,
    )
  }

  /**
   * Transactional variant of reconcileSeniorTeam. All membership writes and
   * audit log entries use the supplied `tx` so adminUpdateUser's outer
   * transaction can commit them atomically with the user UPDATE.
   *
   * Active members (`leftAt IS NULL`) are diffed against the target sets:
   *  - new HR/Acc -> insert team_member or restore via leftAt=NULL on existing row
   *  - removed HR/Acc -> set leftAt=now()
   * Each delta is logged into `team_audit_log`.
   */
  async reconcileSeniorTeamTx(
    tx: DrizzleTx,
    seniorId: string,
    data: { hrIds?: string[] | undefined; accountantId?: string | null | undefined },
    actorId: string | null,
  ): Promise<void> {
    // Resolve the senior's team via team_members (teams has no seniorId column —
    // a SENIOR is always team_member of exactly one team by business invariant).
    const seniorMembership = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (!seniorMembership) return
    const teamId = seniorMembership.teamId

    const activeMembers: Array<{ userId: string; id: string; role: User['role'] }> = await tx
      .select({
        userId: teamMembers.userId,
        id: teamMembers.id,
        role: users.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))

    const now = new Date()

    const desiredHrIds = new Set(data.hrIds ?? [])
    const currentHrIds = new Set(activeMembers.filter((m) => m.role === 'HR').map((m) => m.userId))
    const currentAccId = activeMembers.find((m) => m.role === 'ACCOUNTANT')?.userId ?? null
    // To add: desired but not currently active.
    const hrToAdd = [...desiredHrIds].filter((id) => !currentHrIds.has(id))
    const accToAdd =
      data.accountantId && data.accountantId !== currentAccId ? data.accountantId : null
    // SR-M-1 follow-up (#999): only NEWLY enrolled members are role-checked (an existing member
    // who was archived since must not block unrelated edits), and BEFORE the first write below
    // so a rejection leaves the team untouched.
    await assertTeamStaffRoles(tx, hrToAdd, accToAdd)

    if (data.hrIds !== undefined) {
      // To remove: currently active HR not in desired set.
      const toRemove = [...currentHrIds].filter((id) => !desiredHrIds.has(id))
      const toAdd = hrToAdd

      for (const userId of toRemove) {
        await tx
          .update(teamMembers)
          .set({ leftAt: now })
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.userId, userId),
              isNull(teamMembers.leftAt),
            ),
          )
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_removed',
            changes: {
              userId: { before: userId, after: null },
              role: { before: 'HR', after: null },
            },
          },
          tx,
        )
      }
      for (const userId of toAdd) {
        await this.upsertTeamMemberTx(tx, teamId, userId)
        await this.teamAuditLogService.record(
          {
            actorId,
            targetId: teamId,
            action: 'team_member_added',
            changes: {
              userId: { before: null, after: userId },
              role: { before: null, after: 'HR' },
            },
          },
          tx,
        )
      }
    }

    if (data.accountantId !== undefined) {
      const desiredId = data.accountantId ?? null
      const currentId = currentAccId

      if (currentId !== desiredId) {
        if (currentId) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(
              and(
                eq(teamMembers.teamId, teamId),
                eq(teamMembers.userId, currentId),
                isNull(teamMembers.leftAt),
              ),
            )
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_removed',
              changes: {
                userId: { before: currentId, after: null },
                role: { before: 'ACCOUNTANT', after: null },
              },
            },
            tx,
          )
        }
        if (desiredId) {
          await this.upsertTeamMemberTx(tx, teamId, desiredId)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_member_added',
              changes: {
                userId: { before: null, after: desiredId },
                role: { before: null, after: 'ACCOUNTANT' },
              },
            },
            tx,
          )
        }
      }
    }
  }

  /**
   * Insert team_member; if row already exists (left previously) — clear leftAt to restore.
   * Uses the supplied transaction handle so it shares the outer atomicity boundary.
   */
  async upsertTeamMemberTx(tx: DrizzleTx, teamId: string, userId: string): Promise<void> {
    const existing = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .then((rows) => rows[0])
    if (existing) {
      if (existing.leftAt !== null) {
        await tx.update(teamMembers).set({ leftAt: null }).where(eq(teamMembers.id, existing.id))
      }
      return
    }
    await tx.insert(teamMembers).values({ teamId, userId })
  }
}
