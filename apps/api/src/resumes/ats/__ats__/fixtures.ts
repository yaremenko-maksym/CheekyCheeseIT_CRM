/**
 * The synthetic people of the ATS suite (verified-base-resume spec §7).
 *
 * Invented names, `example.com` addresses, invented companies: no real person
 * and no real employer of a real person. Periods are built with `formatPeriod`,
 * the function the frozen content uses, so they match `PERIOD_PATTERN`.
 */
import { EMPTY_RESUME_CONTENT, RESUME_LIMITS, type ResumeContent } from '@crm/shared'
import { formatPeriod } from '../../verification/derive-content'

export interface AtsFixture {
  name: string
  displayName: string
  email: string
  content: ResumeContent
}

const EDUCATION: ResumeContent['education'] = [
  {
    institution: 'Northbridge Technical University',
    degree: 'BSc Computer Science',
    period: '2008 – 2012',
  },
]
const LANGUAGES: ResumeContent['languages'] = [
  { name: 'English', level: 'C1' },
  { name: 'German', level: 'B1' },
]
const LINKS: ResumeContent['links'] = [{ label: 'GitHub', url: 'https://github.com/example' }]

function base(overrides: Partial<ResumeContent>): ResumeContent {
  return {
    ...EMPTY_RESUME_CONTENT,
    summary: 'Software engineer who ships maintainable backend and frontend code.',
    skills: ['TypeScript', 'PostgreSQL', 'Docker'],
    education: EDUCATION,
    languages: LANGUAGES,
    links: LINKS,
    ...overrides,
  }
}

/** Ten jobs back to back, newest first, from 2011 to now. */
function career(): ResumeContent['experience'] {
  const companies = [
    'Lumen Freight Systems',
    'Quarry Lane Software',
    'Bramble Analytics',
    'Tidewater Payments',
    'Copperleaf Health Tech',
    'Orchid Learning',
    'Granite Peak Logistics',
    'Saffron Retail Labs',
    'Willowmere Media',
    'Ironbark Studio',
  ]
  const roles = [
    'Principal Engineer',
    'Staff Engineer',
    'Engineering Lead',
    'Senior Backend Engineer',
    'Senior Software Engineer',
    'Software Engineer',
    'Software Engineer',
    'Junior Software Engineer',
    'Junior Developer',
    'Intern Developer',
  ]
  return companies.map((company, i) => {
    const startYear = 2024 - i * 1.5
    const start = `${Math.floor(startYear)}-${i % 2 === 0 ? '02' : '08'}`
    const end = i === 0 ? null : `${Math.floor(startYear + 1.5)}-${i % 2 === 0 ? '07' : '01'}`
    return {
      company,
      role: roles[i]!,
      period: formatPeriod(start, end, i === 0),
      bullets: [`Owned the ${company} order pipeline`, 'Mentored two engineers'],
    }
  })
}

