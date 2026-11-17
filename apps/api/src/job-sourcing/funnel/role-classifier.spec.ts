import { describe, expect, it } from 'vitest'
import { ROLE_TITLE_CASES } from './__fixtures__/role-titles'
import { ROLE_CLASSIFIER_VERSION, classifyRoles } from './role-classifier'

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

  it('carries a version for re-classification', () => {
    expect(ROLE_CLASSIFIER_VERSION).toBe('rc.1')
  })
})
