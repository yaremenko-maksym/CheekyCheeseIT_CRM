import type { SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
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

  describe('column semantics (what the DB will actually enforce)', () => {
    const postingCols = getTableConfig(jobPostings).columns
    const col = (name: string) => {
      const found = postingCols.find((c) => c.name === name)
      if (!found) throw new Error(`no column ${name}`)
      return found
    }
    const render = (s: unknown) => new PgDialect().sqlToQuery(s as SQL).sql

    it('queue defaults are the values the HR queue relies on', () => {
      expect(col('seniority').default).toBe('UNKNOWN')
      expect(col('queue_status').default).toBe('NEW')
      expect(col('stack_unknown').default).toBe(false)
      expect(col('rank_score').default).toBe(0)
      for (const n of [
        'seniority',
        'queue_status',
        'stack_unknown',
        'rank_score',
        'last_seen_at',
      ]) {
        expect(col(n).notNull).toBe(true)
      }
      expect(col('dedupe_key').notNull).toBe(false)
    })

    it('array / jsonb defaults are the empty literals of the right element type', () => {
      expect(render(col('also_seen_on').default)).toBe(`'[]'::jsonb`)
      expect(render(col('matched_senior_ids').default)).toBe(`'{}'::uuid[]`)
      expect(render(col('matched_keywords').default)).toBe(`'{}'::text[]`)
    })

    it('the new timestamps are timestamptz', () => {
      expect(col('taken_at').getSQLType()).toBe('timestamp with time zone')
      expect(col('last_seen_at').getSQLType()).toBe('timestamp with time zone')
    })

    it('dedupe unique index is partial on NOT NULL; matched-seniors index is GIN', () => {
      const indexes = getTableConfig(jobPostings).indexes
      const dedupe = indexes.find((i) => i.config.name === 'uq_job_postings_dedupe_key')
      expect(render(dedupe?.config.where)).toContain('"dedupe_key" IS NOT NULL')
      const gin = indexes.find((i) => i.config.name === 'idx_job_postings_matched_seniors')
      expect(gin?.config.method).toBe('gin')
    })

    it('taken_by and the signal FKs null out / cascade the way the DDL declares', () => {
      const takenBy = getTableConfig(jobPostings).foreignKeys.find(
        (f) => f.reference().columns[0]?.name === 'taken_by',
      )
      expect(takenBy?.onDelete).toBe('set null')
      const fks = getTableConfig(jobPostingSignals).foreignKeys
      const byColumn = (n: string) => fks.find((f) => f.reference().columns[0]?.name === n)
      expect(byColumn('posting_id')?.onDelete).toBe('cascade')
      expect(byColumn('user_id')?.onDelete).toBe('set null')
    })
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
