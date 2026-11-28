/**
 * PR #1521 (ACCOUNTANT removed): `ProjectsService.update` is open to ADMIN and
 * HR only. Every other role, and an unknown one, is refused with 403 BEFORE
 * the project is looked up — a 404 for them would leak which ids exist.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsService } from './projects.service'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'

function makeService(): { service: ProjectsService; projectLookup: ReturnType<typeof vi.fn> } {
  const projectLookup = vi.fn().mockResolvedValue(undefined)
  const db = { db: { query: { projects: { findFirst: projectLookup } } } }
  const service = new ProjectsService(
    db as never,
    { record: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    makeNotificationsStub(),
  )
  return { service, projectLookup }
}

const caller = (role: string) => ({ id: `${role}-id`, role }) as unknown as SessionUser

describe('ProjectsService.update — role gate', () => {
  it.each(['SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT', 'GUEST'])(
    '%s → 403 before the project lookup',
    async (role) => {
      const { service, projectLookup } = makeService()
      await expect(service.update('p-1', { name: 'X' }, caller(role))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(projectLookup).not.toHaveBeenCalled()
    },
  )

  it.each(['ADMIN', 'HR'])('%s passes the gate (reaches the lookup → 404)', async (role) => {
    const { service, projectLookup } = makeService()
    await expect(service.update('p-1', { name: 'X' }, caller(role))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    })
    expect(projectLookup).toHaveBeenCalledOnce()
  })
})
