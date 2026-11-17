/**
 * Display-only "k of n skills" indicator for a (vacancy, senior) pair. Ranking never reads it.
 * n = dictionary technologies named in the vacancy text; k = those the senior's resume has.
 */
import { SKILL_SYNONYM_GROUPS, canonicalSkill, skillMentions } from '../schemas/resume-skills'

/**
 * Canonical names of every dictionary technology `text` (title + description) mentions,
 * sorted and deduplicated. Provider tags are never passed in.
 */
export function vacancyTechnologies(text: string): readonly string[] {
  const mentions = skillMentions(text)
  return SKILL_SYNONYM_GROUPS.filter(({ canonical }) => mentions(canonical))
    .map(({ canonical }) => canonical)
    .sort()
}

export type SkillOverlap = { matched: readonly string[]; total: number }

/**
 * `null` when the vacancy names no technology (no indicator); `'NO_RESUME'` when the senior has
 * no resume skills, so an empty resume never reads as "0 of n".
 */
export function skillOverlap(
  vacancy: readonly string[],
  seniorSkills: readonly string[] | null,
): SkillOverlap | 'NO_RESUME' | null {
  if (vacancy.length === 0) return null
  if (!seniorSkills || seniorSkills.length === 0) return 'NO_RESUME'
  const senior = new Set(seniorSkills.map(canonicalSkill))
  return {
    matched: vacancy.filter((skill) => senior.has(canonicalSkill(skill))),
    total: vacancy.length,
  }
}
