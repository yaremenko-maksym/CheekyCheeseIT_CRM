/**
 * Reads extracted resume text back into the fields an ATS parser cares about,
 * for the cross-template equivalence check (spec §7, A3).
 *
 * It knows only the skeleton's printing rules, not any template: headings are
 * the fixed titles alone on a line; an experience item is its header lines
 * (role, company, period; `compact` puts the period at the end of the role
 * line) followed by bullet lines; skills are joined by `·` or one per line.
 */
import { PERIOD_PATTERN } from '../resume-ats-checker'

export interface ParsedItem {
  role: string
  company: string
  period: string
}

export interface ParsedResume {
  headings: string[]
  items: ParsedItem[]
  skills: string[]
}

const TITLES = new Set(['Summary', 'Experience', 'Skills', 'Education', 'Languages', 'Links'])
const BULLET = /^[•‣–-] /u
/** The period pattern, anchored at the end of a line instead of the start. */
const TRAILING_PERIOD = new RegExp(` (${PERIOD_PATTERN.source.slice(1, -1)})$`, 'u')

export function parseExtracted(pages: string[]): ParsedResume {
  const lines = pages
    .flatMap((page) => page.split('\n'))
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line !== '')

  const headings: string[] = []
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of lines) {
    if (TITLES.has(line)) {
      headings.push(line)
      current = []
      sections.set(line, current)
    } else current?.push(line)
  }

  return {
    headings,
    items: parseExperience(sections.get('Experience') ?? []),
    skills: parseSkills(sections.get('Skills') ?? []),
  }
}

/** Consecutive non-bullet lines form one item header; bullets end it. */
function parseExperience(lines: string[]): ParsedItem[] {
  const headers: string[][] = []
  let header: string[] | null = null
  for (const line of lines) {
    if (BULLET.test(line)) header = null
    else if (header) header.push(line)
    else headers.push((header = [line]))
  }
  return headers.map(parseHeader)
}

function parseHeader(lines: string[]): ParsedItem {
  // Period on the role line: everything up to it is the role, the rest the company.
  const onRole = lines.findIndex((line) => TRAILING_PERIOD.test(line))
  if (onRole !== -1) {
    const match = TRAILING_PERIOD.exec(lines[onRole]!)!
    const roleLines = [...lines.slice(0, onRole), lines[onRole]!.slice(0, match.index)]
    return {
      role: roleLines.join(' '),
      company: lines.slice(onRole + 1).join(' '),
      period: match[1]!,
    }
  }
  // Role, company and period each on their own line.
  if (lines.length !== 3 || !PERIOD_PATTERN.test(lines[2]!)) {
    throw new Error(`Cannot read an item header from ${JSON.stringify(lines)}`)
  }
  return { role: lines[0]!, company: lines[1]!, period: lines[2]! }
}

/** `A · B · C`, possibly wrapped, or one skill per line. */
function parseSkills(lines: string[]): string[] {
  if (!lines.some((line) => line.includes('·'))) return lines
  return lines
    .join(' ')
    .split('·')
    .map((skill) => skill.trim())
    .filter((skill) => skill !== '')
}
