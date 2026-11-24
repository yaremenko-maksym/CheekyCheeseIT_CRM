import { describe, expect, it } from 'vitest'
import { TECHNICAL_ROLES } from '../schemas/technical-roles'
import {
  DOU_CATEGORIES,
  EXTERNAL_FEEDS,
  FEED_KEYWORDS,
  ROLE_TO_DOU_CATEGORY,
  type ExternalFeedId,
} from './external-feeds'

const url = (
  id: ExternalFeedId,
  roles: Parameters<(typeof EXTERNAL_FEEDS)[number]['buildUrl']>[0]['roles'],
) => {
  const feed = EXTERNAL_FEEDS.find((f) => f.id === id)
  if (!feed) throw new Error(`no feed ${id}`)
  return feed.buildUrl({ roles })
}

describe('EXTERNAL_FEEDS', () => {
  it('lists the four unconnectable sources in a fixed order', () => {
    expect(EXTERNAL_FEEDS.map((f) => f.id)).toEqual([
      'DOU',
      'LINKEDIN',
      'THE_MUSE',
      'EU_REMOTE_JOBS',
    ])
    expect(EXTERNAL_FEEDS.map((f) => f.label)).toEqual([
      'DOU',
      'LinkedIn',
      'The Muse',
      'EU Remote Jobs',
    ])
  })

  describe('DOU', () => {
    it('a role with a DOU category uses that category, 5+ years, remote', () => {
      expect(url('DOU', ['DEVOPS_ENGINEER'])).toBe(
        'https://jobs.dou.ua/vacancies/?category=DevOps&exp=5plus&remote',
      )
    })

    it('URL-encodes a category with reserved characters', () => {
      expect(url('DOU', ['ML_ENGINEER'])).toBe(
        'https://jobs.dou.ua/vacancies/?category=AI%2FML&exp=5plus&remote',
      )
      expect(url('DOU', ['FRONTEND_ENGINEER'])).toBe(
        'https://jobs.dou.ua/vacancies/?category=Front%20End&exp=5plus&remote',
      )
    })

    it('a role without a DOU category searches its keyword', () => {
      expect(url('DOU', ['BACKEND_ENGINEER'])).toBe(
        'https://jobs.dou.ua/vacancies/?search=backend%20engineer&exp=5plus&remote',
      )
    })

    it('no roles gives the general senior + remote filter', () => {
      expect(url('DOU', [])).toBe('https://jobs.dou.ua/vacancies/?exp=5plus&remote')
    })

    it('uses the first role only', () => {
      expect(url('DOU', ['QA_ENGINEER', 'DEVOPS_ENGINEER'])).toBe(
        'https://jobs.dou.ua/vacancies/?category=QA&exp=5plus&remote',
      )
    })
  })

  describe('LinkedIn', () => {
    it('keywords of the first role, mid-senior, remote, newest first', () => {
      expect(url('LINKEDIN', ['BACKEND_ENGINEER', 'QA_ENGINEER'])).toBe(
        'https://www.linkedin.com/jobs/search/?keywords=backend%20engineer&f_E=4&f_WT=2&sortBy=DD',
      )
    })

    it('URL-encodes keywords', () => {
      expect(url('LINKEDIN', ['UI_UX_DESIGNER'])).toBe(
        'https://www.linkedin.com/jobs/search/?keywords=ui%2Fux%20designer&f_E=4&f_WT=2&sortBy=DD',
      )
    })

    it('no roles drops the keywords and keeps the filters', () => {
      expect(url('LINKEDIN', [])).toBe(
        'https://www.linkedin.com/jobs/search/?f_E=4&f_WT=2&sortBy=DD',
      )
    })
  })

  describe('The Muse', () => {
    it('keyword, remote, posted in the last 30 days', () => {
      expect(url('THE_MUSE', ['DATA_ENGINEER'])).toBe(
        'https://www.themuse.com/search?q=data%20engineer&remote=1&posted=30',
      )
    })

    it('no roles drops the keyword', () => {
      expect(url('THE_MUSE', [])).toBe('https://www.themuse.com/search?remote=1&posted=30')
    })
  })

  describe('EU Remote Jobs', () => {
    it('keyword search on the jobs page', () => {
      expect(url('EU_REMOTE_JOBS', ['ANDROID_ENGINEER'])).toBe(
        'https://euremotejobs.com/jobs/?search_keywords=android%20engineer',
      )
    })

    it('no roles opens the jobs page', () => {
      expect(url('EU_REMOTE_JOBS', [])).toBe('https://euremotejobs.com/jobs/')
    })
  })

  it('every feed builds an https URL for every role', () => {
    for (const feed of EXTERNAL_FEEDS) {
      for (const role of TECHNICAL_ROLES) {
        expect(new URL(feed.buildUrl({ roles: [role] })).protocol).toBe('https:')
      }
    }
  })
})

describe('role maps', () => {
  it('every role has a non-empty lowercase English keyword', () => {
    for (const role of TECHNICAL_ROLES) {
      expect(FEED_KEYWORDS[role]).toMatch(/^[a-z][a-z0-9 /+.-]*$/)
    }
  })

  it('every DOU category in the map is one DOU really offers', () => {
    for (const category of Object.values(ROLE_TO_DOU_CATEGORY)) {
      expect(DOU_CATEGORIES).toContain(category)
    }
  })
})
