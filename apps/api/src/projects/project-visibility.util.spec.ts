import { describe, expect, it } from 'vitest'
import { canSeePendingSeniorShare } from './project-visibility.util'

describe('canSeePendingSeniorShare', () => {
  it.each(['ADMIN', 'SENIOR'])('allows %s', (role) => {
    expect(canSeePendingSeniorShare(role)).toBe(true)
  })

  it.each(['JUNIOR', 'HR', 'ACCOUNTANT', 'DROP', 'admin', 'senior', '', undefined])(
    'denies %s',
    (role) => {
      expect(canSeePendingSeniorShare(role)).toBe(false)
    },
  )
})
