/**
 * The bookmarklet itself: bundled at build time into one `javascript:` URL (see
 * `vite-bookmarklet.ts`) and run on whatever page the HR has open. `__CRM_ORIGIN__` is replaced
 * with the CRM's origin when the install dialog hands the script out.
 */
import { crmTarget } from './target'

const ORIGIN = '__CRM_ORIGIN__'

try {
  // Stryker disable next-line StringLiteral: any fallback shorter than SELECTION_MIN is ignored
  const selection = window.getSelection()?.toString() ?? ''
  window.open(
    crmTarget(ORIGIN, document, location.href, selection),
    '_blank',
    'noopener,noreferrer',
  )
} catch (error) {
  // Never fail silently on an odd page: say what broke and what still works. Lingui cannot run on
  // a foreign page, so the message carries both languages itself.
  /* eslint-disable lingui/no-unlocalized-strings -- runs outside the CRM, no catalog there */
  alert(
    `To CRM: could not read this page (${String(error)}). ` +
      'Copy the vacancy text and paste it into the CRM. / ' +
      'Не вдалося прочитати сторінку. Скопіюйте текст вакансії та вставте його в CRM.',
  )
  /* eslint-enable lingui/no-unlocalized-strings */
}
