import { describe, expect, it } from 'vitest'
import { matchFacts } from '../../job-sourcing/queue/job-queue.service'
import { ARTEM_ID, DMYTRO_ID, OLEKSIY_ID, SENIOR_SHARED_ID } from './ids'
import { leadEvidence, SEED_QUEUE_OPPORTUNITIES } from './job-queue.data'

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
