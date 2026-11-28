import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_REASON_PREFIX,
  RECORD_RELISTED_REASON,
  RUN_ABSENT_REASON_PREFIX,
  WINDOW_EXPIRE_REASON,
} from './dirty-work-reasons'

// Persisted strings: rows already in `job_dirty_work` carry them, so they are pinned literally.
describe('dirty-work reasons', () => {
  it('keeps the persisted reason literals', () => {
    expect(AVAILABILITY_REASON_PREFIX).toBe('AVAILABILITY:')
    expect(RUN_ABSENT_REASON_PREFIX).toBe('AVAILABILITY:RUN_ABSENT:')
    expect(RECORD_RELISTED_REASON).toBe('RECORD_RELISTED')
    expect(WINDOW_EXPIRE_REASON).toBe('RECORD_WINDOW_EXPIRED')
  })
})
