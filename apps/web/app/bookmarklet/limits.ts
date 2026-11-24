/**
 * Field caps the bookmarklet applies before it hands a page to the CRM. They mirror the shared
 * schema caps, but are copied here on purpose: the bookmarklet bundle runs on a foreign page and
 * must not pull zod in. `limits.test.ts` fails the moment the two drift apart.
 */
export const TITLE_MAX = 500
export const COMPANY_MAX = 255
export const DESCRIPTION_MAX = 50000
export const PAGE_TEXT_MAX = 15000
/** Encoded `#external=` payload ceiling, the same number the CRM refuses above. */
export const HASH_MAX = 32000
