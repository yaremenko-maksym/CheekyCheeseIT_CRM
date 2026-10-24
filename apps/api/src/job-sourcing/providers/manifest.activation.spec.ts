import { describe, expect, it } from 'vitest'
import type { Manifest } from './manifest'
import { activationFactsByType } from './manifest.activation'

type T = Manifest['types'][number]

/** Only the fields `readinessAt` and the facts read; hand-built so the expected values are literals. */
const type = (over: Partial<T> & Pick<T, 'type'>): T =>
  ({ blockers: [], deadlines: [], payloadVerified: true, ...over }) as unknown as T

describe('activationFactsByType', () => {
  const NOW = new Date('2027-02-10T00:00:00.000Z')

  it('maps every manifest type to its readiness at the clock, its blocker codes and its payload flag', () => {
    const facts = activationFactsByType(
      {
        types: [
          type({ type: 'REMOTEOK_API' }),
          type({
            type: 'SMARTRECRUITERS_ATS',
            blockers: [{ code: 'NO_API_CAPTURE', detail: 'x' }],
            payloadVerified: false,
          }),
        ],
      },
      NOW,
    )
    expect([...facts.keys()]).toEqual(['REMOTEOK_API', 'SMARTRECRUITERS_ATS'])
    expect(facts.get('REMOTEOK_API')).toEqual({
      readiness: 'CANDIDATE',
      blockerCodes: [],
      payloadVerified: true,
    })
    expect(facts.get('SMARTRECRUITERS_ATS')).toEqual({
      readiness: 'BLOCKED',
      blockerCodes: ['NO_API_CAPTURE'],
      payloadVerified: false,
    })
  })

  it('a deadline that has passed at the clock adds its blocker; before it, none', () => {
    const t = type({
      type: 'RECRUITEE_ATS',
      deadlines: [
        { kind: 'AUTH_REQUIRED_FROM', at: new Date('2027-02-10T00:00:00.000Z'), symbol: 'D' },
      ],
    })
    const before = activationFactsByType({ types: [t] }, new Date('2027-02-09T23:59:59.999Z'))
    const at = activationFactsByType({ types: [t] }, NOW)
    expect(before.get('RECRUITEE_ATS')).toEqual({
      readiness: 'CANDIDATE',
      blockerCodes: [],
      payloadVerified: true,
    })
    expect(at.get('RECRUITEE_ATS')).toEqual({
      readiness: 'BLOCKED',
      blockerCodes: ['AUTH_DEADLINE_PASSED'],
      payloadVerified: true,
    })
  })

  it('an empty manifest yields no facts', () => {
    expect(activationFactsByType({ types: [] }, NOW).size).toBe(0)
  })
})
