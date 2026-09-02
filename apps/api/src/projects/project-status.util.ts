/**
 * project-status.util — the fused fetch+check choke point for "does this
 * project accept transactions yet". task-project-draft-status, decision Д2:
 *
 * "На уровне сервиса, слитой парой «выборка + проверка» в одном вызове» —
 * по образцу transaction-visibility.util.ts. Причина ровно та, что записана
 * в комментарии к запрету на transactions: разнесённые выборка и проверка
 * дают обход «удали только проверку», и на PR #456 его продемонстрировали."
 *
 * `assertProjectActive` takes the RESULT of a fetch (already awaited) and
 * returns the narrowed, non-null project — the caller writes
 * `const project = assertProjectActive(await db.query.projects.findFirst(...))`
 * as ONE statement. Deleting only the status check would require deleting
 * the whole statement, which also removes the `project` binding every line
 * after it depends on — there is no longer a line to delete that removes
 * ONLY the guard while the fetch (and the rest of the function) keeps
 * compiling, the same shape `assertFoundAndVisible` uses for transactions.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { ProjectStatus } from '@crm/shared'

export const PROJECT_NOT_ACTIVE_MESSAGE =
  'Проект ещё не подтверждён — операции с ним недоступны до подтверждения'

/**
 * Fused not-found + status guard. `status` is checked because a project only
 * accepts transactions once it is `ACTIVE` (Д2) — a `DRAFT` was never agreed
 * to and a `REJECTED` one was explicitly declined; money must not move
 * against either.
 */
export function assertProjectActive<T extends { status: ProjectStatus }>(
  project: T | undefined | null,
): T {
  if (!project) throw new NotFoundException('Project not found')
  if (project.status !== 'ACTIVE') {
    throw new BadRequestException(PROJECT_NOT_ACTIVE_MESSAGE)
  }
  return project
}
