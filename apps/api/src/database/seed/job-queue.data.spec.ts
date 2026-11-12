import { describe, expect, it } from 'vitest'
import { matchFacts } from '../../job-sourcing/queue/job-queue.service'
import { ARTEM_ID, DMYTRO_ID, HR0_ID, HR2_ID, OLEKSIY_ID, SENIOR_SHARED_ID } from './ids'
import { leadEvidence, SEED_QUEUE_MEMBERSHIPS, SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'

/**
 * Task 7.6a — the job-queue seed is a contract with the Task 7.6 E2E, which finds every row by
 * its title through the real API. A drifted title or a moved match breaks that suite silently.
 */
const byTitle = (title: string) => {
  const found = SEED_QUEUE_OPPORTUNITIES.find((o) => o.title === title)
  if (found === undefined) throw new Error(`no seed opportunity titled ${title}`)
  return found
}
const leadIds = (title: string) => byTitle(title).leads.map((l) => l.seniorId)

describe('SEED_QUEUE_OPPORTUNITIES — the Task 7.6 seed contract', () => {
  it('seeds exactly the five contract titles, verbatim', () => {
    expect(SEED_QUEUE_OPPORTUNITIES.map((o) => o.title)).toEqual([
      'Seed: React Platform Engineer',
      'Seed: Data Pipeline Engineer',
      'Seed: Unclear Stack Vacancy',
      'Seed: Unsafe Description',
      'Seed: Uncertain Match',
    ])
  })

  it('matches each opportunity to the contract seniors as LEAD', () => {
    expect(leadIds('Seed: React Platform Engineer')).toEqual([
      OLEKSIY_ID,
      SENIOR_SHARED_ID,
      ARTEM_ID,
    ])
    expect(leadIds('Seed: Data Pipeline Engineer')).toEqual([DMYTRO_ID])
    expect(leadIds('Seed: Unclear Stack Vacancy')).toEqual([])
    expect(leadIds('Seed: Unsafe Description')).toEqual([OLEKSIY_ID])
    expect(leadIds('Seed: Uncertain Match')).toEqual([OLEKSIY_ID])
  })

  it('gives React Platform two sources and every other opportunity at least one', () => {
    expect(byTitle('Seed: React Platform Engineer').sourceCount).toBe(2)
    for (const o of SEED_QUEUE_OPPORTUNITIES) expect(o.sourceCount).toBeGreaterThanOrEqual(1)
  })

  it('puts every hostile construct the card must neutralise into the unsafe description', () => {
    const text = byTitle('Seed: Unsafe Description').description
    expect(text).toContain('<script>')
    expect(text).toMatch(/<a href="javascript:[^"]*">/)
    expect(text).toMatch(/<img src="https:\/\/[^"]+"/)
    expect(text).toContain('onerror=')
  })

  it('marks only the Uncertain Match as approximate, as the card reads it', () => {
    for (const o of SEED_QUEUE_OPPORTUNITIES) {
      for (const lead of o.leads) {
        const { approximate } = matchFacts(leadEvidence(lead))
        expect({ title: o.title, approximate }).toEqual({
          title: o.title,
          approximate: o.title === 'Seed: Uncertain Match',
        })
      }
    }
  })

  it('leaves the Uncertain Match without a trusted published date (UNKNOWN_DATE)', () => {
    const uncertain = byTitle('Seed: Uncertain Match')
    expect(uncertain.publishedDaysAgo).toBeNull()
    expect(leadEvidence(uncertain.leads[0]!).rankWarnings).toEqual(['UNKNOWN_DATE'])
  })
})

describe('the Task 7.6 seed contract, pinned exactly', () => {
  const core = (seniorId: string, keywords: string[]) => ({
    seniorId,
    keywords,
    score: 60,
    rankWarnings: [],
  })

  it('pins every opportunity field the E2E or the card reads', () => {
    expect(SEED_QUEUE_OPPORTUNITIES).toEqual([
      {
        key: 'react-platform',
        title: 'Seed: React Platform Engineer',
        employer: 'Seed Platform Labs',
        employerVerified: true,
        roleFamily: 'SOFTWARE',
        stackKeywords: ['React', 'TypeScript', 'Node.js'],
        sourceCount: 2,
        description:
          '## About the role\n\nBuild the React platform our product teams ship on.\n\n' +
          '- React and TypeScript every day\n- Node.js services behind the UI\n',
        publishedDaysAgo: 1,
        leads: [
          core(OLEKSIY_ID, ['React:CORE', 'TypeScript:CORE', 'Node.js:OPTIONAL']),
          core(SENIOR_SHARED_ID, ['React:CORE', 'TypeScript:CORE']),
          core(ARTEM_ID, ['React:CORE', 'TypeScript:OPTIONAL']),
        ],
      },
      {
        key: 'data-pipeline',
        title: 'Seed: Data Pipeline Engineer',
        employer: 'Seed Data Works',
        employerVerified: true,
        roleFamily: 'DATA',
        stackKeywords: ['Python', 'PostgreSQL'],
        sourceCount: 1,
        description:
          '## About the role\n\nOwn the batch and streaming pipelines.\n\n- Python\n- PostgreSQL\n',
        publishedDaysAgo: 2,
        leads: [core(DMYTRO_ID, ['Python:CORE', 'PostgreSQL:CORE'])],
      },
      {
        key: 'unclear-stack',
        title: 'Seed: Unclear Stack Vacancy',
        employer: 'Seed Mystery Startup',
        employerVerified: false,
        roleFamily: null,
        stackKeywords: [],
        sourceCount: 1,
        description: 'We are hiring a great engineer. Details on the call.',
        publishedDaysAgo: 3,
        leads: [],
      },
      {
        key: 'unsafe-description',
        title: 'Seed: Unsafe Description',
        employer: 'Seed Hostile Markup Inc',
        employerVerified: true,
        roleFamily: 'SOFTWARE',
        stackKeywords: ['React', 'TypeScript'],
        sourceCount: 1,
        description:
          '## Unsafe description\n\n<script>window.__seedXss = true</script>\n\n' +
          '<a href="javascript:window.__seedXss=true">Apply here</a>\n\n' +
          '<img src="https://tracker.example.test/pixel.png" onerror="window.__seedXss=true">\n\n' +
          'React and TypeScript.\n',
        publishedDaysAgo: 1,
        leads: [core(OLEKSIY_ID, ['React:CORE', 'TypeScript:CORE'])],
      },
      {
        key: 'uncertain-match',
        title: 'Seed: Uncertain Match',
        employer: 'Seed Fuzzy Signals',
        employerVerified: true,
        roleFamily: 'SOFTWARE',
        stackKeywords: ['Python', 'AWS'],
        sourceCount: 1,
        description:
          '## About the role\n\nSome Python, maybe AWS. The stack is still being decided.\n',
        publishedDaysAgo: null,
        leads: [
          {
            seniorId: OLEKSIY_ID,
            keywords: ['Python:OPTIONAL', 'AWS:OPTIONAL'],
            score: 20,
            rankWarnings: ['UNKNOWN_DATE'],
          },
        ],
      },
    ])
  })

  it('writes the evidence in the shape `evaluate` persists', () => {
    expect(leadEvidence(core(OLEKSIY_ID, ['React:CORE']))).toEqual({
      score: 60,
      reasons: [{ code: 'TECH_MATCH', evidence: ['React:CORE'], ruleVersion: 'seed' }],
      rankWarnings: [],
    })
  })

  it('pins the team memberships of the job-queue E2E users, team names sorted', () => {
    expect(SEED_QUEUE_MEMBERSHIPS).toEqual([
      { who: 'U-HR2', userId: HR2_ID, teams: ['Team Kovalenko'] },
      { who: 'U-HR0', userId: HR0_ID, teams: [] },
      { who: 'S-SHARED', userId: SENIOR_SHARED_ID, teams: ['Team Kovalenko', 'Team Marchenko'] },
    ])
  })
})
