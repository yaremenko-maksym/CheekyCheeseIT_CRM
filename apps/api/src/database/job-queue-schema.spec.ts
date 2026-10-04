import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  jobSourceTypeSchema,
  jobSeniorityLevelSchema,
  jobQueueStatusSchema,
  jobSignalKindSchema,
} from '@crm/shared'
import {
  jobPostings,
  jobPostingSignals,
  jobSeniorityEnum,
  jobQueueStatusEnum,
  jobSignalKindEnum,
  jobSourceTypeEnum,
  jobSources,
} from './schema'

describe('vacancy queue schema', () => {
  it('pg enums mirror the shared zod enums member for member', () => {
    expect([...jobSourceTypeEnum.enumValues]).toEqual([...jobSourceTypeSchema.options])
    expect([...jobSeniorityEnum.enumValues]).toEqual([...jobSeniorityLevelSchema.options])
    expect([...jobQueueStatusEnum.enumValues]).toEqual([...jobQueueStatusSchema.options])
    expect([...jobSignalKindEnum.enumValues]).toEqual([...jobSignalKindSchema.options])
  })

  it('job_postings carries the queue columns', () => {
    const names = getTableConfig(jobPostings).columns.map((c) => c.name)
    for (const n of [
      'dedupe_key',
      'also_seen_on',
      'matched_senior_ids',
      'matched_keywords',
      'seniority',
      'stack_unknown',
      'rank_score',
      'queue_status',
      'taken_by',
      'taken_at',
      'last_seen_at',
    ]) {
      expect(names).toContain(n)
    }
  })

  it('dedupe_key has a PARTIAL unique index and the queue index exists', () => {
    const indexes = getTableConfig(jobPostings).indexes
    const idx = indexes.map((i) => i.config.name)
    expect(idx).toContain('uq_job_postings_dedupe_key')
    expect(idx).toContain('idx_job_postings_queue')
    expect(idx).toContain('idx_job_postings_matched_seniors')
    const dedupe = indexes.find((i) => i.config.name === 'uq_job_postings_dedupe_key')
    expect(dedupe?.config.unique).toBe(true)
    expect(dedupe?.config.where).toBeDefined()
  })

  it('job_sources carries cadence + disabled reason', () => {
    const names = getTableConfig(jobSources).columns.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['min_interval_hours', 'disabled_reason']))
  })

  it('signals table is named, has its columns and cascades with the posting', () => {
    const cfg = getTableConfig(jobPostingSignals)
    expect(cfg.name).toBe('job_posting_signals')
    expect(cfg.columns.map((c) => c.name)).toEqual([
      'id',
      'posting_id',
      'user_id',
      'kind',
      'created_at',
    ])
    expect(cfg.indexes.map((i) => i.config.name)).toContain('idx_job_posting_signals_posting')
    const fks = cfg.foreignKeys.map((f) => f.reference().foreignTable)
    expect(fks).toContain(jobPostings)
  })
})
