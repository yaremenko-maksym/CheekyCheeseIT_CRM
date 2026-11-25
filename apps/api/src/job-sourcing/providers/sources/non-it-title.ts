import { classifyRoles } from '../../funnel/role-classifier'
import { ORIGINAL_LIMITS } from '../../normalize/observation'

/**
 * True when the funnel's role classifier calls the title `NON_IT` (an excluded sales, recruiting,
 * HR, finance or legal phrase with no engineering noun). It is the verdict `store/opportunity-roles.ts`
 * acts on; a source applies it at ingestion so such rows never reach the store. Tags are not read for
 * `NON_IT`, so none are passed.
 *
 * The title is classified on its first `ORIGINAL_LIMITS.title` characters: the classifier has
 * quadratic-cost patterns, so an untruncated 1 MB title would run for minutes inside the API process,
 * and the stored title is that same prefix (`observation.ts` cuts it there), so the verdict matches the row.
 */
export function isNonItTitle(title: string): boolean {
  // Stryker disable next-line ArrayDeclaration: classifyRoles decides NON_IT from the title alone (tags are read only after that verdict), so an empty tag list cannot be told apart from any other
  return classifyRoles({ title: title.slice(0, ORIGINAL_LIMITS.title), tags: [] }).kind === 'NON_IT'
}
