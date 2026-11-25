import { describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_CONTENT, EMPTY_RESUME_HEADER } from '@crm/shared'
import {
  NO_EXTRACTED_CONTACTS,
  headerFromUpload,
  ownHeaderOverrides,
} from './resume-header-extraction'
import { readContacts } from './resume-ai.service'
import { SeniorResumesService } from './resumes.service'

const TEXT = [
  'IVAN   PETRENKO',
  'Senior Backend Engineer',
  'Email: Ivan.Petrenko@Unit.Spec | Phone: +380 (67) 123-45-67 | Telegram: t.me/ivan_petrenko',
].join('\n')

const READ = {
  name: 'Ivan Petrenko',
  email: 'ivan.petrenko@unit.spec',
  phone: '+380 67 123 45 67',
  telegram: 'https://t.me/ivan_petrenko',
}

const STORED = {
  displayName: 'Hr Override',
  email: 'hr@unit.spec',
  phone: '+380 50 000 0000',
  telegram: '@hr_override',
}

describe('headerFromUpload — what an uploaded file writes into the header', () => {
  it('every contact the file prints replaces the stored override', () => {
    expect(headerFromUpload(READ, TEXT, STORED)).toEqual({
      displayName: 'Ivan Petrenko',
      email: 'ivan.petrenko@unit.spec',
      phone: '+380 67 123 45 67',
      telegram: '@ivan_petrenko',
    })
  })

  it('a contact the model did not find keeps the stored override', () => {
    expect(headerFromUpload(NO_EXTRACTED_CONTACTS, TEXT, STORED)).toEqual(STORED)
    expect(headerFromUpload(NO_EXTRACTED_CONTACTS, TEXT, EMPTY_RESUME_HEADER)).toEqual(
      EMPTY_RESUME_HEADER,
    )
  })

  it('a contact absent from the file text is not trusted (a hallucination or an injection)', () => {
    const invented = {
      name: 'Petro Ivanenko',
      email: 'petro@unit.spec',
      phone: '+380 99 999 99 99',
      telegram: '@petro_ivanenko',
    }
    expect(headerFromUpload(invented, TEXT, STORED)).toEqual(STORED)
  })

  it('a contact that breaks the header rules is not written', () => {
    const text = 'Іван Петренко ivan@ 0671234567 @ab'
    const read = { name: 'Іван Петренко', email: 'ivan@', phone: '0671234567', telegram: '@ab' }
    expect(headerFromUpload(read, text, EMPTY_RESUME_HEADER)).toEqual(EMPTY_RESUME_HEADER)
  })

  it('a one-word name is not written even when the file prints it', () => {
    expect(
      headerFromUpload({ ...NO_EXTRACTED_CONTACTS, name: 'Ivan' }, 'Ivan', EMPTY_RESUME_HEADER),
    ).toEqual(EMPTY_RESUME_HEADER)
  })

  it('a contact counts only as a whole token, never as part of a longer word or address', () => {
    const text = 'Joann Lee · joann@unit.spec · IvanPetrenko'
    const read = { ...NO_EXTRACTED_CONTACTS, name: 'Ann Lee', email: 'ann@unit.spec' }
    expect(headerFromUpload(read, text, STORED)).toEqual(STORED)
    const glued = { ...NO_EXTRACTED_CONTACTS, name: 'Ivan Petrenko' }
    expect(headerFromUpload(glued, text, STORED)).toEqual(STORED)
    const tail = { ...NO_EXTRACTED_CONTACTS, email: 'joann@unit.spe' }
    expect(headerFromUpload(tail, text, STORED)).toEqual(STORED)
    for (const lead of ['mary.', 'mary-', 'mary+']) {
      const inner = { ...NO_EXTRACTED_CONTACTS, email: 'ann@unit.spec' }
      expect(headerFromUpload(inner, `Email: ${lead}ann@unit.spec`, STORED)).toEqual(STORED)
    }
  })

  it('a handle counts only where the file prints it as one (@handle or a t.me link)', () => {
    const text = 'Email: johndoe@unitspec.io · Skills: kubernetes'
    for (const telegram of ['@johndoe', '@kubernetes', '@unitspec']) {
      expect(headerFromUpload({ ...NO_EXTRACTED_CONTACTS, telegram }, text, STORED)).toEqual(STORED)
    }
    for (const link of [
      'github.com/johndoe',
      'linkedin.com/in/johndoe',
      'short.me/johndoe',
      'my-t.me/johndoe',
      'go.telegram.me/johndoe',
      't.me/team_chat · johndoe',
    ]) {
      expect(
        headerFromUpload({ ...NO_EXTRACTED_CONTACTS, telegram: '@johndoe' }, link, STORED),
      ).toEqual(STORED)
    }
    const viaLink = headerFromUpload(
      { ...NO_EXTRACTED_CONTACTS, telegram: '@johndoe' },
      'https://telegram.me/johndoe',
      STORED,
    )
    expect(viaLink.telegram).toBe('@johndoe')
    const atStart = headerFromUpload(
      { ...NO_EXTRACTED_CONTACTS, telegram: '@johndoe' },
      't.me/johndoe',
      STORED,
    )
    expect(atStart.telegram).toBe('@johndoe')
    const printed = 'Contacts: @johndoe'
    expect(
      headerFromUpload(
        { ...NO_EXTRACTED_CONTACTS, telegram: 'johndoe' },
        printed,
        EMPTY_RESUME_HEADER,
      ),
    ).toEqual({ ...EMPTY_RESUME_HEADER, telegram: '@johndoe' })
  })

  it('a phone counts only as one printed number, not digits stitched across the file', () => {
    const text = 'Founded 2003, team 80, 67 projects, 1234567 users'
    const read = { ...NO_EXTRACTED_CONTACTS, phone: '+380 67 123 45 67' }
    expect(headerFromUpload(read, text, STORED)).toEqual(STORED)
    expect(headerFromUpload(read, 'Since 2019 · Phone 380671234567', STORED).phone).toBe(read.phone)
    expect(headerFromUpload(read, '380 67 123 45 67', STORED).phone).toBe(read.phone)
    expect(headerFromUpload(read, 'no digits at all', STORED).phone).toBe(STORED.phone)
  })

  it('matches the text after Unicode normalisation (a PDF ligature)', () => {
    const read = { ...NO_EXTRACTED_CONTACTS, name: 'Filip Novak' }
    expect(headerFromUpload(read, 'ﬁlip Novak', STORED).displayName).toBe('Filip Novak')
  })

  it('the empty contacts are what a model answer without contacts reads as', () => {
    expect(readContacts({})).toEqual(NO_EXTRACTED_CONTACTS)
    expect(NO_EXTRACTED_CONTACTS).toEqual({ name: '', email: '', phone: '', telegram: '' })
  })

  it('each field is judged on its own', () => {
    expect(
      headerFromUpload({ ...NO_EXTRACTED_CONTACTS, phone: READ.phone }, TEXT, EMPTY_RESUME_HEADER),
    ).toEqual({ ...EMPTY_RESUME_HEADER, phone: READ.phone })
    expect(
      headerFromUpload(
        { ...NO_EXTRACTED_CONTACTS, telegram: '@ivan_petrenko' },
        TEXT,
        EMPTY_RESUME_HEADER,
      ),
    ).toEqual({ ...EMPTY_RESUME_HEADER, telegram: '@ivan_petrenko' })
  })
})

