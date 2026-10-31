/**
 * The reporting (ledger-driven) source types the detector pass scans over: every API type but the
 * legacy DOU feed and the HTML set. Kept in its own module — importing only `@crm/shared`, no schema
 * — so it can be unit-pinned without loading the Drizzle schema graph.
 */
import { jobSourceTypeSchema } from '@crm/shared'

export const REPORTING_TYPES = jobSourceTypeSchema.options.filter(
  (t) => !t.endsWith('_HTML') && t !== 'DOU_RSS',
)
