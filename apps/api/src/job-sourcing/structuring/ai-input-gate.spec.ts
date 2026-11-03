import { describe, expect, it } from 'vitest'
import { assertModelAllowed } from './ai-input-gate'

describe('assertModelAllowed', () => {
  it.each(['allow', 'block'] as const)(
    'ai-input=no is BLOCKED whatever onUnspecified says (%s)',
    (onUnspecified) => {
      expect(assertModelAllowed('no', { onUnspecified })).toBe('BLOCKED_AI_INPUT_NO')
    },
  )

  it.each(['allow', 'block'] as const)(
    'ai-input=yes is ALLOWED (onUnspecified=%s)',
    (onUnspecified) => {
      expect(assertModelAllowed('yes', { onUnspecified })).toBe('ALLOWED')
    },
  )

  it('ai-input=unspecified follows an explicit allow', () => {
    expect(assertModelAllowed('unspecified', { onUnspecified: 'allow' })).toBe('ALLOWED')
  })

  it('ai-input=unspecified follows an explicit block', () => {
    expect(assertModelAllowed('unspecified', { onUnspecified: 'block' })).toBe(
      'BLOCKED_AI_INPUT_UNSPECIFIED',
    )
  })

  // Values arriving from an untyped source (a parsed header, a DB row) fail closed.
  it.each([
    ['NO', 'allow'],
    ['', 'allow'],
    [undefined, 'allow'],
    ['yes ', 'allow'],
    ['unspecified', 'ALLOW'],
    ['unspecified', undefined],
  ])('an unrecognised value (%j, onUnspecified=%j) is blocked', (aiInput, onUnspecified) => {
    const decision = assertModelAllowed(aiInput as never, { onUnspecified } as never)
    expect(decision).not.toBe('ALLOWED')
  })

  it('an unrecognised ai-input value reports the ai-input=no block, not the unspecified one', () => {
    expect(assertModelAllowed('NO' as never, { onUnspecified: 'allow' })).toBe(
      'BLOCKED_AI_INPUT_NO',
    )
  })

  it('calling without choosing onUnspecified is a type error (checked by typecheck:specs)', () => {
    // Never executed: the assertions are the @ts-expect-error lines, which fail `tsc -p tsconfig.spec.json`
    // the moment a default makes the argument optional.
    const typeOnly = (): void => {
      // @ts-expect-error -- the policy argument is required
      assertModelAllowed('unspecified')
      // @ts-expect-error -- onUnspecified has no default
      assertModelAllowed('unspecified', {})
    }
    expect(typeof typeOnly).toBe('function')
  })
})
