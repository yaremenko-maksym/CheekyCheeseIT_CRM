import { canonicalSkill, mentionsSkill, vacancyTechnologies, type ResumeContent } from '@crm/shared'
import { MAX_POSTING_CHARS } from '../extraction-worker/link-contract'

/** Where a posting requirement stands against the base resume (spec: gap analysis). */
export type Bucket = 'existing' | 'supported' | 'gap'

/** The worker body's per-list and per-label limits (`tailorBodySchema`). */
export const MAX_REQUIREMENTS = 100
const MAX_LABEL_CHARS = 200

// Stryker disable next-line MethodExpression: equivalent — any case fold works for a key used only for equality
const keyOf = (skill: string) => skill.toLowerCase()

/**
 * The posting's requirements: dictionary technologies named in its text, then its stack keywords,
 * canonicalised and deduplicated in first-seen order, cut to what the worker body accepts.
 */
export function extractRequirements(text: string, stackKeywords: readonly string[]): string[] {
  const out = new Map<string, string>()
  for (const raw of [...vacancyTechnologies(text), ...stackKeywords]) {
    const skill = canonicalSkill(raw)
    if (skill === '' || skill.length > MAX_LABEL_CHARS || out.has(keyOf(skill))) continue
    out.set(keyOf(skill), skill)
  }
  return [...out.values()].slice(0, MAX_REQUIREMENTS)
}

/** `existing` — a base skill; `supported` — named in the summary or a bullet; else a gap. */
export function bucketOf(requirement: string, base: ResumeContent): Bucket {
  const key = keyOf(canonicalSkill(requirement))
  if (base.skills.some((s) => keyOf(canonicalSkill(s)) === key)) return 'existing'
  const texts = [base.summary, ...base.experience.flatMap((e) => e.bullets)]
  return texts.some((t) => mentionsSkill(t, requirement)) ? 'supported' : 'gap'
}

/** The posting text cut to `MAX_POSTING_CHARS`, at the last sentence end that fits. */
export function capPosting(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_POSTING_CHARS) return { text, truncated: false }
  // One char past the cap, so a sentence end exactly at the cap still sees its following space.
  const head = text.slice(0, MAX_POSTING_CHARS + 1)
  let end = 0
  for (const m of head.matchAll(/[.!?](?=\s)/g)) end = m.index + 1
  return { text: end > 0 ? text.slice(0, end) : text.slice(0, MAX_POSTING_CHARS), truncated: true }
}
