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
  for (const exclusion of exclusions) {
    if (exclusion.kind === 'COMPANY') {
      if (companyNamesMatch(posting.companyName, exclusion.value)) return exclusion
      continue
    }
    if (
      textMatchesKeyword(posting.title, exclusion.value) ||
      textMatchesKeyword(posting.companyName, exclusion.value)
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
