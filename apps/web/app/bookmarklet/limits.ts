/**
 * Field caps the bookmarklet applies before it hands a page to the CRM. They mirror the shared
 * schema caps, but are copied here on purpose: the bookmarklet bundle runs on a foreign page and
 * must not pull zod in. `limits.test.ts` fails the moment the two drift apart.
 */
export const TITLE_MAX = 500
export const COMPANY_MAX = 255
export const DESCRIPTION_MAX = 50000
export const PAGE_TEXT_MAX = 15000
/** The CRM drops a longer link, and `fitToHash` cannot shorten one. */
export const URL_MAX = 2048
/** Encoded `#external=` payload ceiling, the same number the CRM refuses above. */
export const HASH_MAX = 32000
/** Block map caps (`blocks.ts`): blocks per page, characters per block, per nav/header/footer block. */
export const BLOCKS_MAX = 600
export const BLOCK_TEXT_MAX = 2000
export const CHROME_TEXT_MAX = 80
/** Total block text the CRM accepts in one map; over it the pick request is refused. */
export const BLOCKS_TEXT_MAX = 32000
