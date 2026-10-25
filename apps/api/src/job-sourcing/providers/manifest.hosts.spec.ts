import { describe, expect, it } from 'vitest'
import {
  MAX_FLOOR_HOURS,
  hostKeyProblems,
  hostPolicyOf,
  hostRateProblem,
  isValidHostKey,
} from './manifest.hosts'

/** Task 2.5 T8: the manifest's host vocabulary, as pure functions over hand-built inputs. */

describe('isValidHostKey (the database CHECK, in TypeScript)', () => {
  it('accepts lowercase host names of two or more labels', () => {
    for (const ok of [
      'remotive.com',
      'api.eu.lever.co',
      'boards-api.greenhouse.io',
      'a.b',
      '0.9',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`,
    ]) {
      expect(isValidHostKey(ok), ok).toBe(true)
    }
  })

  it('refuses everything else, including one label, uppercase, a port, a path and 254 characters', () => {
    for (const bad of [
      '',
      'remotive',
      'Remotive.com',
      'remotive.com.',
      '.remotive.com',
      'remotive..com',
      '-a.com',
      'a-.com',
      'remotive.com:443',
      'remotive.com/x',
      'https://remotive.com',
      'user@remotive.com',
      ' remotive.com',
      'remotive.com\n',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`,
    ]) {
      expect(isValidHostKey(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const bad of [null, undefined, 1, {}, ['a.b']]) expect(isValidHostKey(bad)).toBe(false)
  })
})

describe('hostRateProblem (AC 13)', () => {
  it('accepts integer figures in range on a one-request type', () => {
    expect(hostRateProblem({ perMinute: 2, perDay: 4 }, 1)).toBeNull()
    expect(hostRateProblem({ perMinute: 1, perDay: 1 }, 1)).toBeNull()
    expect(hostRateProblem({ perMinute: 60, perDay: 10_000 }, 1)).toBeNull()
  })

  it('refuses perDay on a type whose requestsPerRun is not 1', () => {
    expect(hostRateProblem({ perMinute: 2, perDay: 4 }, 5)).toBe(
      'perDay counts claims, and this type sends 5 requests a run',
    )
    expect(hostRateProblem({ perMinute: 2, perDay: 4 }, 2)).not.toBeNull()
    expect(hostRateProblem({ perMinute: 2, perDay: 4 }, 0)).not.toBeNull()
  })

  it('refuses figures out of range or not integers', () => {
    expect(hostRateProblem({ perMinute: 0, perDay: 4 }, 1)).toBe(
      'perMinute 0 is not an integer from 1 to 60',
    )
    expect(hostRateProblem({ perMinute: 61, perDay: 4 }, 1)).not.toBeNull()
    expect(hostRateProblem({ perMinute: 1.5, perDay: 4 }, 1)).not.toBeNull()
    expect(hostRateProblem({ perMinute: 2, perDay: 0 }, 1)).toBe(
      'perDay 0 is not an integer from 1 to 10000',
    )
    expect(hostRateProblem({ perMinute: 2, perDay: 10_001 }, 1)).not.toBeNull()
    expect(hostRateProblem({ perMinute: 2, perDay: Number.NaN }, 1)).not.toBeNull()
  })

  it('names its floor ceiling', () => {
    expect(MAX_FLOOR_HOURS).toBe(720)
  })
})

describe('hostPolicyOf', () => {
  const types = [
    { type: 'REMOTIVE_API', hostRate: { perMinute: 2, perDay: 4 }, minIntervalHoursFloor: 6 },
    { type: 'REMOTEOK_API', hostRate: { perMinute: 5, perDay: 3 }, minIntervalHoursFloor: 12 },
    { type: 'HIMALAYAS_API', hostRate: null, minIntervalHoursFloor: 48 },
    { type: 'JOBICY_API', hostRate: null, minIntervalHoursFloor: 0 },
  ] as const
  const entries = [
    { type: 'REMOTIVE_API', hostKey: 'shared.example' },
    { type: 'REMOTEOK_API', hostKey: 'shared.example' },
    { type: 'HIMALAYAS_API', hostKey: 'shared.example' },
    { type: 'REMOTIVE_API', hostKey: 'remotive.com' },
    { type: 'JOBICY_API', hostKey: 'jobicy.com' },
  ] as const
  const m = { types, entries }

  it('a host shared by several types takes the strictest of each figure and the longest floor', () => {
    expect(hostPolicyOf(m, 'shared.example')).toEqual({
      rate: { perMinute: 2, perDay: 3 },
      floorHours: 48,
    })
  })

  it('a host of one type takes that type`s own figures', () => {
    expect(hostPolicyOf(m, 'remotive.com')).toEqual({
      rate: { perMinute: 2, perDay: 4 },
      floorHours: 6,
    })
    expect(hostPolicyOf(m, 'jobicy.com')).toEqual({ rate: null, floorHours: 0 })
  })

  it('a key no entry carries has no policy', () => {
    expect(hostPolicyOf(m, 'nowhere.example')).toBeUndefined()
  })
})

describe('hostKeyProblems (AC 14)', () => {
  it('passes when every request host has one key that scopes it', () => {
    expect(
      hostKeyProblems([
        { entryId: 'a', requestHost: 'remotive.com', hostKey: 'remotive.com' },
        { entryId: 'b', requestHost: 'bunq.recruitee.com', hostKey: 'recruitee.com' },
        { entryId: 'c', requestHost: 'acme.recruitee.com', hostKey: 'recruitee.com' },
      ]),
    ).toEqual([])
  })

  it('fails when two sources reaching one real host carry different keys', () => {
    expect(
      hostKeyProblems([
        { entryId: 'a', requestHost: 'api.example.com', hostKey: 'api.example.com' },
        { entryId: 'b', requestHost: 'api.example.com', hostKey: 'example.com' },
      ]),
    ).toEqual(['api.example.com is reached under 2 keys: api.example.com, example.com'])
  })

  it('fails when a key does not scope the host it is used for', () => {
    expect(
      hostKeyProblems([{ entryId: 'a', requestHost: 'remotive.com', hostKey: 'remoteok.com' }]),
    ).toEqual(['a: key remoteok.com does not scope its request host remotive.com'])
    // A suffix that is not a label boundary does not scope it.
    expect(
      hostKeyProblems([{ entryId: 'b', requestHost: 'evilremotive.com', hostKey: 'remotive.com' }]),
    ).toEqual(['b: key remotive.com does not scope its request host evilremotive.com'])
  })
})
