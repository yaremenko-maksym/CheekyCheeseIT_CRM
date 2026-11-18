import { describe, expect, it } from 'vitest'
import { JOB_PUBLIC_ID_PATTERN } from '../../database/schema/job-patterns'
import { RESUME_AI_METER_ACCOUNT_KEY } from '../../resumes/resume-ai-daily-budget'
import { keyHash, ROLE_AI_METER_ACCOUNT_KEY } from './role-ai.store'

describe('keyHash', () => {
  it('is the description sha, or "" for a vacancy without a description', () => {
    expect(keyHash({ descriptionSha256: 'ab12' })).toBe('ab12')
    expect(keyHash({ descriptionSha256: null })).toBe('')
  })
})

describe('ROLE_AI_METER_ACCOUNT_KEY (SR-M-1)', () => {
  it('is a valid meter account key of its own, not the resume budget', () => {
    expect(ROLE_AI_METER_ACCOUNT_KEY).toBe('extraction-worker:role-ai')
    expect(ROLE_AI_METER_ACCOUNT_KEY).toMatch(new RegExp(JOB_PUBLIC_ID_PATTERN))
    expect(ROLE_AI_METER_ACCOUNT_KEY).not.toBe(RESUME_AI_METER_ACCOUNT_KEY)
  })
})
