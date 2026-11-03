/**
 * RFC 9309 robots.txt parser, plus the `Crawl-delay` and `Content-Signal` extensions.
 *
 * Pure: text in, rules out. No fetch, no clock, no I/O. `RobotsPolicy` owns the network seam and
 * the fail-closed decisions; this file only answers "what does this text say".
 *
 * Dependency verdict: hand-written. The npm `robots-parser` has no `Content-Signal` support and
 * would need wrapping on top of a second tokenizer for the group/extension data we need anyway; the
 * whole RFC grammar is ~150 lines and is covered here by fixtures, with no new package to pin.
 */

/** RFC 9309 2.5: a crawler parses at least the first 500 kibibytes. */
export const MAX_ROBOTS_BYTES = 500 * 1024

export type SignalValue = 'yes' | 'no' | 'unspecified'

export interface ContentSignals {
  aiTrain: SignalValue
  search: SignalValue
  aiInput: SignalValue
}

export interface RobotsRule {
  allow: boolean
  /** Normalised pattern, `$` anchor included (the specificity length is measured on it). */
  pattern: string
}

interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
  crawlDelays: number[]
  signalPairs: Array<{ key: string; value: string }>
}

export interface ParsedRobots {
  groups: RobotsGroup[]
  /**
   * `Crawl-delay` lines that sit before any User-agent line (Jobgether ships one). Not part of
   * RFC 9309, but the site plainly means it, and honouring it only ever slows us down.
   */
  preambleDelays: number[]
  truncated: boolean
  /** Non-blank, non-comment lines. */
  meaningfulLines: number
  /** Of those, the lines whose directive name this parser knows. */
  recognisedLines: number
}

export interface ResolvedRobots {
  rules: readonly RobotsRule[]
  crawlDelaySeconds: number | null
  signals: ContentSignals
}

const KNOWN = new Set([
  'user-agent',
  'allow',
  'disallow',
  'crawl-delay',
  'content-signal',
  'sitemap',
])
const SIGNAL_FIELDS = { 'ai-train': 'aiTrain', search: 'search', 'ai-input': 'aiInput' } as const
const DELAY = /^\d+(\.\d+)?$/
const LITERAL = /[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=]/
const UNRESERVED = /[A-Za-z0-9\-._~]/
const HEX2 = /^[0-9A-Fa-f]{2}$/
const isLineBreak = (byte: number | undefined) => byte === 0x0a || byte === 0x0d

/** Keep at most MAX_ROBOTS_BYTES; when the cut lands inside a line, drop that half line. */
function capText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= MAX_ROBOTS_BYTES) return { text, truncated: false }
  let kept = bytes.subarray(0, MAX_ROBOTS_BYTES)
  if (!isLineBreak(kept[kept.length - 1]) && !isLineBreak(bytes[MAX_ROBOTS_BYTES])) {
    const lastBreak = Math.max(kept.lastIndexOf(0x0a), kept.lastIndexOf(0x0d))
    kept = kept.subarray(0, lastBreak + 1)
  }
  return { text: kept.toString('utf8'), truncated: true }
}

/**
 * Put a rule pattern or a request path in the one form both sides are compared in: an escaped
 * unreserved character is decoded, every other escape gets upper-case hex, and anything outside
 * ASCII or outside the URI character set is escaped as UTF-8 (RFC 9309 2.2.2). A malformed `%`
 * stays literal on both sides, so it still compares equal to itself.
 */
