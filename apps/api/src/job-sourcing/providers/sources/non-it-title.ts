import { classifyRoles } from '../../funnel/role-classifier'

/**
 * True when the funnel's role classifier calls the title `NON_IT` (an excluded sales, recruiting,
 * HR, finance or legal phrase with no engineering noun). It is the verdict `store/opportunity-roles.ts`
 * acts on; a source applies it at ingestion so such rows never reach the store. Tags are not read for
 * `NON_IT`, so none are passed.
 */
export function isNonItTitle(title: string): boolean {
  // Stryker disable next-line ArrayDeclaration: classifyRoles decides NON_IT from the title alone (tags are read only after that verdict), so an empty tag list cannot be told apart from any other
  return classifyRoles({ title, tags: [] }).kind === 'NON_IT'
}
