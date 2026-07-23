import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Renders the official Cloudflare Turnstile widget into `containerRef` and
 * exposes the resulting token (task-landing-redesign.md §Скоуп item 6).
 *
 * The `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">`
 * is injected lazily by THIS hook, not loaded eagerly from `index.html`
 * (task-landing-seo-prerender.md §3 "defer всего некритичного") — Turnstile
 * is only ever used on `/careers/:slug` (VacancyApplyForm, the hook's one
 * caller), so a global static tag cost every page (`/`, `/careers` included)
 * a ~24 KB script fetch + a widget-iframe round trip they never use.
 *
 * On `/careers/:slug` itself the form sits below the fold on mobile (single-
 * column layout, form renders after the full markdown body — see
 * `VacancyDetailContent`), so loading is further deferred with an
 * `IntersectionObserver` on `containerRef`: the script/widget only start
 * fetching once the form is close to entering the viewport (`rootMargin:
 * '200px'`, i.e. before the user actually scrolls to it — no visible pop-in),
 * instead of competing with the LCP-critical content for bandwidth/CPU on
 * mount. Falls back to loading immediately if `IntersectionObserver` isn't
 * available.
 *
 * Dev/CI default is Cloudflare's documented "always passes" test site key
 * (same convention as `apps/api` TurnstileService's dev dummy secret) — see
 * `apps/landing/.env.example`.
 */
interface TurnstileRenderOptions {
  sitekey: string
  theme?: 'light' | 'dark' | 'auto'
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: () => void
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
  remove: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const DEV_DUMMY_SITE_KEY = '1x00000000000000000000AA'
const SITE_KEY = import.meta.env['VITE_TURNSTILE_SITE_KEY'] ?? DEV_DUMMY_SITE_KEY
const POLL_INTERVAL_MS = 100
const POLL_TIMEOUT_MS = 15_000
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

/**
 * Idempotent — a route can mount/unmount `VacancyApplyForm` (client-side nav
 * back and forth); only ever append the tag once.
 * No `integrity=` on purpose, matching the previous static `index.html` tag:
 * Cloudflare serves this from a rotating CDN and documents that it must NOT
 * be pinned via SRI (content changes without notice as CF updates challenge
 * logic) — https://developers.cloudflare.com/turnstile/troubleshooting/faqs/.
 */
function loadTurnstileScript(): void {
  if (document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)) return
  const script = document.createElement('script')
  script.src = TURNSTILE_SCRIPT_SRC
  script.async = true
  script.defer = true
  document.head.appendChild(script)
}

export interface UseTurnstileResult {
  /** Attach to the `<div>` the widget renders into. */
  containerRef: RefObject<HTMLDivElement>
  /** `null` until the widget completes (or after `reset()`/expiry). */
  token: string | null
  /** Re-runs the challenge — Turnstile tokens are single-use, call after a failed submit. */
  reset: () => void
}

export function useTurnstile(): UseTurnstileResult {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        theme: 'dark',
        callback: (t) => {
          if (!cancelled) setToken(t)
        },
        'expired-callback': () => {
          if (!cancelled) setToken(null)
        },
        'error-callback': () => {
          if (!cancelled) setToken(null)
        },
      })
    }

    const start = () => {
      if (window.turnstile) {
        render()
        return
      }
      loadTurnstileScript()
      pollTimer = setInterval(() => {
        if (window.turnstile) {
          if (pollTimer) clearInterval(pollTimer)
          render()
        }
      }, POLL_INTERVAL_MS)
      timeoutTimer = setTimeout(() => {
        if (pollTimer) clearInterval(pollTimer)
      }, POLL_TIMEOUT_MS)
    }

    let observer: IntersectionObserver | undefined
    if (containerRef.current && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          start()
        },
        { rootMargin: '200px' },
      )
      observer.observe(containerRef.current)
    } else {
      start()
    }

    return () => {
      cancelled = true
      observer?.disconnect()
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
    }
  }, [])

  const reset = () => {
    setToken(null)
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
    }
  }

  return { containerRef, token, reset }
}
