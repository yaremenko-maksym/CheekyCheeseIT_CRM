import { describe, expect, it } from 'vitest'
import {
  addTeamMemberSchema,
  createTeamSchema,
  teamMemberSchema,
  teamSchema,
  teamTelegramChannelSchema,
  updateTeamSchema,
} from './teams'

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const datetime = '2026-01-01T00:00:00.000Z'

describe('createTeamSchema', () => {
  const validCreate = {
    name: 'My Team',
    seniorId: uuid,
    hrIds: [uuid],
    accountantId: null,
  }

  it('accepts a valid payload', () => {
    expect(() => createTeamSchema.parse(validCreate)).not.toThrow()
  })

  it('accepts multiple hrIds', () => {
    const second = '223e4567-e89b-12d3-a456-426614174000'
    expect(() => createTeamSchema.parse({ ...validCreate, hrIds: [uuid, second] })).not.toThrow()
  })

  it('accepts a valid accountantId UUID', () => {
    expect(() => createTeamSchema.parse({ ...validCreate, accountantId: uuid })).not.toThrow()
  })

  it('rejects empty name', () => {
    expect(() => createTeamSchema.parse({ ...validCreate, name: '' })).toThrow()
  })

  it('rejects name > 255 chars', () => {
    expect(() => createTeamSchema.parse({ ...validCreate, name: 'a'.repeat(256) })).toThrow()
  })

  it('rejects missing seniorId', () => {
    const { seniorId: _, ...without } = validCreate
    expect(() => createTeamSchema.parse(without)).toThrow()
  })

  it('rejects empty hrIds array', () => {
    expect(() => createTeamSchema.parse({ ...validCreate, hrIds: [] })).toThrow()
  })

  it('rejects non-UUID seniorId', () => {
    expect(() => createTeamSchema.parse({ ...validCreate, seniorId: 'not-a-uuid' })).toThrow()
  })
})

// task-i18n-stage4-task5: reuses `zod.TELEGRAM_CHANNEL_FORMAT` (task-i18n-
// stage4-task4) rather than a new code — this schema had no test coverage of
// its own message before this task.
describe('teamTelegramChannelSchema', () => {
  it('accepts null / undefined (optional, nullable)', () => {
    expect(() => teamTelegramChannelSchema.parse(null)).not.toThrow()
    expect(() => teamTelegramChannelSchema.parse(undefined)).not.toThrow()
  })

  it('accepts a bare handle and an @-prefixed handle, 5-32 chars', () => {
    expect(() => teamTelegramChannelSchema.parse('valid_channel')).not.toThrow()
    expect(() => teamTelegramChannelSchema.parse('@valid_channel')).not.toThrow()
  })

  it('rejects a handle under 5 chars with the TELEGRAM_CHANNEL_FORMAT code', () => {
    const result = teamTelegramChannelSchema.safeParse('abc')
    expect(result.success).toBe(false)
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe(
      'zod.TELEGRAM_CHANNEL_FORMAT',
    )
  })

  it('rejects a handle with spaces', () => {
    expect(() => teamTelegramChannelSchema.parse('bad channel')).toThrow(
      'zod.TELEGRAM_CHANNEL_FORMAT',
    )
  })
})

describe('updateTeamSchema', () => {
  it('accepts a valid name', () => {
    expect(() => updateTeamSchema.parse({ name: 'Updated' })).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => updateTeamSchema.parse({ name: '' })).toThrow()
  })

  describe('telegram validation', () => {
    it('accepts empty string', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: '' })).not.toThrow()
    })

    it('accepts null value', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: null })).not.toThrow()
    })

    it('accepts undefined value', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test' })).not.toThrow()
    })

    it('accepts valid telegram URL', () => {
      expect(() =>
        updateTeamSchema.parse({ name: 'Test', telegram: 'https://t.me/team_chat' }),
      ).not.toThrow()
    })

    it('rejects invalid telegram URL without https://t.me/', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'invalid_url' })).toThrow(
        'zod.TEAM_TELEGRAM_LINK_FORMAT',
      )
    })

    it('rejects telegram URL with wrong protocol', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'http://t.me/chat' })).toThrow(
        'zod.TEAM_TELEGRAM_LINK_FORMAT',
      )
    })

    it('rejects telegram URL with wrong domain', () => {
      expect(() =>
        updateTeamSchema.parse({ name: 'Test', telegram: 'https://telegram.me/chat' }),
      ).toThrow('zod.TEAM_TELEGRAM_LINK_FORMAT')
    })
  })
})

describe('addTeamMemberSchema', () => {
  it('accepts a valid UUID', () => {
    expect(() => addTeamMemberSchema.parse({ userId: uuid })).not.toThrow()
  })

  it('rejects non-UUID string', () => {
    expect(() => addTeamMemberSchema.parse({ userId: 'not-a-uuid' })).toThrow()
  })
})

describe('teamMemberSchema', () => {
  const valid = {
    id: uuid,
    userId: uuid,
    displayName: 'Alice',
    email: 'alice@example.com',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'SENIOR' as const,
    techStack: null,
    joinedAt: datetime,
  }

  it('accepts valid member', () => {
    expect(() => teamMemberSchema.parse(valid)).not.toThrow()
  })

  it('rejects invalid role', () => {
    expect(() => teamMemberSchema.parse({ ...valid, role: 'GHOST' })).toThrow()
  })
})

describe('teamSchema', () => {
  const valid = {
    id: uuid,
    name: 'Alpha',
    createdAt: datetime,
    updatedAt: datetime,
    archivedAt: null,
    members: [],
  }

  it('accepts team with no members', () => {
    expect(() => teamSchema.parse(valid)).not.toThrow()
  })

  it('rejects missing id', () => {
    const { id: _, ...without } = valid
    expect(() => teamSchema.parse(without)).toThrow()
  })
})
