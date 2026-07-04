import { describe, expect, it } from 'vitest'
import { CompanyAccountController } from './company-account.controller'

/**
 * AC4 — getDepositStatus throttle.
 *
 * GET /company-account/deposits/:id/status is a polling endpoint that calls
 * verifyDeposit on every request. Without throttling a client can spam it and
 * trigger excessive Etherscan API calls (rate-limit abuse). A RelaxableThrottle
 * decorator must be present on the handler.
 *
 * We check via NestJS's metadata system: @Throttle() stores its per-key config
 * on the method descriptor as individual metadata entries:
 *   THROTTLER:LIMITdefault  — limit Resolvable (function)
 *   THROTTLER:TTLdefault    — ttl Resolvable (function)
 *
 * If the decorator is absent those keys will be absent from the descriptor.
 */

describe('AC4: CompanyAccountController.getDepositStatus — @RelaxableThrottle present', () => {
  it('getDepositStatus has throttle metadata on its handler', () => {
    const prototype = CompanyAccountController.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getDepositStatus')

    expect(descriptor).toBeDefined()

    // @Throttle() via RelaxableThrottle writes per-key metadata entries.
    // THROTTLER:LIMITdefault is the presence-sentinel for the 'default' throttler key.
    const limitMeta = Reflect.getMetadata('THROTTLER:LIMITdefault', descriptor!.value as object)
    const ttlMeta = Reflect.getMetadata('THROTTLER:TTLdefault', descriptor!.value as object)

    expect(limitMeta).toBeDefined()
    expect(ttlMeta).toBeDefined()
    // Both must be Resolvable functions (RelaxableThrottle uses () => ... callbacks)
    expect(typeof limitMeta).toBe('function')
    expect(typeof ttlMeta).toBe('function')
  })

  it('getDepositStatus throttle limit function returns a positive number', () => {
    const prototype = CompanyAccountController.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getDepositStatus')!
    const limitFn = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      descriptor.value as object,
    ) as () => number

    const limit = limitFn()
    expect(typeof limit).toBe('number')
    expect(limit).toBeGreaterThan(0)
  })
})
