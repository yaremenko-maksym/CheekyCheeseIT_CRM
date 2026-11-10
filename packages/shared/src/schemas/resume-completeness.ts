/**
 * Resume completeness check (verified-base-resume spec §5.1).
 *
 * Deterministic and dependency-free: it runs live in the HR form and again on
 * the server at Submit, so the same facts must always produce the same issues in
 * the same order. Paths address a field (`experience.1.start`) or a list
 * (`skills`, `experience.<i>.notes`); the UI maps them to inputs.
 *
 * `now` is injected rather than read from the clock, so the future-start check
 * is testable and the server can freeze one timestamp for a whole check run.
 */
import type { ResumeFacts, ResumeFactsExperience } from './resume-facts'
import { mergeSkills } from './resume-skills'

export const COMPLETENESS_CODES = [
  'HEADLINE_MISSING',
  'NO_EXPERIENCE',
  'COMPANY_MISSING',
  'ROLE_MISSING',
  'START_MISSING',
  'END_MISSING',
  'END_BEFORE_START',
  'START_IN_FUTURE',
  'END_IN_FUTURE',
  'NO_NOTES',
  'TOO_FEW_SKILLS',
  'ENGLISH_MISSING',
  'NON_LATIN',
  'NAME_NON_LATIN',
  'CONTACT_IN_TEXT',
] as const
export type CompletenessCode = (typeof COMPLETENESS_CODES)[number]

export type CompletenessIssue = { path: string; code: CompletenessCode }

/**
 * A phone number: at least nine digits, with `+`, spaces, dots, parentheses,
 * hyphens or en-dashes allowed between them. The digit lookahead is what keeps dates,
 * version numbers and large figures out (`2015 – 2019`, `Mar 2021 – May 2023`,
 * `C++ 17`, `1,000,000 requests`, `Node.js 18`); commas are deliberately not a
 * separator for the same reason.
 *
 * Stateless on purpose (no `g` flag): the same pattern is reused by the API, so
 * `.test()` on a shared RegExp must not depend on an earlier call's lastIndex.
 */
