import { describe, expect, it } from 'vitest'
import { SKILL_SYNONYM_GROUPS } from '../schemas/resume-skills'
import { skillOverlap, vacancyTechnologies } from './skill-overlap'

describe('vacancyTechnologies', () => {
  it('counts dictionary technologies from title + description only once', () => {
    expect(vacancyTechnologies('Senior Kotlin dev. Kotlin, Android, Jetpack Compose')).toEqual([
      'Android',
      'Jetpack Compose',
      'Kotlin',
    ])
  })

  it('canonicalises synonyms and ignores words outside the dictionary', () => {
    expect(vacancyTechnologies('Golang + Postgres, k8s. Nice team, remote')).toEqual([
      'Go',
      'Kubernetes',
      'PostgreSQL',
    ])
  })

  it('returns [] for text that names no technology', () => {
    expect(vacancyTechnologies('Friendly team, flexible hours')).toEqual([])
    expect(vacancyTechnologies('')).toEqual([])
  })

  it('counts an ordinary English word that is also a skill spelling (known limit, display-only)', () => {
    // `go` and `rest` are dictionary spellings and token matching cannot tell them apart.
    expect(vacancyTechnologies('ready to go, the rest of the team')).toEqual(['Go', 'REST'])
  })
})

describe('skillOverlap', () => {
  it('null for a vacancy with no technologies', () => {
    expect(skillOverlap([], ['Go'])).toBeNull()
    expect(skillOverlap([], null)).toBeNull()
  })

  it('NO_RESUME for an empty or missing resume, never 0 of n', () => {
    expect(skillOverlap(['Go'], [])).toBe('NO_RESUME')
    expect(skillOverlap(['Go'], null)).toBe('NO_RESUME')
  })

  it('matches through synonyms', () => {
    expect(skillOverlap(['Postgres'], ['PostgreSQL'])).toEqual({ matched: ['Postgres'], total: 1 })
    expect(skillOverlap(['PostgreSQL'], ['postgres'])).toEqual({
      matched: ['PostgreSQL'],
      total: 1,
    })
  })

  it('k of n', () => {
    expect(skillOverlap(['Go', 'Kafka', 'PostgreSQL'], ['golang', 'postgres'])).toEqual({
      matched: ['Go', 'PostgreSQL'],
      total: 3,
    })
  })

  it('0 of n when the resume has skills but none match', () => {
    expect(skillOverlap(['Go', 'Kafka'], ['Java'])).toEqual({ matched: [], total: 2 })
  })
})

describe('skill dictionary covers the role groups', () => {
  // One technology hint per research §1 group (architecture/leadership has none of its own: AWS).
  const HINT_PER_GROUP: Record<string, string> = {
    SOFTWARE_ENGINEERING: 'Salesforce',
    MOBILE: 'Swift',
    DATA_AI: 'dbt',
    INFRASTRUCTURE_OPERATIONS: 'Terraform',
    QUALITY_ASSURANCE: 'Playwright',
    SECURITY: 'OWASP',
    EMBEDDED_HARDWARE: 'Verilog',
    GAME: 'Unity',
    BLOCKCHAIN: 'Solidity',
    ARCHITECTURE_LEADERSHIP: 'Amazon Web Services (AWS)',
    ADJACENT_ANALYSIS_DESIGN: 'Figma',
  }

  it.each(Object.entries(HINT_PER_GROUP))('%s has a dictionary entry (%s)', (_group, hint) => {
    expect(SKILL_SYNONYM_GROUPS.map((g) => g.canonical)).toContain(hint)
  })

  // `React Native` also mentions `React`: token matching counts both (display-only n).
  it('finds the role-stack technologies the research names', () => {
    expect(
      vacancyTechnologies(
        'Flutter, React Native, Spark, Selenium, Unreal Engine, Kubernetes, Solidity, VHDL',
      ),
    ).toEqual([
      'Apache Spark',
      'Flutter',
      'Kubernetes',
      'React',
      'React Native',
      'Selenium',
      'Solidity',
      'Unreal Engine',
      'VHDL',
    ])
  })
})
