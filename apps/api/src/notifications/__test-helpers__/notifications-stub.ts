/**
 * Silent stub of NotificationsService for specs for which the notification producer
 * is indifferent.
 *
 * task-notification-types-producers (item 6) added a dependency on
 * `NotificationsService` in five producer modules. Specs constructing
 * these services directly — dozens, and almost all of them check something else entirely.
 * The stub lives HERE, next to the service itself, so that the next change to its
 * surface is made in one place, not in twenty specs.
 *
 * The dependency is NOT made optional (`@Optional()`) on purpose: that way a forgotten
 * wiring in a module would give a silent "notifications simply do not
 * arrive" — exactly the fail-open-by-omission the MED-2 comment in `teams.service.ts` warns about.
 * A required parameter breaks
 * compilation at once, and loudly.
 */
import { vi } from 'vitest'
import type { NotificationsService } from '../notifications.service'

/**
 * A twin of `emitInTx` for specs that keep THEIR OWN notification twin (those that
 * record what was created into an array and check it).
 *
 * In battle `emitInTx` opens a nested transaction (SAVEPOINT) around the producer's
 * path — SR-H-2. The twin executes the path as is, on the same `tx`:
 * the subject of such specs is WHAT is written, not what gets rolled back. The semantics
 * live here in a single instance, so that five specs do not diverge in their understanding of
 * what "the producer path ran" means.
 */
export function makePassThroughEmitInTx() {
  return vi.fn(async (tx: unknown, produce: (sp: unknown) => Promise<void>) => {
    await produce(tx)
  })
}

export function makeNotificationsStub(): NotificationsService {
  return {
    create: vi.fn().mockResolvedValue(null),
    createInTx: vi.fn().mockResolvedValue(null),
    createManyInTx: vi.fn().mockResolvedValue(undefined),
    emitInTx: makePassThroughEmitInTx(),
  } as unknown as NotificationsService
}
