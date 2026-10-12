/**
 * Curated tech / skill dictionary used by TechAutocompleteInput.
 * ~500 entries covering programming languages, frameworks, databases, cloud,
 * DevOps tooling, testing frameworks, AI/ML stacks, Web3, design tools,
 * recruiting/HR soft-skills and accounting skills.
 *
 * Stored as a `readonly` tuple so that downstream code can type-narrow values
 * to the literal union `Technology` when needed (and so suggestion lists stay
 * stable across renders).
 *
 * The entries live in ./technologies/*.ts by category; this barrel concatenates
 * them in the original order, so the composed tuple is unchanged.
 */
import { TECHNOLOGIES_LANGUAGES_FRAMEWORKS } from './technologies/languages-frameworks'
import { TECHNOLOGIES_DATA_DEVOPS } from './technologies/data-devops'
import { TECHNOLOGIES_AI_WEB3_DESIGN } from './technologies/ai-web3-design'
import { TECHNOLOGIES_HR_ACCOUNTING_METHODS } from './technologies/hr-accounting-methods'

export const TECHNOLOGIES = [
  ...TECHNOLOGIES_LANGUAGES_FRAMEWORKS,
  ...TECHNOLOGIES_DATA_DEVOPS,
  ...TECHNOLOGIES_AI_WEB3_DESIGN,
  ...TECHNOLOGIES_HR_ACCOUNTING_METHODS,
] as const

export type Technology = (typeof TECHNOLOGIES)[number]
