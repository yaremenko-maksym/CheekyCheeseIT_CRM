import { version } from 'react'
import { describe, expect, it } from 'vitest'

// Pins the React major the redesign relies on (`use`, `useOptimistic`, ref-as-prop).
describe('React runtime', () => {
  it('is major version 19', () => {
    expect(Number(version.split('.')[0])).toBe(19)
  })
})
