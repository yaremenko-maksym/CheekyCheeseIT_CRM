import type { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { deleteStagedQuietly, readSnapshot, renderOwnerKey, storedOwnerKey } from './run-columns'

/** A snapshot as startStagedRun stores it (FR-A-2). */
const STORED = {
  content: { summary: 'Backend engineer.' },
  layout: { fontSize: 11 },
  templateName: 'classic',
  pdfKey: 'resumes/r/staged/run-1.pdf',
  editedPaths: [],
  runId: 'run-1',
  kind: 'staged-edit',
  targetPath: 'summary',
  baseVersion: 3,
  report: { gates: [], fallbacks: [] },
}

describe('readSnapshot', () => {
  it('reads a stored snapshot back as it was written', () => {
    expect(readSnapshot(STORED)).toEqual(STORED)
  })

  it('keeps a null layout and a null report: the run wrote none', () => {
    expect(readSnapshot({ ...STORED, layout: null, report: null })).toEqual({
      ...STORED,
      layout: null,
      report: null,
    })
  })

  it.each([
    ['content is null', { content: null }],
    ['content is a string', { content: 'text' }],
    ['layout is a string', { layout: 'wide' }],
    ['the report is a number', { report: 7 }],
    ['the PDF key is missing', { pdfKey: null }],
  ])('nothing to restore when %s', (_, part) => {
    expect(readSnapshot({ ...STORED, ...part })).toBeNull()
  })

  it('nothing to restore without a snapshot', () => {
    expect(readSnapshot(null)).toBeNull()
  })
})

describe('deleteStagedQuietly', () => {
  const logger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> }

  it('deletes the key it is given', async () => {
    const s3 = { delete: vi.fn().mockResolvedValue(undefined) }
    await deleteStagedQuietly(s3, logger(), 'resumes/r/staged/run-1.pdf')
    expect(s3.delete).toHaveBeenCalledWith('resumes/r/staged/run-1.pdf')
  })

  it('no key, no delete', async () => {
    const s3 = { delete: vi.fn() }
    await deleteStagedQuietly(s3, logger(), null)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a failed delete logs the key and does not throw', async () => {
    const s3 = { delete: vi.fn().mockRejectedValue(new Error('S3 down')) }
    const log = logger()
    await deleteStagedQuietly(s3, log, 'k')
    expect(log.warn).toHaveBeenCalledWith('Staged resume PDF not deleted: k')
  })
})

describe('renderOwnerKey (P11, backlog 442)', () => {
  const OWNER = {
    displayName: 'Olena Koval',
    email: 'olena@unit.spec',
    legalFullName: 'Коваль Олена',
    telegram: '@olena_k',
  }

  it('is the sha256 of the four owner inputs, in order', () => {
    // sha256 of '["Jane","j@x.io",null,null]', computed outside the code.
    expect(
      renderOwnerKey({ displayName: 'Jane', email: 'j@x.io', legalFullName: null, telegram: null }),
    ).toBe('0823f7d0956964e253170487d2c6dd79ee14a0e34f3b6f4aa3a1aa8769469519')
  })

  it.each([
    ['the display name', { displayName: 'Olena Moroz' }],
    ['the email', { email: 'olena2@unit.spec' }],
    ['the legal name', { legalFullName: 'Мороз Олена' }],
    ['the Telegram handle', { telegram: '@olena_new' }],
    ['a cleared legal name', { legalFullName: null }],
    ['a cleared Telegram handle', { telegram: null }],
  ])('changes when %s changes', (_what, change) => {
    expect(renderOwnerKey({ ...OWNER, ...change })).not.toBe(renderOwnerKey(OWNER))
  })

  it('a key of the old two-field format no longer matches: such a staged result is stale', () => {
    // sha256 of '["Jane","j@x.io"]', the key a run stored before backlog 442.
    const old = '3be78c6cf72b3eaa0912a3398cdc204aed4eeca0f07742bbde2b5e1513fccb9f'
    expect(storedOwnerKey({ ownerKey: old })).toBe(old)
    expect(
      renderOwnerKey({ displayName: 'Jane', email: 'j@x.io', legalFullName: null, telegram: null }),
    ).not.toBe(old)
  })
})
