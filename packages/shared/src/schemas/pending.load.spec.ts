/**
 * Load-time coverage for `pending.ts`'s two module-level union ARRAYS —
 * `z.discriminatedUnion('kind', [...])` and COPY-L-6's
 * `z.union([known, unknown])`.
 *
 * Why a separate file with DYNAMIC imports: those arrays are evaluated once,
 * when the module is first imported, and a spec's static `import` runs during
 * collection — before any individual test does. The mutation gate reports
 * exactly that as «mutant NOT VERIFIED — the test runner executed ZERO tests
 * for it»: emptying either array is a change no test in `pending.spec.ts`
 * can be shown to catch, even though every one of them would fail. Importing
 * the module from inside a test body is what puts the module evaluation
 * INSIDE a test, so the claim "these arrays hold the variants we ship"
 * becomes an assertion instead of an assumption.
 *
 * Deliberately thin: `pending.spec.ts` owns the per-variant edges. This file
 * only pins that the two unions are non-empty and admit the shapes the API
 * actually sends.
 */
import { describe, expect, it } from 'vitest'

const uuid = 'a0000000-0000-4000-8000-000000000001'
const createdAt = '2026-09-01T10:00:00.000Z'

const contractItem = {
  kind: 'CONTRACT_TO_SIGN' as const,
  subjectType: 'USER' as const,
  subjectId: uuid,
  title: 'Ваш контракт',
  createdAt,
  actions: ['open'] as const,
  link: '/profile',
}

describe('pending.ts — the unions are populated at module load, not merely declared', () => {
  it('`pendingItemSchema` accepts a kind the server actually sends — an empty variant list would reject every row', async () => {
    const { pendingItemSchema } = await import('./pending')

    expect(pendingItemSchema.parse(contractItem)).toEqual(contractItem)
  })

  it('`pendingItemClientSchema` holds BOTH arms — the known one and COPY-L-6’s degraded one', async () => {
    const { pendingItemClientSchema } = await import('./pending')

    expect(pendingItemClientSchema.parse(contractItem)).toEqual(contractItem)
    expect(
      pendingItemClientSchema.parse({ kind: 'PAYOUT_TO_CONFIRM', subjectId: uuid, createdAt }),
    ).toEqual({ kind: 'UNKNOWN', subjectId: uuid, createdAt, title: '', actions: [], link: '' })
  })
})