function normalise(input: string): string {
  let out = ''
  for (let i = 0; i < input.length;) {
    const ch = input[i] as string
    if (ch === '%' && HEX2.test(input.slice(i + 1, i + 3))) {
      const hex = input.slice(i + 1, i + 3)
      const decoded = String.fromCharCode(parseInt(hex, 16))
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`
      i += 3
      continue
    }
    const point = input.codePointAt(i) as number
    const char = String.fromCodePoint(point)
    if (LITERAL.test(char) || char === '%') {
      out += char
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
    i += char.length
  }
  return out
}

export function parseRobots(raw: string): ParsedRobots {
  const { text, truncated } = capText(raw)
  const groups: RobotsGroup[] = []
  const preambleDelays: number[] = []
  let current: RobotsGroup | null = null
  // True while the last directive was a User-agent line: the next one joins the same group.
  let collectingAgents = false
  let meaningfulLines = 0
  let recognisedLines = 0

  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#')
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim()
    if (line === '') continue
    meaningfulLines += 1

    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!KNOWN.has(name)) continue
    recognisedLines += 1

    if (name === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [], crawlDelays: [], signalPairs: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      collectingAgents = true
      continue
    }
    if (name === 'sitemap') continue
    if (current === null) {
      if (name === 'crawl-delay' && DELAY.test(value)) preambleDelays.push(Number(value))
      continue
    }
    collectingAgents = false

    if (name === 'allow' || name === 'disallow') {
      if (value !== '') current.rules.push({ allow: name === 'allow', pattern: normalise(value) })
    } else if (name === 'crawl-delay') {
      if (DELAY.test(value)) current.crawlDelays.push(Number(value))
    } else {
      for (const part of value.split(',')) {
        const eq = part.trim().indexOf('=')
        if (eq <= 0) continue
        const pair = part.trim()
        current.signalPairs.push({
          key: pair.slice(0, eq).trim().toLowerCase(),
          value: pair
            .slice(eq + 1)
            .trim()
            .toLowerCase(),
        })
      }
    }
  }
  return { groups, preambleDelays, truncated, meaningfulLines, recognisedLines }
}

function resolveSignals(pairs: ReadonlyArray<{ key: string; value: string }>): ContentSignals {
  const signals: ContentSignals = {
    aiTrain: 'unspecified',
    search: 'unspecified',
    aiInput: 'unspecified',
  }
  for (const [key, field] of Object.entries(SIGNAL_FIELDS)) {
    const own = pairs.filter((p) => p.key === key)
    // A repeated key is ambiguous even when the copies agree: unspecified, never yes.
    const only = own.length === 1 ? (own[0] as { value: string }).value : ''
    if (only === 'yes' || only === 'no') signals[field] = only
  }
  return signals
}

/**
 * RFC 9309 2.2.1: the groups naming our product token are merged; `*` applies only when none does.
 */
export function resolveRobots(parsed: ParsedRobots, productToken: string): ResolvedRobots {
  const token = productToken.toLowerCase()
  const named = parsed.groups.filter((g) => g.agents.includes(token))
  const groups = named.length > 0 ? named : parsed.groups.filter((g) => g.agents.includes('*'))
  const delays = [...parsed.preambleDelays, ...groups.flatMap((g) => g.crawlDelays)]
  return {
    rules: groups.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
    signals: resolveSignals(groups.flatMap((g) => g.signalPairs)),
  }
}

/**
 * Prefix match with `*` (any run) and a trailing `$` (end of path). Linear in the path per
 * fragment: fragments are located left to right, so no backtracking and no regex to blow up on a
 * hostile `*a*a*a…b` pattern.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*')
  const first = parts[0] as string
  if (parts.length === 1) return anchored ? path === first : path.startsWith(first)
  if (!path.startsWith(first)) return false
  let pos = first.length
  for (const part of parts.slice(1, -1)) {
    const at = path.indexOf(part, pos)
    if (at === -1) return false
    pos = at + part.length
  }
  const last = parts[parts.length - 1] as string
  if (anchored) return path.endsWith(last) && path.length - last.length >= pos
  return path.indexOf(last, pos) !== -1
}

/** `pathAndQuery` is `pathname + search`; no fragment. Longest pattern wins, Allow wins a tie. */
export function isPathAllowed(resolved: ResolvedRobots, pathAndQuery: string): boolean {
  const path = normalise(pathAndQuery)
  let best: RobotsRule | null = null
  for (const rule of resolved.rules) {
    if (!matches(rule.pattern, path)) continue
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule
    }
  }
  return best === null || best.allow
}
