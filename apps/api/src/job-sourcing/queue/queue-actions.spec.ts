import { describe, expect, it } from 'vitest'
import {
  decideDismiss,
  decideSubmit,
  type ExistingSubmission,
  isoInstant,
  parseActionReplay,
  requestFingerprint,
  scopeTeamId,
  type WriteScope,
} from './queue-actions'

const TEAM_A = '10000000-0000-4000-8000-00000000000a'
const TEAM_B = '10000000-0000-4000-8000-00000000000b'
const ROW = '20000000-0000-4000-8000-000000000001'
const SENIOR = '30000000-0000-4000-8000-000000000001'

const teamScope = (teamId: string): WriteScope => ({
  kind: 'TEAM',
  teamId,
  seniorIds: [],
  versions: [],
  inputsVersion: 'inputs-v1',
})
const STUDIO: WriteScope = { kind: 'STUDIO' }

const row = (over: Partial<ExistingSubmission> = {}): ExistingSubmission => ({
  id: ROW,
  state: 'TAKEN',
  teamId: TEAM_A,
  version: 3,
  ...over,
})

describe('scopeTeamId', () => {
  it('names the team of a TEAM scope and none for STUDIO', () => {
    expect(scopeTeamId(teamScope(TEAM_A))).toBe(TEAM_A)
    expect(scopeTeamId(STUDIO)).toBeNull()
  })
})

describe('decideSubmit', () => {
  describe('no row', () => {
    it('inserts a first submission', () => {
      expect(decideSubmit(null, teamScope(TEAM_A), undefined)).toEqual({ kind: 'INSERT' })
    })
    it('is stale when the client names a version of a row that is not there', () => {
      expect(decideSubmit(null, teamScope(TEAM_A), 1)).toEqual({ kind: 'STALE' })
    })
  })

  describe('the own scope', () => {
    it('refuses a second submission of a live row, whatever the version', () => {
      expect(decideSubmit(row(), teamScope(TEAM_A), undefined)).toEqual({ kind: 'STALE' })
      expect(decideSubmit(row(), teamScope(TEAM_A), 3)).toEqual({ kind: 'STALE' })
    })
    it('updates a cancelled row at the named version', () => {
      expect(decideSubmit(row({ state: 'RELEASED' }), teamScope(TEAM_A), 3)).toEqual({
        kind: 'UPDATE',
        id: ROW,
        version: 3,
      })
    })
    it('is stale on a cancelled row at another version, or at none', () => {
      expect(decideSubmit(row({ state: 'RELEASED' }), teamScope(TEAM_A), 2)).toEqual({
        kind: 'STALE',
      })
      expect(decideSubmit(row({ state: 'RELEASED' }), teamScope(TEAM_A), undefined)).toEqual({
        kind: 'STALE',
      })
    })
    it('treats a STUDIO row as the STUDIO scope own', () => {
      const studioRow = row({ teamId: null, state: 'RELEASED' })
      expect(decideSubmit(studioRow, STUDIO, 3)).toEqual({ kind: 'UPDATE', id: ROW, version: 3 })
    })
  })

  describe('another scope (owner decision A3)', () => {
    it('answers ELSEWHERE on a live row, whatever the version', () => {
      expect(decideSubmit(row(), teamScope(TEAM_B), undefined)).toEqual({ kind: 'ELSEWHERE' })
      expect(decideSubmit(row(), teamScope(TEAM_B), 3)).toEqual({ kind: 'ELSEWHERE' })
    })
    it('replaces a cancelled row, never updating it', () => {
      expect(decideSubmit(row({ state: 'RELEASED' }), teamScope(TEAM_B), undefined)).toEqual({
        kind: 'REPLACE',
        id: ROW,
      })
    })
    it('a cancelled row answers a named version exactly as no row does', () => {
      expect(decideSubmit(row({ state: 'RELEASED' }), teamScope(TEAM_B), 3)).toEqual({
        kind: 'STALE',
      })
      expect(decideSubmit(null, teamScope(TEAM_B), 3)).toEqual({ kind: 'STALE' })
    })
    it('a team row is foreign to STUDIO and a STUDIO row is foreign to a team', () => {
      expect(decideSubmit(row(), STUDIO, undefined)).toEqual({ kind: 'ELSEWHERE' })
      expect(decideSubmit(row({ teamId: null }), teamScope(TEAM_A), undefined)).toEqual({
        kind: 'ELSEWHERE',
      })
    })
  })
})

describe('decideDismiss', () => {
  it('inserts a first dismissal, and is stale if a version is named for it', () => {
    expect(decideDismiss(null, undefined)).toBe('INSERT')
    expect(decideDismiss(null, 1)).toBe('STALE')
  })
  it('updates at the matching version only', () => {
    expect(decideDismiss(2, 2)).toBe('UPDATE')
    expect(decideDismiss(2, 1)).toBe('STALE')
    expect(decideDismiss(2, undefined)).toBe('STALE')
  })
  it('a live dismissal re-dismissed at its version is an UPDATE: how a reason is corrected', () => {
    // Liveness is not an input: a live row and an undone row at version 1 decide alike.
    expect(decideDismiss(1, 1)).toBe('UPDATE')
  })
})

describe('requestFingerprint', () => {
  it('is the sha256 of the JSON array (digest computed independently with sha256sum)', () => {
    expect(requestFingerprint(['a', 1, null])).toBe(
      '0ae764bffd3a17b6454c8d9ebf712311d9b92efce67a4e4ea4f095fc05ed0122',
    )
  })
  it('cannot collide across element boundaries', () => {
    expect(requestFingerprint(['a,b'])).not.toBe(requestFingerprint(['a', 'b']))
  })
})

describe('parseActionReplay', () => {
  it('reads what the writer stored', () => {
    expect(parseActionReplay(`{"fp":"x","submissionId":"${SENIOR}"}`)).toEqual({
      fp: 'x',
      submissionId: SENIOR,
    })
  })
  it('is null for a redacted reason, a non-string and a wrong shape', () => {
    expect(parseActionReplay('[redacted]')).toBeNull()
    expect(parseActionReplay(null)).toBeNull()
    expect(parseActionReplay(undefined)).toBeNull()
    expect(parseActionReplay('{"submissionId":"not-an-id","fp":"x"}')).toBeNull()
    expect(parseActionReplay('{"nofp":true}')).toBeNull()
  })
})

describe('isoInstant', () => {
  it('reads a Date and the driver text form alike', () => {
    expect(isoInstant(new Date('2026-11-04T10:00:00.000Z'))).toBe('2026-11-04T10:00:00.000Z')
    expect(isoInstant('2026-11-04 12:00:00+02')).toBe('2026-11-04T10:00:00.000Z')
  })
})
