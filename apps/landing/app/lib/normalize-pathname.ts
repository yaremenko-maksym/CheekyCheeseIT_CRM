/**
 * `client.tsx` calls this ONCE, synchronously, before `createRouter()` reads
 * `window.location` for its first match. Root cause this defends against
 * (confirmed against a real failing PR #398 CI run, not speculative): a
 * prerendered page is a full React SPA — the SAME client-side
 * `router.tsx` (`trailingSlash: 'always'`) re-executes on top of the static
 * markup and matches routes against `window.location.pathname`. That
 * pathname is only ever the PRETTY form (`/`, `/careers/`, ...) when nginx's
 * `try_files $uri $uri/ /index.html` (see router.tsx's own comment) served
 * the request — the browser's address bar, and therefore
 * `window.location.pathname`, still shows the pretty URL the visitor typed
 * or a `<Link>` navigated to, even though nginx served the FILE at
 * `<route>/index.html` under the hood.
 *
 * Some tools/hosts instead address the file by its LITERAL on-disk path —
 * Lighthouse CI's `staticDistDir` auto-discovery is a confirmed example
 * (its own static server is asked for `/index.html` / `/careers/index.html`
 * directly, not `/` / `/careers/`; verified via a downloaded CI artifact's
 * `network-requests` audit + `manifest.json` URL list). With
 * `trailingSlash: 'always'`, NEITHER of those literal paths matches any
 * registered route, so the client-side router (correctly, from its own
 * narrow perspective) rendered `notFoundComponent` — overwriting the
 * perfectly correct prerendered content with a `noindex` 404 page the
 * instant the client-side app took over. `waitForDocumentHeadSettled` +
 * `captureRoute`'s retry-with-fresh-page (`scripts/prerender.mjs`) could
 * never have caught this: the STATIC FILE was always right; the tool
 * re-executing our OWN client JS against a differently-shaped URL is what
 * produced the wrong final DOM.
 *
 * @param pathname - `window.location.pathname`
 * @param search - `window.location.search`
 * @param hash - `window.location.hash`
 * @returns the pretty-form URL to `history.replaceState()` to, or `null`
 *   if `pathname` was already in its canonical (non-`index.html`) form.
 */
export function normalizeIndexHtmlUrl(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  if (!pathname.endsWith('/index.html')) return null
  const prettyPathname = pathname.slice(0, -'index.html'.length) || '/'
  return `${prettyPathname}${search}${hash}`
}
