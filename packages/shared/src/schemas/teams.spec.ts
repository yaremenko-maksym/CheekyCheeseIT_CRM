import { describe, expect, it } from 'vitest'
import {
  addTeamMemberSchema,
  createTeamSchema,
  teamMemberSchema,
  teamSchema,
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
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'https://t.me/team_chat' })).not.toThrow()
    })

    it('rejects invalid telegram URL without https://t.me/', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'invalid_url' })).toThrow('Ссылка должна начинаться с https://t.me/')
    })

    it('rejects telegram URL with wrong protocol', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'http://t.me/chat' })).toThrow('Ссылка должна начинаться с https://t.me/')
    })

    it('rejects telegram URL with wrong domain', () => {
      expect(() => updateTeamSchema.parse({ name: 'Test', telegram: 'https://telegram.me/chat' })).toThrow('Ссылка должна начинаться с https://t.me/')
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
    avatar: null,
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
