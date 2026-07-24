import { describe, expect, it } from 'vitest'
import { FormAbandonTracker } from './form-abandon'

describe('FormAbandonTracker', () => {
  it('opened, never touched, closed → "none" (pristine close is not a signal)', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    expect(tracker.close('vacancy')).toBe('none')
  })

  it('opened, dirtied, closed WITHOUT submit → "abandon"', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    tracker.markDirty('vacancy')
    expect(tracker.close('vacancy')).toBe('abandon')
  })

  it('opened, dirtied, submitted, THEN closed → "submitted" (not abandon)', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    tracker.markDirty('vacancy')
    tracker.markSubmitted('vacancy')
    expect(tracker.close('vacancy')).toBe('submitted')
  })

  it('closing a form that was never opened → "none" (no crash, no phantom signal)', () => {
    const tracker = new FormAbandonTracker()
    expect(tracker.close('never-opened')).toBe('none')
  })

  it('close() clears state — a SECOND close (double unmount) is "none", not a repeat abandon', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    tracker.markDirty('vacancy')
    expect(tracker.close('vacancy')).toBe('abandon')
    expect(tracker.close('vacancy')).toBe('none')
  })

  it('re-opening after a close starts a FRESH (non-dirty) state', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    tracker.markDirty('vacancy')
    tracker.close('vacancy')

    tracker.open('vacancy')
    expect(tracker.close('vacancy')).toBe('none')
  })

  it('tracks multiple form names independently', () => {
    const tracker = new FormAbandonTracker()
    tracker.open('vacancy')
    tracker.open('transaction')
    tracker.markDirty('vacancy')
    // transaction stays pristine
    expect(tracker.close('vacancy')).toBe('abandon')
    expect(tracker.close('transaction')).toBe('none')
  })

  it('markDirty/markSubmitted on an unopened form is a silent no-op', () => {
    const tracker = new FormAbandonTracker()
    expect(() => tracker.markDirty('ghost')).not.toThrow()
    expect(() => tracker.markSubmitted('ghost')).not.toThrow()
  })
})
