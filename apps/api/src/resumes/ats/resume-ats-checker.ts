/**
 * ATS gate on the rendered PDF text layer (verified-base-resume spec §5.3).
 *
 * Pure: the caller renders the PDF and extracts `pages` with
 * `ResumeTextExtractionService.extractRenderedPages`; this module only reads
 * them. The checks mirror what the shared skeleton prints
 * (`assets/typst/resume-skeleton.typ`): the name and email, then one heading
 * per visible non-empty section in the effective order, then its body.
 *
 * Text is compared after whitespace normalisation, so a line wrap inside a
 * bullet or a summary does not count as a difference.
 */
import {
  normalizeResumeLayout,
  type ResumeContent,
  type ResumeLayoutOptions,
  type ResumeSectionKey,
} from '@crm/shared'
import { MONTH_LABELS } from '../verification/derive-content'

export const ATS_MAX_PAGES = 2
export const ATS_MAX_BYTES = 1_048_576

const MONTH = `(?:${MONTH_LABELS.join('|')}) \\d{4}`

/** Exactly the non-empty shapes `formatPeriod` prints, and nothing else. */
export const PERIOD_PATTERN = new RegExp(`^${MONTH}(?: – (?:${MONTH}|Present))?$`)

/** Four or more single letters separated by single spaces, at letter boundaries (`\b` is ASCII-only). */
const LETTER_SPACED = /(?<!\p{L})(?:\p{L} ){3,}\p{L}(?!\p{L})/u
const LIGATURE = /[\uFB00-\uFB06]/u

/** The heading text the skeleton prints for each section. */
const SECTION_TITLES: Record<ResumeSectionKey, string> = {
  summary: 'Summary',
  experience: 'Experience',
  skills: 'Skills',
  education: 'Education',
  languages: 'Languages',
  links: 'Links',
}
const TITLES = new Set(Object.values(SECTION_TITLES))

export type AtsFailureCode =
  | 'MISSING_TEXT'
  | 'HEADING_MISSING'
  | 'HEADING_ORDER'
  | 'HIDDEN_SECTION_PRESENT'
  | 'ITEM_ORDER'
  | 'PERIOD_FORMAT'
  | 'CONTACT_NOT_IN_BODY'
  | 'REPLACEMENT_CHAR'
  | 'LIGATURE'
  | 'LETTER_SPACED'
  | 'TOO_MANY_PAGES'
  | 'TOO_LARGE'

export interface AtsFailure {
  code: AtsFailureCode
  path?: string
  detail: string
}

export interface AtsReport {
  ok: boolean
  failures: AtsFailure[]
}

export interface AtsCheckInput {
  /** The renderable form the renderer typeset (`toRenderableDeep` output), or substituted glyphs read as MISSING_TEXT. */
  content: ResumeContent
  layout: ResumeLayoutOptions
  displayName: string
  email: string
  /** One string per page, line breaks preserved (`extractRenderedPages`). */
  pages: string[]
  pdfBytes: number
}

interface Line {
  page: number
  text: string
}

/** The non-empty, whitespace-normalised lines of every page, in reading order. */
function readLines(pages: string[]): Line[] {
  return pages.flatMap((page, pageIndex) =>
    page
      .split('\n')
      .map(normalise)
      .filter((text) => text !== '')
      .map((text) => ({ page: pageIndex, text })),
  )
}

/** Lines as one text, so a string wrapped over several lines still matches. */
function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text).join(' ')
}

