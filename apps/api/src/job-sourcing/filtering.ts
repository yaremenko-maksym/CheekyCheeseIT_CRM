import type { JobExclusionDto } from '@crm/shared'
import { companyNamesMatch, normalizeCompanyName, textMatchesKeyword } from '@crm/shared'

/**
 * Exclusion matching — task-job-sourcing-slice1 §3, "главная содержательная
 * часть".
 *
 * Kept PURE and separate from the service so the rules can be tested exhaustively
 * without a database. The service only supplies the inputs (manual rows +
 * project-derived entries) and applies the verdict.
 *
 * The matching itself lives one level down, in `@crm/shared`'s
 * `companyNamesMatch` / `textMatchesKeyword` (shared with the web so the UI can
 * explain a decision with the same rules). This file is the POLICY: which
 * entries exist, and what each kind matches against.
 */

/** The minimum a posting must expose to be judged. */
export interface FilterablePosting {
  companyName: string
  title: string
  /**
   * Where the posting came from. Used to derive extra company spellings from
   * the URL — see `companyAliases` (security-review round 2, MED-3).
   */
  sourceType?: string
  url?: string
}

/**
 * Extra spellings of the posting's company, derived from its URL.
 *
 * Security-review round 2, MED-3: `companyFromDouUrl` existed and was used as a
 * fallback when the title had no company, but it never took part in MATCHING —
 * so a posting whose title said `Ромашка Digital` while its URL said
 * `/companies/epam-systems/` was judged only on the title. The URL slug is
 * assigned by the board, not typed by the advertiser, which makes it the harder
 * of the two to spoof; consulting BOTH strictly widens what the exclusion
 * catches and can never narrow it (an alias only adds match opportunities).
 */
export function companyAliases(posting: FilterablePosting): string[] {
  if (!posting.url) return []
  // DOU is the only source in slice 1; a second source adds its own branch here
  // (kept in the policy layer so provider code stays about fetching/parsing).
  if (posting.sourceType !== undefined && posting.sourceType !== 'DOU_RSS') return []

  const match = /\/companies\/([^/]+)\//.exec(`${posting.url}/`)
  const slug = match?.[1]?.replace(/[-_]+/g, ' ').trim()
  if (!slug || slug.length === 0) return []
  return companyNamesMatch(slug, posting.companyName) ? [] : [slug]
}

/**
 * Project rows a senior's derived exclusions are built from.
 * `archivedAt` is carried but NOT used to skip anything — see below.
 */
export interface SeniorProjectRow {
  name: string
  companyName: string
  archivedAt: Date | null
}

/**
 * Build the DERIVED exclusions for a senior from the projects the CRM already
 * knows about (task §3 "Автозаполнение из того, что CRM уже знает — проекты и
 * клиенты синьора").
 *
 * Two deliberate decisions:
 *
 *  - **Derived, not stored.** These are recomputed on every read. A stored copy
 *    would drift the moment a project is added or a client renamed, and the
 *    drift would be SILENT — the senior would simply start seeing their own
 *    client again. Nothing to forget, nothing to re-sync.
 *
 *  - **Archived projects still exclude.** An engagement that ended last month is
 *    still a company the senior must not be pitched to by us. The asymmetry is
 *    the whole point: a missed opportunity costs a listing, a leak costs the
 *    client relationship. If the senior genuinely wants a former client back,
 *    they say so — it is not a decision to make silently on their behalf.
 */
export function deriveProjectExclusions(
  seniorId: string,
  projects: SeniorProjectRow[],
): JobExclusionDto[] {
  const seen = new Set<string>()
  const derived: JobExclusionDto[] = []

  for (const project of projects) {
    const normalized = normalizeCompanyName(project.companyName)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    derived.push({
      id: null,
      scope: 'SENIOR',
      seniorId,
      kind: 'COMPANY',
      value: project.companyName,
      normalizedValue: normalized,
      origin: 'PROJECT',
      sourceLabel: project.name,
      createdAt: null,
    })
  }

  return derived
}

/**
 * The FIRST exclusion that matches this posting, or `null` when nothing does.
 *
 * Returning the matching entry rather than a boolean is what lets the API log
 * (and the UI show) WHY a posting was hidden — "скрыто: ваш клиент «EPAM»" is
 * debuggable, "0 вакансий" is not.
 *
 * `COMPANY` entries are matched against the posting's company with the full
 * normalization pipeline (case / legal form / alphabet / spacing).
 * `KEYWORD` entries are matched against the TITLE and the COMPANY — deliberately
 * NOT the description: a stop-word like `PHP` appears in passing in half the
 * descriptions on the market, and an over-eager filter that empties the feed is
 * just as broken as one that leaks.
 */
export function findMatchingExclusion(
  posting: FilterablePosting,
  exclusions: JobExclusionDto[],
): JobExclusionDto | null {
  // MED-3: the advertiser-typed company AND the board-assigned URL slug.
  const names = [posting.companyName, ...companyAliases(posting)]

  for (const exclusion of exclusions) {
    if (exclusion.kind === 'COMPANY') {
      if (names.some((name) => companyNamesMatch(name, exclusion.value))) return exclusion
      continue
    }
    if (
      textMatchesKeyword(posting.title, exclusion.value) ||
      names.some((name) => textMatchesKeyword(name, exclusion.value))
    ) {
      return exclusion
    }
  }
  return null
}

/** Convenience predicate over `findMatchingExclusion`. */
export function isPostingExcluded(
  posting: FilterablePosting,
  exclusions: JobExclusionDto[],
): boolean {
  return findMatchingExclusion(posting, exclusions) !== null
}