export const ATS_FIXTURES: readonly AtsFixture[] = [
  {
    name: 'junior-one-job',
    displayName: 'Mila Brandt',
    email: 'mila.brandt@example.com',
    content: base({
      summary: 'Junior developer with one year of commercial experience.',
      experience: [
        {
          company: 'Fernhill Digital',
          role: 'Junior Developer',
          period: formatPeriod('2024-06', '2025-07', false),
          bullets: [
            'Built internal admin screens in React',
            'Wrote unit tests for the billing API',
          ],
        },
      ],
    }),
  },
  {
    name: 'career-15y',
    displayName: 'Arden Kowal',
    email: 'arden.kowal@example.com',
    content: base({
      summary: 'Engineer with fifteen years across logistics, payments and health tech.',
      experience: career(),
    }),
  },
  {
    name: 'long-names',
    displayName: 'Theodora Vasquez-Lindqvist',
    email: 'theodora.vasquez-lindqvist@example.com',
    content: base({
      experience: [
        {
          company: 'Consolidated Northern Agricultural Machinery and Precision Irrigation Holdings',
          role: 'Senior Principal Platform Reliability Engineering Architect',
          period: formatPeriod('2019-04', '2024-11', false),
          bullets: ['Designed the telemetry ingestion platform for field equipment'],
        },
        {
          company: 'Riverside Interactive Entertainment and Educational Software Studio',
          role: 'Lead Full-Stack Engineer, Customer Subscription Platforms',
          period: formatPeriod('2015-01', '2019-03', false),
          bullets: ['Rebuilt the subscription checkout'],
        },
      ],
    }),
  },
  {
    name: 'diacritics',
    displayName: 'José Müller',
    email: 'jose.mueller@example.com',
    content: base({
      summary: 'Ingeniero de software. Erfahrung mit Zürich-basierten Teams, café-culture remote.',
      experience: [
        {
          company: 'Señora Pérez Ingeniería',
          role: 'Desarrollador Sénior',
          period: formatPeriod('2020-09', '2025-02', false),
          bullets: ['Migró la facturación a PostgreSQL', 'Führte Code-Reviews für fünf Entwickler'],
        },
      ],
      education: [
        { institution: 'Universität Köln', degree: 'Diplom Informatik', period: '2010 – 2015' },
      ],
    }),
  },
  {
    name: 'symbol-skills',
    displayName: 'Rowan Achebe',
    email: 'rowan.achebe@example.com',
    content: base({
      skills: ['C#', 'C++', '.NET', 'Node.js', 'CI/CD', 'ASP.NET Core', 'F#', 'Vue.js'],
      experience: [
        {
          company: 'Kestrel Robotics',
          role: '.NET Engineer',
          period: formatPeriod('2018-05', '2025-01', false),
          bullets: [
            'Ported the C++ motion planner to C# on .NET 8',
            'Set up CI/CD for Node.js tools',
          ],
        },
      ],
    }),
  },
  {
    name: 'no-education',
    displayName: 'Ilse Marangoni',
    email: 'ilse.marangoni@example.com',
    content: base({
      education: [],
      experience: [
        {
          company: 'Pinecrest Labs',
          role: 'Self-taught Frontend Engineer',
          period: formatPeriod('2017-03', '2024-12', false),
          bullets: ['Shipped the design system used by four products'],
        },
      ],
    }),
  },
  {
    name: 'current-job',
    displayName: 'Casimir Oduya',
    email: 'casimir.oduya@example.com',
    content: base({
      experience: [
        {
          company: 'Harborlight Insurance Tech',
          role: 'Senior Backend Engineer',
          period: formatPeriod('2022-10', null, true),
          bullets: ['Leads the claims service rewrite'],
        },
        {
          company: 'Marlow Data Works',
          role: 'Backend Engineer',
          period: formatPeriod('2018-02', '2022-09', false),
          bullets: ['Built the nightly reporting jobs'],
        },
      ],
    }),
  },
  {
    name: 'max-bullets',
    displayName: 'Petra Lindgren',
    email: 'petra.lindgren@example.com',
    content: base({
      experience: [
        {
          company: 'Bluefin Commerce',
          role: 'Senior Software Engineer',
          period: formatPeriod('2016-01', '2025-06', false),
          bullets: Array.from(
            { length: RESUME_LIMITS.bulletsPerExperience },
            (_, b) => `Delivered milestone ${b + 1} of the storefront platform roadmap`,
          ),
        },
      ],
    }),
  },
  {
    name: 'max-skills',
    displayName: 'Oren Halvorsen',
    email: 'oren.halvorsen@example.com',
    content: base({
      skills: Array.from({ length: RESUME_LIMITS.skills }, (_, s) => `Skill${s + 1}`),
      experience: [
        {
          company: 'Thornfield Systems',
          role: 'Platform Engineer',
          period: formatPeriod('2019-07', '2025-03', false),
          bullets: ['Runs the Kubernetes platform for forty services'],
        },
      ],
    }),
  },
]
