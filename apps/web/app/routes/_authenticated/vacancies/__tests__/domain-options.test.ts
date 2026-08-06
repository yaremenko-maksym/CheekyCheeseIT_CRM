/**
 * task-domains-expansion — the CRM's domain surface is now 17 values wide, and
 * two of its three parts are hand-written data (`DOMAIN_LABELS`, the brand-hue
 * map). `Record<VacancyDomain, …>` makes a MISSING label a compile error, but
 * it says nothing about the two failure modes that actually reach a user:
 *   - the Select silently dropping a domain (it used to be a literal tuple in
 *     `VacancyFormFields.tsx`, i.e. a second copy of the enum that would not
 *     have failed anything when the enum grew), and
 *   - «Other» drifting out of last position in a now-long list.
 * Both are asserted here against `VACANCY_DOMAINS` itself, so the test cannot
 * silently agree with a stale copy.
 */
import { describe, expect, it } from 'vitest'
import { VACANCY_DOMAINS, type VacancyDomain } from '@crm/shared'
import { DOMAIN_LABELS, DOMAIN_OPTIONS, domainDotColor } from '../constants'

describe('vacancy domain options (CRM)', () => {
  it('offers every domain the API accepts, exactly once', () => {
    expect([...DOMAIN_OPTIONS].sort()).toEqual([...VACANCY_DOMAINS].sort())
    expect(new Set(DOMAIN_OPTIONS).size).toBe(DOMAIN_OPTIONS.length)
  })

  it('keeps «Other» last — a catch-all in the middle of 17 options reads as a domain', () => {
    expect(DOMAIN_OPTIONS[DOMAIN_OPTIONS.length - 1]).toBe('OTHER')
  })

  it('sorts the rest by visible label, so a 17-item Select can be scanned', () => {
    const labels = DOMAIN_OPTIONS.slice(0, -1).map((d) => DOMAIN_LABELS[d])
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
  })

  it('labels every domain with a non-empty, human-readable string', () => {
    for (const domain of VACANCY_DOMAINS) {
      expect(DOMAIN_LABELS[domain], `no label for ${domain}`).toBeTruthy()
      // Never render the raw enum value — «HEALTHTECH» is a database detail.
      expect(DOMAIN_LABELS[domain]).not.toBe(domain === 'AI' ? '' : domain)
    }
  })

  it('gives a brand hue only to the three domains the design system defines one for', () => {
    const withHue = VACANCY_DOMAINS.filter((d) => domainDotColor(d) !== null)
    expect(withHue).toEqual(['AI', 'EDTECH', 'ECOMMERCE'])
  })

  it('returns null (no dot) for every other domain rather than an undefined style', () => {
    const rest: VacancyDomain[] = VACANCY_DOMAINS.filter(
      (d) => !['AI', 'EDTECH', 'ECOMMERCE'].includes(d),
    )
    expect(rest.length).toBeGreaterThan(0)
    for (const domain of rest) expect(domainDotColor(domain)).toBeNull()
  })
})
