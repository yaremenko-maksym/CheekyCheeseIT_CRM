import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsController } from './projects.controller'

/**
 * task-project-draft-status — mutation-gate closes the one real (non-heuristic)
 * NoCoverage gap left after the full-scope run: `POST :id/approve` and
 * `POST :id/reject` are one-line passthroughs, and no test in the repo — unit
 * OR integration — invoked either route. `looksIntegrationOnly()` correctly
 * reported "no hint" for both: no `*.integration.spec.ts` imports
 * `projects.controller` by path, because this repo's integration specs drive
 * routes through supertest against the real app, not through the controller
 * file directly, and none of them happens to exercise these two routes yet.
 * That is a genuine gap, not a heuristic miss — closed here at the unit
 * level, same pattern as `users.controller.spec.ts`.
 */

const session = (): SessionUser => ({
  id: 'user-1',
  email: 'a@b.c',
  displayName: 'X',
  role: 'SENIOR',
  avatar: null,
})

const buildController = () => {
  const projectsService = {
    approveDraft: vi.fn().mockResolvedValue({ id: 'proj-1', status: 'ACTIVE' }),
    rejectDraft: vi.fn().mockResolvedValue({ id: 'proj-1', status: 'REJECTED' }),
  }
  const controller = new ProjectsController(
    projectsService as never,
    {} as never, // ProjectAuditLogService — unused by these two routes
  )
  return { controller, projectsService }
}

describe('ProjectsController.approveDraft', () => {
  it('delegates to ProjectsService.approveDraft with the route param and caller', async () => {
    const { controller, projectsService } = buildController()
    const user = session()

    const result = await controller.approveDraft('proj-1', user)

    expect(projectsService.approveDraft).toHaveBeenCalledWith('proj-1', user)
    expect(result).toEqual({ id: 'proj-1', status: 'ACTIVE' })
  })
})

describe('ProjectsController.rejectDraft', () => {
  it('parses the reason from the body and delegates to ProjectsService.rejectDraft', async () => {
    const { controller, projectsService } = buildController()
    const user = session()

    const result = await controller.rejectDraft('proj-1', { reason: 'Бюджет не подтверждён' }, user)

    expect(projectsService.rejectDraft).toHaveBeenCalledWith(
      'proj-1',
      'Бюджет не подтверждён',
      user,
    )
    expect(result).toEqual({ id: 'proj-1', status: 'REJECTED' })
  })

  it('rejects a body without a reason via rejectProjectSchema (never reaches the service)', () => {
    const { controller, projectsService } = buildController()

    expect(() => controller.rejectDraft('proj-1', {}, session())).toThrow()
    expect(projectsService.rejectDraft).not.toHaveBeenCalled()
  })
})
