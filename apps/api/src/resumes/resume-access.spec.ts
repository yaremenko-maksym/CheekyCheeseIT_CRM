/**
 * AC6 — one test per row of the §4 access table, at the level where the rule
 * actually lives (`canAccessResume`).
 *
 * The negative SENIOR cases deliberately use the id of an OTHER, EXISTING
 * senior rather than a made-up uuid: a test that pokes at a non-existent id
 * passes even with the check ripped out (the row simply is not there), so it
 * proves nothing. See `resumes.service.spec.ts` for the mutation check that
 * demonstrates these go red when the comparison is removed.
 */
import { describe, expect, it } from 'vitest'
import { canAccessResume } from './resume-access'

const SENIOR_A = { id: 'senior-a', role: 'SENIOR' as const }
const SENIOR_B_ID = 'senior-b'

describe('canAccessResume — §4 access table', () => {
  describe('ADMIN — own and foreign: read/write', () => {
    const admin = { id: 'admin-1', role: 'ADMIN' as const }
    it('reads a foreign resume', () => {
      expect(canAccessResume(admin, SENIOR_A.id, 'read')).toBe(true)
    })
    it('writes a foreign resume', () => {
      expect(canAccessResume(admin, SENIOR_A.id, 'write')).toBe(true)
    })
    it('accesses their own', () => {
      expect(canAccessResume(admin, admin.id, 'write')).toBe(true)
    })
  })

  describe('HR — own and foreign: read/write', () => {
    const hr = { id: 'hr-1', role: 'HR' as const }
    it('reads a foreign resume', () => {
      expect(canAccessResume(hr, SENIOR_A.id, 'read')).toBe(true)
    })
    it('writes a foreign resume', () => {
      expect(canAccessResume(hr, SENIOR_A.id, 'write')).toBe(true)
    })
    it('accesses their own', () => {
      expect(canAccessResume(hr, hr.id, 'write')).toBe(true)
    })
  })

  describe('SENIOR — own read/write, foreign NONE', () => {
    it('reads their own', () => {
      expect(canAccessResume(SENIOR_A, SENIOR_A.id, 'read')).toBe(true)
    })
    it('writes their own', () => {
      expect(canAccessResume(SENIOR_A, SENIOR_A.id, 'write')).toBe(true)
    })
    it('cannot read ANOTHER senior (existing id, not a fabricated one)', () => {
      expect(canAccessResume(SENIOR_A, SENIOR_B_ID, 'read')).toBe(false)
    })
    it('cannot write ANOTHER senior', () => {
      expect(canAccessResume(SENIOR_A, SENIOR_B_ID, 'write')).toBe(false)
    })
  })

  describe.each(['JUNIOR', 'ACCOUNTANT', 'DROP'] as const)('%s — no access at all', (role) => {
    const viewer = { id: `${role.toLowerCase()}-1`, role }
    it('cannot read a foreign resume', () => {
      expect(canAccessResume(viewer, SENIOR_A.id, 'read')).toBe(false)
    })
    it('cannot write a foreign resume', () => {
      expect(canAccessResume(viewer, SENIOR_A.id, 'write')).toBe(false)
    })
    it('cannot even access their OWN id (they have no resume surface)', () => {
      expect(canAccessResume(viewer, viewer.id, 'read')).toBe(false)
      expect(canAccessResume(viewer, viewer.id, 'write')).toBe(false)
    })
  })
})
