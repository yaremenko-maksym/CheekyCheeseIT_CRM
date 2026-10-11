import { NOTIFICATION_TITLES } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import type { CreateNotificationInput } from '../notifications/notifications.service'
import type { TeamWithMembers } from './team-mapping.util'

/**
 * Кому уходит событие «в команде прибыло» — и кому НЕ уходит.
 *
 * Правило раскрытия здесь не про деньги, а про личность, и оно уже
 * зафиксировано в `mapTeam` (team-mapping.util): SENIOR не видит джунов вовсе, а JUNIOR
 * видит среди джунов только себя. Уведомление обязано подчиняться тому же
 * контуру — иначе колокольчик рассказывал бы то, что экран прячет, и это был
 * бы обход маскировки, а не её частный случай.
 *
 * Автору действия не пишем: своё подтверждает тост, а не колокольчик (§8.1).
 */
export function buildTeamMemberAddedNotifications(input: {
  teamId: string
  teamName: string
  addedUserId: string
  addedUserRole: string
  addedUserName: string
  members: TeamWithMembers['members']
  currentUser: SessionUser
}): CreateNotificationInput[] {
  const actorId = input.currentUser.impersonatorId ?? input.currentUser.id
  const out: CreateNotificationInput[] = []

  if (input.addedUserId !== actorId) {
    out.push({
      userId: input.addedUserId,
      type: 'TEAM_MEMBER_ADDED',
      title: NOTIFICATION_TITLES.TEAM_MEMBER_ADDED,
      subjectType: 'TEAM',
      subjectId: input.teamId,
      data: { teamName: input.teamName },
    })
  }

  const addedIsJunior = input.addedUserRole === 'JUNIOR'
  for (const member of input.members) {
    if (member.leftAt !== null) continue
    if (member.userId === input.addedUserId) continue
    if (member.userId === actorId) continue
    // SR-M-1 (security-review круг 1): роль НЕИЗВЕСТНА — значит самая
    // ограниченная, а не «никакая». `?? null` открывал рассылку в
    // непроверяемую сторону: строка членства без подтянутого профиля не
    // попадала ни под одно условие и получала имя джуна.
    //
    // `mapTeam` / `mapDropTeam` (team-mapping.util) после #541 идут именно так
    // («a dangling identity is treated as the MOST restricted role, not the
    // least»), и производитель обязан повторять их контур: колокольчик не
    // имеет права рассказывать то, что прячет экран.
    const memberRole = member.user?.role ?? 'JUNIOR'
    // `mapTeam`: SENIOR не видит джунов, JUNIOR видит среди джунов только себя.
    if (addedIsJunior && (memberRole === 'SENIOR' || memberRole === 'JUNIOR')) continue
    out.push({
      userId: member.userId,
      type: 'TEAM_NEW_MEMBER',
      title: NOTIFICATION_TITLES.TEAM_NEW_MEMBER,
      subjectType: 'TEAM',
      subjectId: input.teamId,
      secondaryId: input.addedUserId,
      data: { teamName: input.teamName, memberName: input.addedUserName },
    })
  }

  return out
}
