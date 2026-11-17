import { Reflector } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ROLES_KEY } from '../common/decorators/roles.decorator'
import { SeniorAvailabilityController } from './senior-availability.controller'
import type { SeniorAvailabilityService } from './senior-availability.service'

// PR #1337 CR-L: the controller is a thin pass-through; what it must keep is the viewer id it
// hands the service (never the target) and the coarse `@Roles` gate on both routes.
const VIEWER = { id: '5a110014-0000-4000-bb00-0000000000a1', role: 'ADMIN' } as SessionUser
const TARGET = '5a110014-0000-4000-bb00-0000000000a2'

function make() {
  const svc = {
    get: vi.fn().mockResolvedValue({ status: 'BUSY' }),
    set: vi.fn().mockResolvedValue({ status: 'BUSY' }),
  }
  return { svc, ctl: new SeniorAvailabilityController(svc as unknown as SeniorAvailabilityService) }
}

describe('SeniorAvailabilityController', () => {
  it('GET passes (viewer id, target id) and returns the service result', async () => {
    const { svc, ctl } = make()
    await expect(ctl.get(VIEWER, TARGET)).resolves.toEqual({ status: 'BUSY' })
    expect(svc.get).toHaveBeenCalledWith(VIEWER.id, TARGET)
  })

  it('PUT passes (viewer id, target id, raw body) for the service to parse', async () => {
    const { svc, ctl } = make()
    const body = { status: 'BUSY' }
    await expect(ctl.set(VIEWER, TARGET, body)).resolves.toEqual({ status: 'BUSY' })
    expect(svc.set).toHaveBeenCalledWith(VIEWER.id, TARGET, body, undefined)
  })

  it('PUT under impersonation hands the real operator to the service for the audit row', async () => {
    const { svc, ctl } = make()
    const OPERATOR = '5a110014-0000-4000-bb00-0000000000a9'
    await ctl.set({ ...VIEWER, impersonatorId: OPERATOR }, TARGET, { status: 'BUSY' })
    expect(svc.set).toHaveBeenCalledWith(VIEWER.id, TARGET, { status: 'BUSY' }, OPERATOR)
  })

  it.each(['get', 'set'] as const)('%s is gated to ADMIN and SENIOR', (handler) => {
    const roles = new Reflector().get<string[]>(
      ROLES_KEY,
      SeniorAvailabilityController.prototype[handler],
    )
    expect(roles).toEqual(['ADMIN', 'SENIOR'])
  })
})
