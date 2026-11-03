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
  agents: Set<string>
  rules: RobotsRule[]
  crawlDelays: number[]
  /** Content-Signal key -> value; `null` once the key has been given more than once. */
  signals: Map<string, string | null>
}

/** Record a Content-Signal pair; a second mention of a key, whatever it says, voids it. */
const noteSignal = (into: Map<string, string | null>, key: string, value: string | null) =>
  into.set(key, into.has(key) ? null : value)

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
// URI characters kept as written. A bare `%` is here too: a malformed escape stays literal.
const LITERAL = /[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]/
const UNRESERVED = /[A-Za-z0-9\-._~]/
// Tested on the exact 3-character window `%XY`, so no anchors are needed.
const ESCAPE = /%[0-9A-Fa-f]{2}/

/** Keep at most MAX_ROBOTS_BYTES; when the cut lands inside a line, drop that half line. */
function capText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_ROBOTS_BYTES) return { text, truncated: false }
  let kept = bytes.subarray(0, MAX_ROBOTS_BYTES)
  const next = bytes[MAX_ROBOTS_BYTES]
  // The cut is clean when the next byte starts a line break; otherwise the last line is partial.
  if (next !== 0x0a && next !== 0x0d) {
    kept = kept.subarray(0, Math.max(kept.lastIndexOf(0x0a), kept.lastIndexOf(0x0d)) + 1)
  }
  return { text: kept.toString(), truncated: true }
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
    const window = input.slice(i, i + 3)
    if (ESCAPE.test(window)) {
      const hex = window.slice(1)
      const decoded = String.fromCharCode(parseInt(hex, 16))
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`
      i += 3
      continue
    }
    const char = String.fromCodePoint(input.codePointAt(i) as number)
    if (LITERAL.test(char)) {
      out += char
    } else {
      for (const byte of Buffer.from(char)) {
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
  // The group that receives rules; `open` is it only while the last directive was a User-agent
  // line, so the next User-agent line joins the same group instead of starting another.
  let current: RobotsGroup | null = null
  let open: RobotsGroup | null = null
  let meaningfulLines = 0
  let recognisedLines = 0

  // The regex below holds a literal U+FEFF (byte-order mark); an editor may render it invisibly.
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
      if (open === null) {
        open = { agents: new Set(), rules: [], crawlDelays: [], signals: new Map() }
        groups.push(open)
      }
      open.agents.add(value.toLowerCase())
      current = open
      continue
    }
    if (name === 'sitemap') continue
    open = null

    if (current === null) {
      if (name === 'crawl-delay' && DELAY.test(value)) preambleDelays.push(Number(value))
    } else if (name === 'allow' || name === 'disallow') {
      if (value !== '') current.rules.push({ allow: name === 'allow', pattern: normalise(value) })
    } else if (name === 'crawl-delay') {
      if (DELAY.test(value)) current.crawlDelays.push(Number(value))
    } else {
      for (const part of value.split(',')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        noteSignal(
          current.signals,
          part.slice(0, eq).trim().toLowerCase(),
          part
            .slice(eq + 1)
            .trim()
            .toLowerCase(),
        )
      }
    }
  }
  return { groups, preambleDelays, truncated, meaningfulLines, recognisedLines }
}

function resolveSignals(merged: ReadonlyMap<string, string | null>): ContentSignals {
  const signals: ContentSignals = {
    aiTrain: 'unspecified',
    search: 'unspecified',
    aiInput: 'unspecified',
  }
  for (const [key, field] of Object.entries(SIGNAL_FIELDS)) {
    const value = merged.get(key)
    if (value === 'yes' || value === 'no') signals[field] = value
  }
  return signals
}

/**
 * RFC 9309 2.2.1: the groups naming our product token are merged; `*` applies only when none does.
 */
export function resolveRobots(parsed: ParsedRobots, productToken: string): ResolvedRobots {
  const token = productToken.toLowerCase()
  const named = parsed.groups.filter((g) => g.agents.has(token))
  const groups = named.length > 0 ? named : parsed.groups.filter((g) => g.agents.has('*'))
  const delays = [...parsed.preambleDelays, ...groups.flatMap((g) => g.crawlDelays)]
  const signals = new Map<string, string | null>()
  for (const group of groups) {
    for (const [key, value] of group.signals) noteSignal(signals, key, value)
  }
  return {
    rules: groups.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
    signals: resolveSignals(signals),
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
