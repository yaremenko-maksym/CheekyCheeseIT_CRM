import { describe, expect, it } from 'vitest'
import { ROLE_TITLE_CASES } from './__fixtures__/role-titles'
import { ROLE_CLASSIFIER_VERSION, classifyRoles } from './role-classifier'
import { expectScaling, SCALING_TEST_TIMEOUT_MS } from '../structuring/__test-helpers__/scaling'

describe('classifyRoles', () => {
  it.each(ROLE_TITLE_CASES)('$title $tags', ({ title, tags, expected }) =>
    expect(classifyRoles({ title, tags: tags ?? [] })).toEqual(expected),
  )

  it('a title keyword always overrides a board category', () => {
    expect(classifyRoles({ title: 'Backend Engineer', tags: ['Front End', 'Android'] })).toEqual({
      kind: 'ROLES',
      roles: ['BACKEND_ENGINEER'],
    })
    expect(classifyRoles({ title: 'Python Developer', tags: ['Data Science'] })).toEqual({
      kind: 'ROLES',
      roles: ['BACKEND_ENGINEER'],
    })
  })

  it('never returns SOFTWARE_ENGINEER together with another role', () => {
    const inputs = [
      ...ROLE_TITLE_CASES.map(({ title, tags }) => ({ title, tags: tags ?? [] })),
      { title: 'Software Engineer', tags: ['software-development', 'iOS'] },
      { title: 'Developer', tags: ['software-development'] },
    ]
    const mixed = inputs.filter((input) => {
      const result = classifyRoles(input)
      return (
        result.kind === 'ROLES' &&
        result.roles.includes('SOFTWARE_ENGINEER') &&
        result.roles.length > 1
      )
    })
    expect(mixed).toEqual([])
  })

  it('a generic title with only a generic board category stays SOFTWARE_ENGINEER', () => {
    expect(classifyRoles({ title: 'Developer', tags: ['software-development'] })).toEqual({
      kind: 'ROLES',
      roles: ['SOFTWARE_ENGINEER'],
    })
  })

  it('an unclassified title with no eq category stays UNCLASSIFIED', () => {
    expect(classifyRoles({ title: 'Team Lead', tags: [] })).toEqual({ kind: 'UNCLASSIFIED' })
  })

  it('the fixture table is well-formed', () => {
    expect(ROLE_TITLE_CASES.length).toBeGreaterThanOrEqual(120)
    const malformed = ROLE_TITLE_CASES.filter(
      ({ title, tags }) =>
        title.trim() === '' ||
        (tags !== undefined && (tags.length === 0 || tags.some((tag) => tag.trim() === ''))),
    )
    expect(malformed).toEqual([])
  })

  it('matches the Cyrillic engineer + security pair on any line, never across a line break', () => {
    // Anchored at a line start (SR-H-2): a later line still matches, as it did unanchored.
    expect(classifyRoles({ title: 'Менеджер\nІнженер з кібербезпеки', tags: [] })).toEqual({
      kind: 'ROLES',
      roles: ['SECURITY_ENGINEER', 'SECURITY_ANALYST'],
    })
    expect(classifyRoles({ title: 'Інженер\nкібербезпека', tags: [] })).toEqual({
      kind: 'ROLES',
      roles: ['SECURITY_ANALYST'],
    })
  })

  it.each([
    ['the SR-H-2 filler', (n: number) => `архітектор проєктувальн${' '.repeat(n - 24)}x`],
    ['an engineer noun before a space run', (n: number) => `інженер ${' '.repeat(n - 9)}x`],
  ])(
    'classifies a title with %s in linear time: 4x the length, about 4x the cost',
    (_, filler) => {
      // Measured 2026-11-25 (Apple silicon, 2,000 chars): median 28.1 ms per title before the
      // line-start anchor (117.5 ms on a less warm engine; the two `(?=.*інженер)` patterns rescanned
      // the line from every position), about 0.5 ms after. `expectScaling` bounds the CPU-time ratio,
      // not a wall-clock budget, so a loaded host cannot fail it: linear is about 4, quadratic 16+.
      const small = filler(500)
      const big = filler(2_000)
      const twentyRuns = (title: string) => () => {
        for (let i = 0; i < 20; i++) classifyRoles({ title, tags: [] })
      }
      expectScaling(twentyRuns(small), twentyRuns(big), 8)
    },
    SCALING_TEST_TIMEOUT_MS,
  )

  it('carries a version for re-classification', () => {
    expect(ROLE_CLASSIFIER_VERSION).toBe('rc.2')
  })
})
