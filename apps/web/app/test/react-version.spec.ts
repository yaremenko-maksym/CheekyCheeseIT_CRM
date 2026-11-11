import { version } from 'react'
import { describe, expect, it } from 'vitest'

// Pins the React major the redesign relies on (`use`, `useOptimistic`, ref-as-prop).
// Guards the test resolver only (what Vitest imports). The production bundle is guarded
// separately by `scripts/check-react-bundle.mjs`, run after `vite build`.
describe('React runtime', () => {
  it('is major version 19', () => {
    expect(Number(version.split('.')[0])).toBe(19)
  })
})
