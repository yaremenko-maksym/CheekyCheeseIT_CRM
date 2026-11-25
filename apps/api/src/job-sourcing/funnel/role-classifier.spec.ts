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
    'classifies a title with %s in linear time: 8x the length, about 8x the cost',
    (_, filler) => {
      // Measured 2026-11-25 (Apple silicon), ms per title at 500 / 4,000 chars:
      //   Node 22 (CI, prod): before the line-start anchor 3.2-4.5 / 99-103 (22-32x), after 2.0-2.2 / 15.5-16.4 (7.5-7.7x)
      //   Node 26:            before 1.4 / 88 (62-65x), after 0.08 / 0.5 (6.3-6.5x)
      // Before, the two `(?=.*інженер)` patterns rescanned the line from every position. 4,000 against
      // 500 chars, not 2,000: on Node 22 the old patterns at 2,000 chars stayed within a bound of 8
      // (a linear per-position cost of every pattern hides the quadratic term at small sizes).
      // `expectScaling` bounds the CPU-time ratio, not a wall-clock budget, so a loaded host cannot
      // fail it.
      const small = filler(500)
      const big = filler(4_000)
      const twentyRuns = (title: string) => () => {
        for (let i = 0; i < 20; i++) classifyRoles({ title, tags: [] })
      }
      expectScaling(twentyRuns(small), twentyRuns(big), 16)
    },
    SCALING_TEST_TIMEOUT_MS,
  )

  it('carries a version for re-classification', () => {
    expect(ROLE_CLASSIFIER_VERSION).toBe('rc.2')
  })
})
