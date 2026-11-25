import { describe, expect, it } from 'vitest'
import { TECHNICAL_ROLES } from '../schemas/technical-roles'
import {
  DOU_CATEGORIES,
  EXTERNAL_FEEDS,
  FEED_KEYWORDS,
  ROLE_TO_DJINNI_KEYWORD,
  ROLE_TO_DOU_CATEGORY,
  ROLE_TO_NOFLUFF_CATEGORY,
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
  it('lists the unconnected sources, then the partly collected ones, in a fixed order', () => {
    expect(EXTERNAL_FEEDS.map((f) => f.id)).toEqual([
      'DOU',
      'LINKEDIN',
      'THE_MUSE',
      'EU_REMOTE_JOBS',
      'WELCOME_TO_THE_JUNGLE',
      'DJINNI',
      'JUSTJOIN',
      'NO_FLUFF_JOBS',
      'DICE',
      'THE_HUB',
      'LANDING_JOBS',
      'NEXT_LEVEL_JOBS',
      'JOBSPRESSO',
    ])
    expect(EXTERNAL_FEEDS.map((f) => f.label)).toEqual([
      'DOU',
      'LinkedIn',
      'The Muse',
      'EU Remote Jobs',
      'Welcome to the Jungle',
      'Djinni',
      'JustJoin.it',
      'No Fluff Jobs',
      'Dice',
      'The Hub',
      'Landing.jobs',
      'Next Level Jobs',
      'Jobspresso',
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

  describe('Djinni', () => {
    it("the role's primary keyword, 5+ years, remote", () => {
      expect(url('DJINNI', ['QA_AUTOMATION_ENGINEER'])).toBe(
        'https://djinni.co/jobs/?primary_keyword=QA%20Automation&exp_level=5y&employment=remote',
      )
    })

    it('a role without a keyword and no roles keep only the general filters', () => {
      const general = 'https://djinni.co/jobs/?exp_level=5y&employment=remote'
      expect(url('DJINNI', ['BACKEND_ENGINEER'])).toBe(general)
      expect(url('DJINNI', [])).toBe(general)
    })
  })

  describe('JustJoin.it', () => {
    it('category path, senior', () => {
      expect(url('JUSTJOIN', ['DEVOPS_ENGINEER'])).toBe(
        'https://justjoin.it/job-offers/remote/devops?experience-levels=senior',
      )
    })

    it('no category lists all remote senior jobs', () => {
      expect(url('JUSTJOIN', [])).toBe(
        'https://justjoin.it/job-offers/remote?experience-levels=senior',
      )
    })
  })

  describe('No Fluff Jobs', () => {
    it('category path, senior', () => {
      expect(url('NO_FLUFF_JOBS', ['BACKEND_ENGINEER'])).toBe(
        'https://nofluffjobs.com/remote/backend?criteria=seniority%3Dsenior',
      )
    })

    it('no category lists all remote senior jobs', () => {
      expect(url('NO_FLUFF_JOBS', ['CTO'])).toBe(
        'https://nofluffjobs.com/remote?criteria=seniority%3Dsenior',
      )
    })
  })

  describe('Dice', () => {
    it('keyword, remote, last 7 days', () => {
      expect(url('DICE', ['DATA_ENGINEER'])).toBe(
        'https://www.dice.com/jobs?q=data%20engineer&filters.workplaceTypes=Remote&filters.postedDate=SEVEN',
      )
    })

    it('no roles drops the keyword', () => {
      expect(url('DICE', [])).toBe(
        'https://www.dice.com/jobs?filters.workplaceTypes=Remote&filters.postedDate=SEVEN',
      )
    })
  })

  describe('The Hub', () => {
    it('a mapped role, remote', () => {
      expect(url('THE_HUB', ['FULLSTACK_ENGINEER'])).toBe(
        'https://thehub.io/jobs?roles=fullstackdeveloper&countryCode=REMOTE',
      )
    })

    it('an unmapped role keeps only remote', () => {
      expect(url('THE_HUB', ['QA_ENGINEER'])).toBe('https://thehub.io/jobs?countryCode=REMOTE')
    })
  })

  describe('Landing.jobs', () => {
    it('keyword, remote', () => {
      expect(url('LANDING_JOBS', ['GAME_DEVELOPER'])).toBe(
        'https://landing.jobs/jobs?q=game%20developer&remote=true',
      )
    })

    it('no roles keeps remote', () => {
      expect(url('LANDING_JOBS', [])).toBe('https://landing.jobs/jobs?remote=true')
    })
  })

  describe('Jobspresso', () => {
    it('keyword search', () => {
      expect(url('JOBSPRESSO', ['CTO'])).toBe(
        'https://jobspresso.co/remote-work/?search_keywords=cto',
      )
    })

    it('no roles opens the list', () => {
      expect(url('JOBSPRESSO', [])).toBe('https://jobspresso.co/remote-work/')
    })
  })

  it('Welcome to the Jungle and Next Level Jobs open a fixed list', () => {
    expect(url('WELCOME_TO_THE_JUNGLE', ['CTO'])).toBe('https://www.welcometothejungle.com/en/jobs')
    expect(url('NEXT_LEVEL_JOBS', ['CTO'])).toBe('https://nextleveljobs.eu/')
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

  it('every Djinni keyword in the map is one of its filter values', () => {
    // A subset of the api's DJINNI_PRIMARY_KEYWORDS; shared cannot import the api package.
    const known = ['JavaScript', 'Fullstack', 'ERP', 'iOS', 'Android', 'Data Engineer', 'SQL',
      'Data Analyst', 'Data Science', 'ML AI', 'DevOps', 'Sysadmin', 'Support', 'QA',
      'QA Automation', 'Security', 'Security Analyst', 'Penetration Tester', 'Embedded',
      'Hardware Engineer', 'Game Developer', 'Architect', 'Engineering Manager', 'CTO',
      'Business Analyst', 'UI UX'] // prettier-ignore
    for (const keyword of Object.values(ROLE_TO_DJINNI_KEYWORD)) {
      expect(known).toContain(keyword)
    }
  })

  it('every No Fluff Jobs category is one that resolved on the site', () => {
    const resolved = ['backend', 'frontend', 'fullstack', 'mobile', 'embedded', 'testing', 'devops',
      'architecture', 'security', 'artificial-intelligence', 'data', 'business-analyst', 'ux',
      'support', 'project-manager', 'erp'] // prettier-ignore
    for (const category of Object.values(ROLE_TO_NOFLUFF_CATEGORY)) {
      expect(resolved).toContain(category)
    }
  })

  it('every DOU category in the map is one DOU really offers', () => {
    for (const category of Object.values(ROLE_TO_DOU_CATEGORY)) {
      expect(DOU_CATEGORIES).toContain(category)
    }
  })
})
