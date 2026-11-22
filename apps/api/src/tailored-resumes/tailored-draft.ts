import { canonicalSkill, RESUME_LIMITS, type ResumeContent } from '@crm/shared'
import type { GlyphFontSet } from '../resumes/resume-glyphs'
import { cleanedNotes, cleaner, MAX_FEEDBACK_ITEMS } from '../resumes/verification/content-gates'
import type { TailorReply } from './tailor-writer.client'

/** One bullet of the tailored content; `path` is `experience.<item>.bullets.<bullet>`. */
export type BulletRef = { item: number; bullet: number; path: string }

/** The writer's reply once validated and cleaned; items past `sentItems` stay as in the base. */
export type TailoredDraft = {
  summary: string
  skills: string[]
  items: { bullets: { text: string; sourceIndices: number[] }[] }[]
  coverBody: string
}

/**
 * A text a gate or the reviewer failed; `reason` is a code or the fixed reviewer line, `detail` the
 * gate's own explanation for the writer's feedback.
 */
export type FailingItem = { path: string; reason: string; detail?: string }

/** Spec §5: the letter's frame is the CRM's own, never model text and never gated. */
export const COVER_GREETING = 'Dear Hiring Team,'
export const coverClosing = (displayName: string): string => `Kind regards,\n${displayName}`
/** D8: the cover letter body, in words. */
export const COVER_MIN_WORDS = 100
export const COVER_MAX_WORDS = 220

export const bulletPath = (item: number, bullet: number): string =>
  `experience.${item}.bullets.${bullet}`

export const wordCount = (text: string): number => text.match(/\S+/gu)?.length ?? 0

/**
 * The base bullets of an item as the payload numbers its notes (`cleanedNotes` drops blank ones),
 * so `sourceIndices`, the entailment sources and a revert all read the same index space.
 */
export function sourceBullets(base: ResumeContent, item: number): string[] {
  return (base.experience[item]?.bullets ?? []).filter((b) => cleanedNotes([b]).length > 0)
}

function itemProblems(item: TailorReply['items'][number], i: number, notes: number): string[] {
  const max = RESUME_LIMITS.bulletsPerExperience
  if (item.bullets.length < 1 || item.bullets.length > max) {
    return [`Experience item ${i + 1}: return 1 to ${max} bullets.`]
  }
  const problems: string[] = []
  const used = new Set<number>()
  let reused = false
  item.bullets.forEach((b, j) => {
    const distinct = new Set(b.sourceIndices).size === b.sourceIndices.length
    if (b.sourceIndices.length === 0 || !distinct || b.sourceIndices.some((k) => k >= notes)) {
      problems.push(
        `Experience item ${i + 1}, bullet ${j + 1}: sourceIndices must be distinct note indexes of that item (0 to ${notes - 1}).`,
      )
    }
    for (const k of b.sourceIndices) {
      if (used.has(k)) reused = true
      used.add(k)
    }
  })
  if (reused && problems.length === 0) {
    problems.push(`Experience item ${i + 1}: each note may be the source of one bullet only.`)
  }
  return problems
}

/**
 * Spec §5's reply rules: exactly `sentItems` items; per item 1..`bulletsPerExperience` bullets
 * whose `sourceIndices` are distinct, in range and each note used once per item; every skill an
 * index of the base skills under its base or canonical name, each base skill once. Every text is
 * cleaned first. The feedback lines are the CRM's own, never reply text.
 *
 * An item with no base notes has nothing to tailor: the wire schema still makes the writer send a
 * bullet for it, which is ignored, and the item keeps no bullets. An empty skills list keeps the
 * base skills.
 */
export function validateTailorReply(
  reply: TailorReply,
  base: ResumeContent,
  sentItems: number,
  template: GlyphFontSet,
): { ok: true; draft: TailoredDraft } | { ok: false; feedback: string[] } {
  const clean = cleaner(template)
  const problems: string[] = []
  if (reply.items.length !== sentItems) {
    problems.push(`Return exactly ${sentItems} experience items, one per item in FACTS, in order.`)
  }
  const notes = reply.items.map((_, i) => sourceBullets(base, i).length)
  reply.items.forEach((item, i) => {
    if ((notes[i] as number) > 0) problems.push(...itemProblems(item, i, notes[i] as number))
  })
  const skills = reply.skills.map((s) => ({ index: s.index, name: clean(s.name) }))
  const named = new Set<string>()
  skills.forEach((s, k) => {
    const own = base.skills[s.index]
    if (own === undefined || (s.name !== own && s.name !== canonicalSkill(own))) {
      problems.push(
        `Skill ${k + 1}: index must be a skill of FACTS (0 to ${base.skills.length - 1}) and name that skill or its canonical name.`,
      )
      return
    }
    const key = canonicalSkill(own).toLowerCase()
    if (named.has(key)) problems.push(`Skill ${k + 1}: name each skill of FACTS once.`)
    named.add(key)
  })
  if (problems.length > 0) return { ok: false, feedback: problems.slice(0, MAX_FEEDBACK_ITEMS) }
  return {
    ok: true,
    draft: {
      summary: clean(reply.summary),
      skills: skills.length === 0 ? [...base.skills] : skills.map((s) => s.name),
      items: reply.items.map((item, i) => ({
        bullets:
          notes[i] === 0
            ? []
            : item.bullets.map((b) => ({ text: clean(b.text), sourceIndices: b.sourceIndices })),
      })),
      coverBody: clean(reply.coverLetter),
    },
  }
}

/** The tailored content: the draft's summary, skills and bullets; every other field the base's. */
export function mergeDraft(base: ResumeContent, draft: TailoredDraft): ResumeContent {
  return {
    ...base,
    summary: draft.summary,
    skills: draft.skills,
    experience: base.experience.map((item, i) => {
      const tailored = draft.items[i]
      return tailored === undefined
        ? item
        : { ...item, bullets: tailored.bullets.map((b) => b.text) }
    }),
  }
}

const frozenOf = (c: ResumeContent): string =>
  JSON.stringify([
    c.experience.map((e) => [e.company, e.role, e.period]),
    c.education,
    c.languages,
    c.links,
  ])

/** Gate 9: company, role, period, education, languages and links byte-equal; item count equal. */
export function frozenFieldsEqual(base: ResumeContent, merged: ResumeContent): boolean {
  return frozenOf(base) === frozenOf(merged)
}
