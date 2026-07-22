import type { TagVariant } from '@/components/ui/tag'

/**
 * "Selected work" — 3 anonymised case studies (challenge → solution → 3
 * metrics), one per domain. Copy is a draft (owner reviews/edits factual
 * details post-launch — task-landing-redesign.md §Скоуп item 5) but the text
 * itself is taken 1:1 from the approved Claude Design export
 * (docs/design/assets/landing-redesign/Home.dc.html) per
 * docs/design/landing-redesign.md §2.4.
 */
export interface CaseStudyMetric {
  value: string
  suffix?: string
  label: string
}

export interface CaseStudy {
  domain: TagVariant
  domainLabel: string
  title: string
  challenge: string
  solution: string
  metrics: [CaseStudyMetric, CaseStudyMetric, CaseStudyMetric]
}

export const caseStudies: CaseStudy[] = [
  {
    domain: 'ai',
    domainLabel: 'AI / ML',
    title: 'Real-time inference platform for a vision SaaS',
    challenge:
      'Model latency spiked past 400ms under load and inference costs grew faster than revenue.',
    solution:
      'Rebuilt the serving layer with batched GPU inference, a warm model cache and autoscaling on demand.',
    metrics: [
      { value: '80', suffix: 'ms', label: 'p95 latency' },
      { value: '-64', suffix: '%', label: 'Inference cost' },
      { value: '5', suffix: '×', label: 'Throughput' },
    ],
  },
  {
    domain: 'edtech',
    domainLabel: 'EdTech',
    title: 'Adaptive learning platform for a K-12 network',
    challenge:
      'A one-size curriculum left advanced learners bored and strugglers behind; completion was falling.',
    solution:
      'Built a per-learner path engine that recommends the next lesson from live mastery signals.',
    metrics: [
      { value: '+38', suffix: '%', label: 'Completion' },
      { value: '120', suffix: 'k', label: 'Active learners' },
      { value: '+22', suffix: '%', label: 'Retention' },
    ],
  },
  {
    domain: 'ecommerce',
    domainLabel: 'E-Commerce',
    title: 'Headless storefront for a global DTC brand',
    challenge:
      'A legacy monolith buckled on launch days; checkout abandonment climbed with every page slow-down.',
    solution:
      'Re-platformed to an edge-rendered headless storefront with idempotent, zero-downtime checkout.',
    metrics: [
      { value: '1.2', suffix: 's', label: 'LCP, global' },
      { value: '+27', suffix: '%', label: 'Conversion' },
      { value: '99.99', suffix: '%', label: 'Uptime' },
    ],
  },
]
