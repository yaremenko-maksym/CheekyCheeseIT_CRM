import type { FastifyRequest } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { SignedContractsController } from './signed-contracts.controller'

/**
 * task-680-fix-round-2 (SR-H-1). `sign()`'s ENTIRE прод-эффект держится на
 * одной строке — `impersonatorId: user.impersonatorId ?? null` — которая
 * прокидывает флаг «войти как» из `SessionUser` в `SignedContractsService`.
 * Ни `signed-contracts.service.spec.ts` (передаёт `impersonatorId` руками),
 * ни `onboarding-contract.integration.spec.ts` (зовёт сервис напрямую, минуя
 * контроллер — сам файл это документирует), ни sentinel-контроллеры в
 * соседних integration-спеках эту строку не касаются: удали её — и весь
 * набор тестов этого PR останется зелёным, а гвард молча перестанет
 * работать в проде. Этот файл — юнит-двойник (mutation-gate НЕ видит
 * `*.integration.spec.ts`, см. `mutation-gate-integration-specs.md`) ровно
 * для этой строки, без БД и без Nest testing module — тот же паттерн, что
 * `projects.controller.spec.ts` уже использует для thin-wrapper роутов.
 */

const mkReq = (ip = '127.0.0.1', ua = 'Mozilla/5.0'): FastifyRequest =>
  ({ ip, headers: { 'user-agent': ua } }) as unknown as FastifyRequest

function makeController(
  service: Record<string, ReturnType<typeof vi.fn>>,
): SignedContractsController {
  return new SignedContractsController(service as never, {} as never, {} as never)
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

describe('SignedContractsController.sign — impersonatorId propagation (SR-H-1)', () => {
  it('passes SessionUser.impersonatorId through to the service under impersonation', () => {
    const service = { sign: vi.fn().mockReturnValue('signed') }
    const controller = makeController(service)

    controller.sign({}, impersonated, mkReq())

    expect(service.sign).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'junior-1', impersonatorId: 'admin-1' }),
    )
  })

  it('passes null when the session is not impersonated', () => {
    const service = { sign: vi.fn().mockReturnValue('signed') }
    const controller = makeController(service)

    controller.sign({}, junior, mkReq())

    expect(service.sign).toHaveBeenCalledWith(expect.objectContaining({ impersonatorId: null }))
  })
})
