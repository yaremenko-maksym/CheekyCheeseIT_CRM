import { ARTEM_ID, DMYTRO_ID, OLEKSIY_ID, SENIOR_SHARED_ID } from './ids'

/**
 * Task 7.6a — the job-queue rows the Task 7.6 E2E proves the rights scenarios on. The E2E finds
 * every row through the real API by its TITLE, so the titles and the matched seniors are a
 * contract (`.claude/tasks/task-vacancy-7-6a-queue-seed.md`): change neither without Task 7.6.
 */
export interface SeedQueueLead {
  readonly seniorId: string
  /** `keyword:STRENGTH` items of the TECH_MATCH reason. No CORE item = an approximate match. */
  readonly keywords: readonly string[]
  readonly score: number
  /** `rank.ts` RankWarning values carried on the match evidence. */
  readonly rankWarnings: readonly ('FUTURE_DATE' | 'UNKNOWN_DATE')[]
}

export interface SeedQueueOpportunity {
  /** Stable slug: title key, source identity keys and URLs derive from it. */
  readonly key: string
  readonly title: string
  readonly employer: string
  readonly employerVerified: boolean
  /** Layer-1 role family; null = UNKNOWN (never matches a triage subscription). */
  readonly roleFamily: string | null
  readonly stackKeywords: readonly string[]
  readonly sourceCount: number
  readonly description: string
  /** Days before the seed run; null = the source gave no trusted date. */
  readonly publishedDaysAgo: number | null
  readonly leads: readonly SeedQueueLead[]
}

const core = (seniorId: string, keywords: readonly string[]): SeedQueueLead => ({
  seniorId,
  keywords,
  score: 60,
  rankWarnings: [],
})

export const SEED_QUEUE_OPPORTUNITIES: readonly SeedQueueOpportunity[] = [
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
    // Every construct the card's description renderer must neutralise (Task 7.6 XSS case).
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
    description: '## About the role\n\nSome Python, maybe AWS. The stack is still being decided.\n',
    // No trusted published date, so the match carries UNKNOWN_DATE.
    publishedDaysAgo: null,
    // OPTIONAL-only keywords: the card shows the match as approximate (`matchApproximate`).
    leads: [
      {
        seniorId: OLEKSIY_ID,
        keywords: ['Python:OPTIONAL', 'AWS:OPTIONAL'],
        score: 20,
        rankWarnings: ['UNKNOWN_DATE'],
      },
    ],
  },
]

/** The `job_opportunity_matches.evidence` of one LEAD, in the shape `evaluate` persists. */
export function leadEvidence(lead: SeedQueueLead): {
  score: number
  reasons: { code: 'TECH_MATCH'; evidence: string[]; ruleVersion: string }[]
  rankWarnings: string[]
} {
  return {
    score: lead.score,
    reasons: [{ code: 'TECH_MATCH', evidence: [...lead.keywords], ruleVersion: 'seed' }],
    rankWarnings: [...lead.rankWarnings],
  }
}
