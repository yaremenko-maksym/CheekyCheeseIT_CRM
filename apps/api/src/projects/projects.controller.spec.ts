import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsController } from './projects.controller'

/**
 * task-648-fix-round-1 (mutation-gate NoCoverage gap-fill). The three
 * senior-share routes (`approve`/`reject`/`cancel`) are thin
 * `return this.projectsService.<method>(...)` wrappers — a mutant replacing
 * the WHOLE body with `{}` returns `undefined` instead of the service's
 * result, a real regression an HTTP caller would notice as an empty
 * response body. `senior-share-guard-stack.controller.integration.spec.ts`
 * (SR-M-4) proves the surrounding guard stack against a REAL app, but it is
 * an `*.integration.spec.ts` file the mutation gate cannot execute
 * (mutation-gate-integration-specs.md) — these tests give the gate a unit
 * double to run for the exact lines it flagged.
 *
 * No prior `projects.controller.spec.ts` existed — `ProjectsController`'s
 * other routes are exercised only through `*.rbac.integration.spec.ts`
 * files, same reasoning `senior-drop-mask.rbac.integration.spec.ts` and
 * siblings already document for this controller. This file is scoped to
 * only the three routes this task added, not a retrofit of the whole
 * controller.
 */

const senior: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior One',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const admin: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeController(
  projectsService: Record<string, ReturnType<typeof vi.fn>>,
): ProjectsController {
  return new ProjectsController(projectsService as never, { record: vi.fn() } as never)
}

describe('ProjectsController — senior-share approve/reject/cancel delegate to the service', () => {
  it('approveSeniorShareChange: calls the service with (id, currentUser) and returns its result verbatim', async () => {
    const resolved = { id: 'proj-1', effectiveSeniorSharePercent: 55 }
    const projectsService = { approveSeniorShareChange: vi.fn().mockResolvedValue(resolved) }
    const controller = makeController(projectsService)

    const result = await controller.approveSeniorShareChange('proj-1', senior)

    expect(projectsService.approveSeniorShareChange).toHaveBeenCalledWith('proj-1', senior)
    expect(result).toBe(resolved)
  })

  it('rejectSeniorShareChange: parses the body, calls the service with (id, reason, currentUser), returns its result verbatim', async () => {
    const resolved = { id: 'proj-1', pendingSeniorShare: null }
    const projectsService = { rejectSeniorShareChange: vi.fn().mockResolvedValue(resolved) }
    const controller = makeController(projectsService)

    const result = await controller.rejectSeniorShareChange(
      'proj-1',
      { reason: 'не согласовано' },
      senior,
    )

    expect(projectsService.rejectSeniorShareChange).toHaveBeenCalledWith(
      'proj-1',
      'не согласовано',
      senior,
    )
    expect(result).toBe(resolved)
  })

  it('rejectSeniorShareChange: an empty reason never reaches the service (schema-level 400)', () => {
    const projectsService = { rejectSeniorShareChange: vi.fn() }
    const controller = makeController(projectsService)

    // `.parse()` throws SYNCHRONOUSLY inside this non-`async` method, before
    // any promise exists to reject — `.rejects` would not observe it.
    expect(() => controller.rejectSeniorShareChange('proj-1', { reason: '' }, senior)).toThrow()
    expect(projectsService.rejectSeniorShareChange).not.toHaveBeenCalled()
  })

  it('cancelSeniorShareChange: calls the service with (id, currentUser) and returns its result verbatim', async () => {
    const resolved = { id: 'proj-1', pendingSeniorShare: null }
    const projectsService = { cancelSeniorShareChange: vi.fn().mockResolvedValue(resolved) }
    const controller = makeController(projectsService)

    const result = await controller.cancelSeniorShareChange('proj-1', admin)

    expect(projectsService.cancelSeniorShareChange).toHaveBeenCalledWith('proj-1', admin)
    expect(result).toBe(resolved)
  })
})
