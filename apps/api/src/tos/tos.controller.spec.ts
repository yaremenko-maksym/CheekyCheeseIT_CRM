import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TosController } from './tos.controller'

/**
 * Fix-раунд 3 (task-680, SR-M-3). Same class of risk as
 * `signed-contracts.controller.spec.ts` (SR-H-1): `accept()`'s entire
 * прод-эффект for the impersonation guard depends on ONE line —
 * `impersonatorId: user.impersonatorId ?? null` — that propagates the flag
 * from `SessionUser` into `TosService.accept`. `tos.service.spec.ts` only
 * exercises the service directly with a hand-supplied `impersonatorId`; this
 * file is the unit-double for the controller→service wiring (mutation-gate
 * cannot see `*.integration.spec.ts`, see
 * `mutation-gate-integration-specs.md`).
 */

const mkReq = (ip = '127.0.0.1', ua = 'Mozilla/5.0'): FastifyRequest =>
  ({ ip, headers: { 'user-agent': ua } }) as unknown as FastifyRequest

function makeController(service: Record<string, ReturnType<typeof vi.fn>>): TosController {
  return new TosController(service as never, {} as never)
}

const junior: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior One',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const impersonated: SessionUser = {
  ...junior,
  impersonating: true,
  impersonatorId: 'admin-1',
}

describe('TosController.accept — impersonatorId propagation (SR-M-3)', () => {
  it('passes SessionUser.impersonatorId through to the service under impersonation', () => {
    const service = { accept: vi.fn().mockReturnValue('accepted') }
    const controller = makeController(service)

    controller.accept(impersonated, mkReq())

    expect(service.accept).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'junior-1', impersonatorId: 'admin-1' }),
    )
  })

  it('passes null when the session is not impersonated', () => {
    const service = { accept: vi.fn().mockReturnValue('accepted') }
    const controller = makeController(service)

    controller.accept(junior, mkReq())

    expect(service.accept).toHaveBeenCalledWith(expect.objectContaining({ impersonatorId: null }))
  })
})
