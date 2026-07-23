import type { TagVariant } from '@/components/ui/tag'

/**
 * Static copy for the "/" route (Home) — everything except case studies
 * (own file, `case-studies.ts`) and the terminal snippets (own file,
 * `marketing/terminal.tsx`, tightly coupled to the tokenizer). Text is taken
 * 1:1 from docs/design/assets/landing-redesign/Home.dc.html per
 * docs/design/landing-redesign.md §2.4/§10.
 */

export interface StatItem {
  value: string
  suffix: string
  label: string
}

export const stats: StatItem[] = [
  { value: '40', suffix: '+', label: 'Projects shipped' },
  { value: '15', suffix: '+', label: 'Product clients' },
  { value: '3', suffix: '+', label: 'Years operating' },
  { value: '20', suffix: '+', label: 'Senior engineers' },
]

export const aboutBullets = [
  'Senior-only pods',
  'Weekly, shippable increments',
  'Own the outcome, not the ticket',
  '4+ hours timezone overlap',
]

export interface ServiceItem {
  domain: TagVariant
  domainLabel: string
  title: string
  description: string
  bullets: [string, string, string]
}

export const services: ServiceItem[] = [
  {
    domain: 'ai',
    domainLabel: 'AI / ML',
    title: 'Applied AI & ML',
    description:
      'Inference platforms, RAG pipelines, recommendation and vision systems — built to be fast, observable and affordable in production.',
    bullets: ['Model serving & MLOps', 'LLM & RAG applications', 'Data & feature pipelines'],
  },
  {
    domain: 'edtech',
    domainLabel: 'EdTech',
    title: 'EdTech platforms',
    description:
      'Adaptive learning, assessment engines and content tooling — engaging for learners, measurable for the institutions behind them.',
    bullets: ['Adaptive learning paths', 'Assessment & analytics', 'Authoring & LMS tooling'],
  },
  {
    domain: 'ecommerce',
    domainLabel: 'E-Commerce',
    title: 'E-Commerce systems',
    description:
      'Headless storefronts, checkout and inventory at scale — resilient on launch days and fast for shoppers everywhere.',
    bullets: ['Headless storefronts', 'Edge checkout & payments', 'Inventory & fulfilment'],
  },
]

export interface ProcessStepItem {
  stepNum: string
  title: string
  description: string
}

export const processSteps: ProcessStepItem[] = [
  {
    stepNum: '01 / Discovery',
    title: 'Discovery',
    description: 'We scope the problem, de-risk the unknowns and agree a plan you can hold us to.',
  },
  {
    stepNum: '02 / Build',
    title: 'Build',
    description: 'Senior pods ship weekly increments in your repo, in your stack, in the open.',
  },
  {
    stepNum: '03 / Ship',
    title: 'Ship',
    description:
      'We release to production with monitoring, load tests and a rollback you never need.',
  },
  {
    stepNum: '04 / Support',
    title: 'Support',
    description: 'We stay on for the long tail — performance, reliability and the next iteration.',
  },
]

export const techStack: string[] = [
  'TypeScript',
  'React',
  'Next.js',
  'Node.js',
  'Python',
  'PyTorch',
  'TensorFlow',
  'Go',
  'PostgreSQL',
  'Redis',
  'GraphQL',
  'Kubernetes',
  'Docker',
  'AWS',
  'GCP',
  'Terraform',
  'Stripe',
  'Kafka',
]

/** Единственный контактный имейл на всём лендинге (task-landing-redesign.md AC3). */
export const CONTACT_EMAIL = 'hr@cheekycheese.tech'

/** Careers-тизер на "/" показывает максимум 3 живые вакансии (AC2). */
export const HOME_CAREERS_TEASER_LIMIT = 3
