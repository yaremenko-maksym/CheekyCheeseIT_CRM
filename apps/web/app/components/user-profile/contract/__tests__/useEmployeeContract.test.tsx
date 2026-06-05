import { describe, expect, it } from 'vitest'
import { contractActionState } from '../useEmployeeContract'

// Test the pure contractActionState helper per the §4 lifecycle/action matrix.
// Hook integration (useQuery/useMutation) is covered by E2E on the real stack.

describe('contractActionState', () => {
  it('DRAFT: editable, Save + MarkReady + Reset visible, Revert hidden', () => {
    const s = contractActionState('DRAFT')
    expect(s.editable).toBe(true)
    expect(s.showSave).toBe(true)
    expect(s.showMarkReady).toBe(true)
    expect(s.showReset).toBe(true)
    expect(s.showRevert).toBe(false)
    expect(s.revertDestructive).toBe(false)
  })

  it('READY_TO_SIGN: read-only, Revert visible, Save + MarkReady + Reset hidden', () => {
    const s = contractActionState('READY_TO_SIGN')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(true)
    expect(s.revertDestructive).toBe(false)
  })

  it('SIGNED: read-only, only destructive Revert visible', () => {
    const s = contractActionState('SIGNED')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(true)
    expect(s.revertDestructive).toBe(true)
  })

  it('CANCELLED: all hidden, not editable', () => {
    const s = contractActionState('CANCELLED')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(false)
    expect(s.revertDestructive).toBe(false)
  })
})
