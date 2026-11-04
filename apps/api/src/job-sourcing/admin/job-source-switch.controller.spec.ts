import { RequestMethod } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import type { SessionUser } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { ROLES_KEY } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { JobSourceSwitchController } from './job-source-admin.controller'
import type { JobSourceAdminService } from './job-source-admin.service'

/**
 * r5 Task 6.5 — unit doubles for the switch controller (the mutation gate never runs the
 * integration specs). The guard chain itself is pinned by job-source-admin-rbac.integration.spec.ts.
 */
const ADMIN = { id: 'a', role: 'ADMIN' } as SessionUser
const SOURCE = '11111111-2222-4333-8444-555555555555'
const RESULT = { id: SOURCE, enabled: false, changed: true, cancelledRuns: 1 }

function harness(result: unknown = RESULT) {
  const service = { setEnabled: vi.fn(async () => result) }
  return {
    controller: new JobSourceSwitchController(service as unknown as JobSourceAdminService),
    service,
  }
}

const handler = JobSourceSwitchController.prototype.setEnabled

describe('JobSourceSwitchController — routing and gates', () => {
  it('is PATCH /job-sourcing/sources/:id', () => {
    expect(Reflect.getMetadata(PATH_METADATA, JobSourceSwitchController)).toBe('job-sourcing')
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('sources/:id')
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH)
  })

  it('runs RolesGuard, and the handler is ADMIN only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, JobSourceSwitchController)).toEqual([RolesGuard])
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['ADMIN'])
  })

  it('is throttled at 30 per minute', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(30)
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000)
  })
})

describe('JobSourceSwitchController — body and answer', () => {
  it.each([true, false])('passes { enabled: %s }, the id and the caller', async (enabled) => {
    const h = harness()
    expect(await h.controller.setEnabled(SOURCE, { enabled }, ADMIN)).toEqual(RESULT)
    expect(h.service.setEnabled).toHaveBeenCalledWith(SOURCE, { enabled }, ADMIN)
  })

  it.each([
    undefined,
    {},
    { enabled: 'false' },
    { enabled: true, config: {} },
    { enabled: true, readiness: 'VERIFIED' },
  ])('refuses body %j before the service is called', async (body) => {
    const h = harness()
    await expect(h.controller.setEnabled(SOURCE, body, ADMIN)).rejects.toThrow(ZodError)
    expect(h.service.setEnabled).not.toHaveBeenCalled()
  })

  it('parses the service answer (a malformed one never reaches the wire)', async () => {
    const h = harness({ ...RESULT, cancelledRuns: -1 })
    await expect(h.controller.setEnabled(SOURCE, { enabled: false }, ADMIN)).rejects.toThrow(
      ZodError,
    )
  })
})
