import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESUME_HEADER,
  parseResumeHeader,
  resolveResumeHeader,
  resumeHeaderEmailSchema,
  resumeHeaderNameSchema,
  resumeHeaderPhoneSchema,
  resumeHeaderTelegramSchema,
  updateResumeHeaderSchema,
} from './resume-header'

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: string) =>
  schema.safeParse(value).success

describe('resume header validators', () => {
  it.each([
    'Jane Doe',
    '  Anna-Maria O’Neil  ',
    'José Müller',
    'Jean-Luc de la Fontaine',
    'J. R. Tolkien',
  ])('name %j is two words or more', (name) => expect(ok(resumeHeaderNameSchema, name)).toBe(true))

  it.each(['Jane', '', 'Jane 2', 'Jane  -', 'Jane Doe!', '@jane doe'])(
    'name %j is refused',
    (name) => {
      expect(ok(resumeHeaderNameSchema, name)).toBe(false)
    },
  )

  it('a refused name carries its catalog code', () => {
    expect(resumeHeaderNameSchema.safeParse('Jane').error?.issues[0]?.message).toBe(
      'zod.RESUME_HEADER_NAME_FORMAT',
    )
  })

  it('a non-Latin name is refused with its own code (the submit gate wants Latin)', () => {
    expect(resumeHeaderNameSchema.safeParse('Іван Петренко').error?.issues[0]?.message).toBe(
      'zod.RESUME_HEADER_NAME_LATIN',
    )
  })

  it.each(['jane@example.com', ' jane.doe+cv@sub.example.org '])('email %j passes', (email) => {
    expect(ok(resumeHeaderEmailSchema, email)).toBe(true)
  })

  it.each(['jane', 'jane@', 'jane@example', 'jane doe@example.com'])(
    'email %j is refused',
    (email) => {
      expect(ok(resumeHeaderEmailSchema, email)).toBe(false)
    },
  )

  it.each(['+380 67 123 45 67', '+380(67)123-45-67', '+14155552671', '+48 600 000 000'])(
    'phone %j passes',
    (phone) => expect(ok(resumeHeaderPhoneSchema, phone)).toBe(true),
  )

  it.each([
    '0671234567',
    '+380',
    '+1 23',
    '+380 67 123 45 67 89 01 2',
    'call me',
    '+380 67 123 45 6a',
  ])('phone %j is refused', (phone) => expect(ok(resumeHeaderPhoneSchema, phone)).toBe(false))

  it.each(['@jane_doe', '@Jane5', ` @${'a'.repeat(32)} `])('Telegram %j passes', (handle) => {
    expect(ok(resumeHeaderTelegramSchema, handle)).toBe(true)
  })

  it.each(['jane_doe', '@jane', '@1jane_doe', '@jane-doe', '@jane doe', `@${'a'.repeat(33)}`, '@'])(
    'Telegram %j is refused',
    (handle) => expect(ok(resumeHeaderTelegramSchema, handle)).toBe(false),
  )

  it('trims what it accepts', () => {
    const parsed = updateResumeHeaderSchema.parse({
      header: { displayName: ' Jane Doe ', email: null, phone: ' +380671234567 ', telegram: null },
    })
    expect(parsed.header).toEqual({
      displayName: 'Jane Doe',
      email: null,
      phone: '+380671234567',
      telegram: null,
    })
  })

  it('the update body names all four fields', () => {
    expect(updateResumeHeaderSchema.safeParse({ header: { displayName: null } }).success).toBe(
      false,
    )
  })
})

describe('resolveResumeHeader', () => {
  const PROFILE = {
    displayName: 'Jane Doe',
    email: 'jane@example.com',
    phone: null,
    telegram: '@jane_doe',
    legalFullName: 'Jana Doe',
  }

  it('a null field prints the profile value, an override replaces it, other keys pass through', () => {
    const out = resolveResumeHeader(PROFILE, { ...EMPTY_RESUME_HEADER, phone: '+380671234567' })
    expect(out).toEqual({ ...PROFILE, phone: '+380671234567' })
  })

  it.each([null, undefined, 'junk', { displayName: 'Jane' }])(
    'a malformed stored header %j overrides nothing',
    (raw) => {
      expect(parseResumeHeader(raw)).toEqual(EMPTY_RESUME_HEADER)
      expect(resolveResumeHeader(PROFILE, raw)).toEqual(PROFILE)
    },
  )
})
