import {
  canonicalSkill,
  RESUME_LIMITS,
  skillMentions,
  vacancyTechnologies,
  type ResumeContent,
} from '@crm/shared'
import { MAX_POSTING_CHARS } from '../extraction-worker/link-contract'
import { REDACTED } from '../resumes/verification/content-gates'

/** Where a posting requirement stands against the base resume (spec: gap analysis). */
export type Bucket = 'existing' | 'supported' | 'gap'

/** The worker body's per-list and per-label limits (`tailorBodySchema`). */
export const MAX_REQUIREMENTS = 100
const MAX_LABEL_CHARS = RESUME_LIMITS.shortText

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

/**
 * A requirement's bucket against `base`, its skill keys and texts read once (CR-M-5):
 * `existing` — a base skill; `supported` — named in the summary or a bullet; else a gap.
 */
export function bucketOf(base: ResumeContent): (requirement: string) => Bucket {
  const skills = new Set(base.skills.map((s) => keyOf(canonicalSkill(s))))
  const texts = [base.summary, ...base.experience.flatMap((e) => e.bullets)].map(skillMentions)
  return (requirement) => {
    if (skills.has(keyOf(canonicalSkill(requirement)))) return 'existing'
    return texts.some((mentions) => mentions(requirement)) ? 'supported' : 'gap'
  }
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a redaction marker (the cut moves before
 * it) nor between the two halves of a surrogate pair.
 */
export function safeCut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const marker = text.lastIndexOf(REDACTED, end - 1)
  if (marker >= 0 && marker + REDACTED.length > end) end = marker
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * The posting text cut to `MAX_POSTING_CHARS`: at the last sentence end that fits; when that keeps
 * under half the cap, at the last word boundary; when that does too, a hard cut (`safeCut`).
 */
export function capPosting(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_POSTING_CHARS) return { text, truncated: false }
  // One char past the cap, so a sentence end exactly at the cap still sees its following space.
  const head = text.slice(0, MAX_POSTING_CHARS + 1)
  const short = (end: number) => end * 2 < MAX_POSTING_CHARS
  let end = 0
  for (const m of head.matchAll(/[.!?](?=\s)/gu)) end = m.index + 1
  if (short(end)) end = head.search(/\s\S*$/u)
  return {
    text: short(end) ? safeCut(text, MAX_POSTING_CHARS) : text.slice(0, end),
    truncated: true,
  }
}