export const RESUME_PHONE_PATTERN = /(?=(?:[^\d\p{L}]*\d){9,})[+(]?\d[\d\s().–-]{7,}\d/u

/** A full date: `YYYY-MM-DD` / `YYYY.MM.DD` / `YYYY/MM/DD` or `DD-MM-YYYY` / `DD.MM.YYYY` / `DD/MM/YYYY`. */
const FULL_DATE = String.raw`(?:(?:19|20)\d\d[-./](?:0[1-9]|1[0-2])[-./](?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])[-./](?:0[1-9]|1[0-2])[-./](?:19|20)\d\d)`
/** A phone candidate made only of full dates and separators (`2015-01-01 - 2019-12-31`). */
const DATES_ONLY = new RegExp(String.raw`^${FULL_DATE}(?:[\s().–-]+${FULL_DATE})*$`)

/**
 * Every phone in `text` as `[start, end)` offsets: `RESUME_PHONE_PATTERN` runs,
 * minus runs that are only full dates. The one rule both the completeness check
 * and the API contact scan use. A bare ten-digit run stays a phone: a UA mobile
 * `0671234567` has that shape, and a missed phone is a leak.
 */
export function findPhoneSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  // A fresh global copy per call, so the exported pattern stays stateless.
  for (const m of text.matchAll(new RegExp(RESUME_PHONE_PATTERN.source, 'gu'))) {
    if (!DATES_ONLY.test(m[0])) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

/** An email address shape: local part with the common punctuation, and a dot TLD. */
export const RESUME_EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u

const LETTER_PATTERN = /\p{L}/u
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u

/**
 * True when every letter in `text` is Latin-script. Digits, punctuation,
 * symbols, spaces and the empty string pass — `C++ 17` and `Node.js 18` are
 * legitimate skill/technology text, while `José Müller` passes through the same
 * check as `Engineer`.
 */
export function isLatinScript(text: string): boolean {
  for (const char of text) {
    if (LETTER_PATTERN.test(char) && !LATIN_LETTER_PATTERN.test(char)) return false
  }
  return true
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

function containsContactData(text: string): boolean {
  return findPhoneSpans(text).length > 0 || RESUME_EMAIL_PATTERN.test(text)
}

function checkExperienceItem(
  item: ResumeFactsExperience,
  index: number,
  nowMonth: string,
  issues: CompletenessIssue[],
): void {
  const base = `experience.${index}`

  if (isBlank(item.company)) issues.push({ path: `${base}.company`, code: 'COMPANY_MISSING' })
  if (!isLatinScript(item.company)) issues.push({ path: `${base}.company`, code: 'NON_LATIN' })

  if (isBlank(item.role)) issues.push({ path: `${base}.role`, code: 'ROLE_MISSING' })
  if (!isLatinScript(item.role)) issues.push({ path: `${base}.role`, code: 'NON_LATIN' })

  if (item.location !== null && !isLatinScript(item.location)) {
    issues.push({ path: `${base}.location`, code: 'NON_LATIN' })
  }

  if (item.start === null) {
    issues.push({ path: `${base}.start`, code: 'START_MISSING' })
    // `YYYY-MM` sorts lexicographically, so the current month is the cutoff.
  } else {
    if (item.start > nowMonth) issues.push({ path: `${base}.start`, code: 'START_IN_FUTURE' })
    // A missing end falls back to the start, which is never before itself, so
    // no separate null check is needed (one would only add a mutant no test
    // can kill: the fallback already makes a null end compare as not-before).
    if ((item.end ?? item.start) < item.start) {
      issues.push({ path: `${base}.end`, code: 'END_BEFORE_START' })
    }
  }

  if (!item.current && item.end === null) {
    issues.push({ path: `${base}.end`, code: 'END_MISSING' })
  }
  // A null end compares as '', which is never after a month.
  if (!item.current && (item.end ?? '') > nowMonth) {
    issues.push({ path: `${base}.end`, code: 'END_IN_FUTURE' })
  }

  item.technologies.forEach((technology, technologyIndex) => {
    if (!isLatinScript(technology)) {
      issues.push({ path: `${base}.technologies.${technologyIndex}`, code: 'NON_LATIN' })
    }
    // technologies render in the Skills section, so they leak like a skill would
    if (containsContactData(technology)) {
      issues.push({ path: `${base}.technologies.${technologyIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })

  if (item.notes.every((note) => isBlank(note))) {
    issues.push({ path: `${base}.notes`, code: 'NO_NOTES' })
  }
  item.notes.forEach((note, noteIndex) => {
    if (!isLatinScript(note)) {
      issues.push({ path: `${base}.notes.${noteIndex}`, code: 'NON_LATIN' })
    }
    if (containsContactData(note)) {
      issues.push({ path: `${base}.notes.${noteIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })
}

/**
 * Every missing/blocked field, in a stable order: display name and top-level
 * fields first, experience items in index order, then education and languages.
 */
export function checkResumeCompleteness(
  facts: ResumeFacts,
  ctx: { displayName: string; now: Date },
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = []
  const nowMonth = `${ctx.now.getUTCFullYear()}-${String(ctx.now.getUTCMonth() + 1).padStart(2, '0')}`

  if (!isLatinScript(ctx.displayName)) issues.push({ path: 'displayName', code: 'NAME_NON_LATIN' })

  if (isBlank(facts.headline)) issues.push({ path: 'headline', code: 'HEADLINE_MISSING' })
  if (!isLatinScript(facts.headline)) issues.push({ path: 'headline', code: 'NON_LATIN' })
  if (containsContactData(facts.headline))
    issues.push({ path: 'headline', code: 'CONTACT_IN_TEXT' })

  if (!isLatinScript(facts.location.city)) issues.push({ path: 'location.city', code: 'NON_LATIN' })
  if (!isLatinScript(facts.location.country)) {
    issues.push({ path: 'location.country', code: 'NON_LATIN' })
  }

  const mergedSkills = mergeSkills(
    facts.skills,
    facts.experience.map((item) => item.technologies),
  )
  if (mergedSkills.length < 5) issues.push({ path: 'skills', code: 'TOO_FEW_SKILLS' })
  facts.skills.forEach((skill, skillIndex) => {
    if (!isLatinScript(skill)) issues.push({ path: `skills.${skillIndex}`, code: 'NON_LATIN' })
    if (containsContactData(skill)) {
      issues.push({ path: `skills.${skillIndex}`, code: 'CONTACT_IN_TEXT' })
    }
  })

  if (facts.experience.length === 0) issues.push({ path: 'experience', code: 'NO_EXPERIENCE' })
  facts.experience.forEach((item, index) => {
    checkExperienceItem(item, index, nowMonth, issues)
  })

  facts.education.forEach((item, index) => {
    if (!isLatinScript(item.institution)) {
      issues.push({ path: `education.${index}.institution`, code: 'NON_LATIN' })
    }
    if (!isLatinScript(item.degree)) {
      issues.push({ path: `education.${index}.degree`, code: 'NON_LATIN' })
    }
    // A missing start falls back to the end, which is never before itself.
    if (item.endYear !== null && item.endYear < (item.startYear ?? item.endYear)) {
      issues.push({ path: `education.${index}.endYear`, code: 'END_BEFORE_START' })
    }
  })

  if (!facts.languages.some((language) => language.name.trim().toLowerCase() === 'english')) {
    issues.push({ path: 'languages', code: 'ENGLISH_MISSING' })
  }
  facts.languages.forEach((language, index) => {
    if (!isLatinScript(language.name)) {
      issues.push({ path: `languages.${index}.name`, code: 'NON_LATIN' })
    }
  })

  return issues
}
