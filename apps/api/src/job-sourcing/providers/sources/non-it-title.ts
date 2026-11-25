import { classifyRoles } from '../../funnel/role-classifier'
import { cleanLine, DISPLAY_TITLE_CHARS } from '../../normalize/build-posting'

/**
 * True when the funnel's role classifier calls the title `NON_IT` (an excluded sales, recruiting,
 * HR, finance or legal phrase with no engineering noun). It is the verdict `store/opportunity-roles.ts`
 * acts on; a source applies it at ingestion so such rows never reach the store. Tags are not read for
 * `NON_IT`, so none are passed.
 *
 * The title is classified exactly as the funnel receives it: the normalized display title,
 * `cleanLine(title, DISPLAY_TITLE_CHARS)` (NUL and bidi marks stripped, trimmed, then cut at 500
 * characters), which `buildNormalizedPosting` stores and `deriveOpportunityRoles` classifies. So the
 * verdict matches the row's, and a 1 MB title costs one linear pass instead of a classifier run over it.
 */
export function isNonItTitle(title: string): boolean {
  // Stryker disable next-line ArrayDeclaration: classifyRoles decides NON_IT from the title alone (tags are read only after that verdict), so an empty tag list cannot be told apart from any other
  return classifyRoles({ title: cleanLine(title, DISPLAY_TITLE_CHARS), tags: [] }).kind === 'NON_IT'
}
