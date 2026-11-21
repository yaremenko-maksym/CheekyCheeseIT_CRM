/**
 * S3 keys of tailored resume PDFs (tailored-resume D14). Every object of a row lives under its own
 * prefix, so a run's PDF and an edit re-render's PDF never share a key: a late write of an older
 * run or render can never overwrite a newer object.
 */
export const TAILORED_RESUMES_PREFIX = 'tailored-resumes/'

/** The only shapes the orphan sweep may delete under the prefix; anything else there is not ours. */
const TAILORED_PDF_KEY = /^tailored-resumes\/[^/]+\/(run|edit)-[^/]+\.pdf$/

export const tailoredPrefix = (rowId: string): string => `${TAILORED_RESUMES_PREFIX}${rowId}/`

/** The PDF a generation run uploads before it publishes. */
export const runPdfKey = (rowId: string, runId: string): string =>
  `${tailoredPrefix(rowId)}run-${runId}.pdf`

/** The PDF an HR edit re-render uploads. */
export const editPdfKey = (rowId: string, renderId: string): string =>
  `${tailoredPrefix(rowId)}edit-${renderId}.pdf`

export const isTailoredPdfKey = (key: string): boolean => TAILORED_PDF_KEY.test(key)
