import { describe, expect, it } from 'vitest'
import { reachableRoles, roleScopeGate } from './role-scope-gate'

// the prod roster shape (2026-11-19) cut to two seniors: BACKEND + ANDROID
const ROSTER = reachableRoles([{ roles: ['BACKEND_ENGINEER'] }, { roles: ['ANDROID_ENGINEER'] }])
const gate = (title: string, tags: string[] = [], layer1Rejected = false, reachable = ROSTER) =>
  roleScopeGate({ title, tags, layer1Rejected, reachable })

describe('reachableRoles', () => {
  it('is the union of one-hop widening over every profile', () => {
    expect([...ROSTER].sort()).toEqual(
      [
        'ANDROID_ENGINEER',
        'BACKEND_ENGINEER',
        'CROSS_PLATFORM_MOBILE_ENGINEER',
        'FULLSTACK_ENGINEER',
        'SOFTWARE_ENGINEER',
      ].sort(),
    )
  })

  it('is empty for an empty roster or seniors with no roles', () => {
    expect(reachableRoles([]).size).toBe(0)
    expect(reachableRoles([{ roles: [] }]).size).toBe(0)
  })
})

describe('roleScopeGate', () => {
  it.each([
    'forward deployed engineer',
    'product engineer',
    'staff engineer',
    'Senior Staff Engineer',
    'c++ engineer',
  ])('%s → PENDING (generic engineering keyword, SOFTWARE_ENGINEER reachable)', (title) =>
    expect(gate(title)).toBe('PENDING'),
  )

  it.each([
    'mechanical design engineer',
    'senior customer engineer - vancouver bc',
    'gtm system engineer',
    'site manager',
    'senior auditor',
    'mechanical engineer iii',
    'embedded c++ hardware engineer',
    'RF Engineer',
    // German stems match without a word bound
    'Ingenieur Engineer Elektrotechnik',
    'Instandhaltungsengineer',
    'expansion manager france / développeur.se immobilier - nord et idf',
    'hardware-entwickler / elektronikentwickler (m/w/d)',
  ])('%s → OUT_OF_SCOPE', (title) => expect(gate(title)).toBe('OUT_OF_SCOPE'))

  it('a bound English veto word does not fire inside another word', () => {
    // `rf` inside "performance", `data` inside "datadog"
    expect(gate('performance engineer')).toBe('PENDING')
    expect(gate('datadog engineer')).toBe('PENDING')
  })

  it.each(['data platform engineer', 'cloud security engineer', 'qa engineer', 'ai engineer'])(
    '%s → OUT_OF_SCOPE: an IT specialty the generic SOFTWARE_ENGINEER branch does not cover',
    (title) => expect(gate(title)).toBe('OUT_OF_SCOPE'),
  )

  it('a layer-1 reject is OUT_OF_SCOPE whatever the title says', () =>
    expect(gate('product engineer', [], true)).toBe('OUT_OF_SCOPE'))

  it('an empty roster sends every row OUT_OF_SCOPE', () =>
    expect(gate('product engineer', [], false, new Set())).toBe('OUT_OF_SCOPE'))

  it('a board tag mapping to a reachable role passes a title with no signal', () => {
    expect(gate('operations lead', ['remote-back-end-programming-jobs'])).toBe('PENDING')
    // tags are matched trimmed and case-insensitively, as the classifier does
    expect(gate('operations lead', ['  Android '])).toBe('PENDING')
  })

  it('a board tag mapping to an unreachable role does not pass', () =>
    expect(gate('operations lead', ['DevOps'])).toBe('OUT_OF_SCOPE'))

  it('a tech hint passes even when a veto word blocks the generic branch', () =>
    expect(gate('java support engineer')).toBe('PENDING'))

  it('matches the title case-insensitively', () =>
    expect(gate('Mechanical Design Engineer')).toBe('OUT_OF_SCOPE'))

  it('without SOFTWARE_ENGINEER reachable the generic branch is closed', () => {
    const dataOnly = reachableRoles([{ roles: ['DATA_ENGINEER'] }])
    expect(gate('data platform engineer', [], false, dataOnly)).toBe('OUT_OF_SCOPE')
    expect(gate('platform engineer', ['Data Engineer'], false, dataOnly)).toBe('PENDING')
  })

  it('every matching hint counts, not only the first', () => {
    const frontendOnly = reachableRoles([{ roles: ['FRONTEND_ENGINEER'] }])
    // the first matching entry (java → BACKEND) is unreachable, the generic branch is vetoed by
    // `hardware`; only the later `react` entry (FRONTEND) can pass it
    expect(gate('java / react hardware engineer', [], false, frontendOnly)).toBe('PENDING')
    expect(gate('java hardware engineer', [], false, frontendOnly)).toBe('OUT_OF_SCOPE')
    expect(gate('php / java engineer')).toBe('PENDING')
  })

  it('a hint with no role is a generic signal, not a role signal', () => {
    // `c++` maps to no role: it passes only through the generic branch, so a veto word closes it
    expect(gate('c++ hardware')).toBe('OUT_OF_SCOPE')
    expect(gate('c++')).toBe('PENDING')
    const noSoftware = reachableRoles([{ roles: ['DATA_ENGINEER'] }])
    expect(gate('c++ engineer', [], false, noSoftware)).toBe('OUT_OF_SCOPE')
  })
})