describe('ownHeaderOverrides — a value equal to the profile one follows the profile', () => {
  const PROFILE = {
    displayName: 'Ivan Petrenko',
    email: 'ivan@unit.spec',
    phone: '+380 67 000 0000',
    telegram: 'ivan_petrenko',
  }

  it('equal values become null; a leading @ is ignored for Telegram', () => {
    expect(ownHeaderOverrides({ ...PROFILE, telegram: '@ivan_petrenko' }, PROFILE)).toEqual(
      EMPTY_RESUME_HEADER,
    )
  })

  it('an email equal to the profile one but for letter case follows the profile', () => {
    const header = { ...EMPTY_RESUME_HEADER, email: 'Ivan@Unit.Spec' }
    expect(ownHeaderOverrides(header, PROFILE)).toEqual(EMPTY_RESUME_HEADER)
    expect(ownHeaderOverrides(header, { ...PROFILE, email: null })).toEqual(header)
  })

  it('different values stay; only a leading @ is ignored', () => {
    const header = {
      displayName: 'Ivan Override',
      email: 'other@unit.spec',
      phone: '+380 50 000 0000',
      telegram: '@ivan_cv',
    }
    expect(ownHeaderOverrides(header, PROFILE)).toEqual(header)
    const inner = { ...EMPTY_RESUME_HEADER, telegram: 'ivan_petrenko' }
    expect(ownHeaderOverrides(inner, { ...PROFILE, telegram: 'ivan_@petrenko' })).toEqual(inner)
  })
})

describe('SeniorResumesService.runExtraction — the upload writes the header the file prints', () => {
  it('stores the contacts read from the file, normalised against the profile', async () => {
    const set = vi.fn(() => ({ where: () => ({ returning: async () => [] }) }))
    const tx = { update: vi.fn(() => ({ set })) }
    const current = {
      id: 'r-1',
      stagedPdfS3Key: null,
      content: EMPTY_RESUME_CONTENT,
      facts: null,
      userId: 'u-1',
      header: { ...EMPTY_RESUME_HEADER, phone: '+380 50 000 0000' },
    }
    const select = () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) })
    const db = {
      db: { select, transaction: async (run: (t: typeof tx) => unknown) => run(tx) },
    }
    const ai = {
      extractStructure: vi.fn(async () => ({
        ok: true,
        content: { ...EMPTY_RESUME_CONTENT, skills: ['Go'] },
        contacts: { ...READ, email: 'ivan.petrenko@unit.spec' },
        tokensUsed: 1,
      })),
    }
    const svc = new SeniorResumesService(
      db as never,
      {} as never,
      ai as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const inner = svc as unknown as Record<string, unknown>
    inner['claimForExtraction'] = vi.fn(async () => 'run-1')
    inner['stillOwnsRun'] = vi.fn(async () => true)
    const ownerFor = vi.fn(async () => ({
      displayName: 'Іван Петренко',
      email: 'ivan.petrenko@unit.spec',
      phone: null,
      telegram: null,
    }))
    inner['ownerFor'] = ownerFor
    await svc.runExtraction('r-1', async () => TEXT)
    expect(ownerFor).toHaveBeenCalledWith('u-1')
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        header: {
          displayName: 'Ivan Petrenko',
          email: null,
          phone: '+380 67 123 45 67',
          telegram: '@ivan_petrenko',
        },
      }),
    )
  })
})