function normalise(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Token characters, as in `mentionsSkill` (`@crm/shared`): `C` is not in `C#`, `Go` is not in `Google`. */
const TOKEN_CHAR = '[\\p{L}\\p{N}#+]'

/**
 * Where `needle` (already normalised, non-empty) occurs as whole tokens in
 * `haystack` at or after `from`; null when it does not. A trailing `.` or `,`
 * is not a token character, so `Node.js.` still contains `Node.js`.
 */
function findToken(haystack: string, needle: string, from: number): { end: number } | null {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?<!${TOKEN_CHAR})${escaped}(?!${TOKEN_CHAR})`, 'gu')
  pattern.lastIndex = from
  const match = pattern.exec(haystack)
  return match && { end: match.index + needle.length }
}

/** `value` occurs as whole tokens in `haystack`; an empty one trivially does (it prints nothing). */
function occurs(haystack: string, value: string): boolean {
  const text = normalise(value)
  return text === '' || findToken(haystack, text, 0) !== null
}

/** Mirrors `section-body` in the skeleton: a section with nothing to print has no heading. */
function hasBody(key: ResumeSectionKey, content: ResumeContent): boolean {
  return key === 'summary' ? content.summary.trim() !== '' : content[key].length > 0
}

/** Every string the skeleton prints for a section, with its content path. */
function renderedStrings(key: ResumeSectionKey, content: ResumeContent): Array<[string, string]> {
  switch (key) {
    case 'summary':
      return [['summary', content.summary]]
    case 'skills':
      return content.skills.map((skill, i) => [`skills[${i}]`, skill])
    case 'experience':
      return content.experience.flatMap((item, i) => [
        [`experience[${i}].role`, item.role] as [string, string],
        [`experience[${i}].company`, item.company],
        [`experience[${i}].period`, item.period],
        ...item.bullets.map((bullet, b): [string, string] => [
          `experience[${i}].bullets[${b}]`,
          bullet,
        ]),
      ])
    case 'education':
      return content.education.flatMap((item, i) => [
        [`education[${i}].institution`, item.institution] as [string, string],
        [`education[${i}].degree`, item.degree],
        [`education[${i}].period`, item.period],
      ])
    case 'languages':
      return content.languages.map((lang, i) => [`languages[${i}]`, `${lang.name} — ${lang.level}`])
    case 'links':
      return content.links.map((link, i) => [`links[${i}].label`, link.label])
  }
}

export function checkResumeAts(input: AtsCheckInput): AtsReport {
  const failures: AtsFailure[] = []
  const layout = normalizeResumeLayout(input.layout)
  const hidden = new Set(layout.hiddenSections)
  const visible = layout.sectionOrder.filter(
    (key) => !hidden.has(key) && hasBody(key, input.content),
  )

  const lines = readLines(input.pages)
  const text = (from: number, to: number): string => joinLines(lines.slice(from, to))

  /*
   * Locate each heading in the effective order. Its title line is the first one
   * after the previous heading whose gap already holds every string of the
   * previous section, so a body line equal to a title (a skill "Links") is not
   * taken for that heading. Out of order, the first such line anywhere, so the
   * order check still sees it.
   */
  const located = new Map<ResumeSectionKey, number>()
  let previous: { index: number; key?: ResumeSectionKey } = { index: -1 }
  for (const key of visible) {
    const title = SECTION_TITLES[key]
    const candidates = lines.flatMap((line, i) =>
      // Stryker disable next-line EqualityOperator: equivalent, the line at `previous.index` is another section's title.
      line.text === title && i > previous.index ? [i] : [],
    )
    const holdsPrevious = (at: number): boolean =>
      previous.key === undefined ||
      renderedStrings(previous.key, input.content).every(([, value]) =>
        occurs(text(previous.index + 1, at), value),
      )
    const inOrder = candidates.find(holdsPrevious) ?? candidates[0]
    if (inOrder !== undefined) {
      located.set(key, inOrder)
      previous = { index: inOrder, key }
      continue
    }
    const anywhere = lines.findIndex((line) => line.text === title)
    if (anywhere !== -1) located.set(key, anywhere)
    else
      failures.push({
        code: 'HEADING_MISSING',
        path: key,
        detail: `Heading "${title}" is not alone on a line`,
      })
  }

  // Headings in the effective order.
  const byPosition = [...located].sort(([, a], [, b]) => a - b)
  const expected = visible
    .filter((key) => located.has(key))
    .map((key) => SECTION_TITLES[key])
    .join(', ')
  const actual = byPosition.map(([key]) => SECTION_TITLES[key]).join(', ')
  if (actual !== expected) {
    failures.push({
      code: 'HEADING_ORDER',
      detail: `Headings are "${actual}", expected "${expected}"`,
    })
  }
  // Covers only the heading: the strings of a hidden section are not searched for.
  for (const key of layout.hiddenSections) {
    const title = SECTION_TITLES[key]
    if (lines.some((line) => line.text === title)) {
      failures.push({
        code: 'HIDDEN_SECTION_PRESENT',
        path: key,
        detail: `Hidden section "${title}" is present in the text`,
      })
    }
  }

  /** A section's text: from its heading to the next located one; without a heading, the whole text. */
  const sectionText = (key: ResumeSectionKey): string => {
    const at = located.get(key)
    // Stryker disable next-line ConditionalExpression: equivalent, `slice(NaN)` and `find(index > undefined)` also yield the whole text.
    if (at === undefined) return text(0, lines.length)
    const next = byPosition.find(([, index]) => index > at)?.[1]
    return text(at + 1, next ?? lines.length)
  }

  // Every rendered string occurs, as whole tokens, in its own section.
  for (const key of visible) {
    const body = sectionText(key)
    for (const [path, value] of renderedStrings(key, input.content)) {
      if (!occurs(body, value)) {
        failures.push({
          code: 'MISSING_TEXT',
          path,
          detail: `Not found in the extracted text: "${normalise(value)}"`,
        })
      }
    }
  }

  if (visible.includes('experience')) {
    // An empty period is the completeness check's failure, not this one.
    input.content.experience.forEach(({ period }, i) => {
      if (period !== '' && !PERIOD_PATTERN.test(period)) {
        failures.push({
          code: 'PERIOD_FORMAT',
          path: `experience[${i}].period`,
          detail: `Period "${period}" is not in the "Mar 2021 – May 2023" format`,
        })
      }
    })
    checkExperience(input.content, sectionText('experience'), failures)
  }

  // Name and email in the body of page 1, before the first heading.
  const firstHeading = lines.findIndex((line) => TITLES.has(line.text))
  const contact = lines
    .slice(0, firstHeading === -1 ? lines.length : firstHeading)
    .filter((line) => line.page === 0)
    .map((line) => line.text)
    .join(' ')
  for (const [path, label, value] of [
    ['displayName', 'Name', input.displayName],
    ['email', 'Email', input.email],
  ] as const) {
    // An empty name or email is not printed, and `includes('')` is true.
    if (!contact.includes(normalise(value))) {
      failures.push({
        code: 'CONTACT_NOT_IN_BODY',
        path,
        detail: `${label} is not on page 1 before the first heading`,
      })
    }
  }

  input.pages.forEach((page, i) => {
    if (page.includes('\uFFFD')) {
      failures.push({
        code: 'REPLACEMENT_CHAR',
        path: `pages[${i}]`,
        detail: 'U+FFFD (replacement character) in the text',
      })
    }
    const ligature = LIGATURE.exec(page)?.[0]
    if (ligature) {
      const codePoint = ligature.charCodeAt(0).toString(16).toUpperCase()
      failures.push({
        code: 'LIGATURE',
        path: `pages[${i}]`,
        detail: `Ligature code point U+${codePoint} in the text`,
      })
    }
  })
  for (const line of lines) {
    if (LETTER_SPACED.test(line.text)) {
      failures.push({
        code: 'LETTER_SPACED',
        path: `pages[${line.page}]`,
        detail: `Letter-spaced text: "${line.text}"`,
      })
    }
  }

  if (input.pages.length > ATS_MAX_PAGES) {
    failures.push({
      code: 'TOO_MANY_PAGES',
      detail: `${input.pages.length} pages, the limit is ${ATS_MAX_PAGES}`,
    })
  }
  if (input.pdfBytes > ATS_MAX_BYTES) {
    failures.push({
      code: 'TOO_LARGE',
      detail: `${input.pdfBytes} bytes, the limit is ${ATS_MAX_BYTES}`,
    })
  }

  return { ok: failures.length === 0, failures }
}

/**
 * Inside each experience item, role, company and period precede its bullets,
 * and no two items interleave: the items are read in order through `body` (the
 * Experience section) with one cursor. A string absent from `body` is
 * MISSING_TEXT, not an order failure.
 */
function checkExperience(content: ResumeContent, body: string, failures: AtsFailure[]): void {
  let cursor = 0
  content.experience.forEach((item, i) => {
    /** Where `value` ends when found at or after `from`; `from` when it is not. */
    const find = (from: number, path: string, value: string): number => {
      const text = normalise(value)
      if (text === '' || !occurs(body, text)) return from
      const at = findToken(body, text, from)
      if (at) return at.end
      failures.push({
        code: 'ITEM_ORDER',
        path,
        detail: `Not after the header of its own item: "${text}"`,
      })
      return from
    }

    // The header fields may print in any order (compact puts the period on the role line).
    const headerEnd = Math.max(
      find(cursor, `experience[${i}].role`, item.role),
      find(cursor, `experience[${i}].company`, item.company),
      find(cursor, `experience[${i}].period`, item.period),
    )
    cursor = item.bullets.reduce(
      (next, bullet, b) => find(next, `experience[${i}].bullets[${b}]`, bullet),
      headerEnd,
    )
  })
}
