import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Renders the official Cloudflare Turnstile widget into `containerRef` and
 * exposes the resulting token (task-landing-redesign.md §Скоуп item 6). The
 * `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">` tag
 * lives in `index.html` (loaded once, globally) — this hook only polls for
 * `window.turnstile` to appear (async script) and renders on it.
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

    if (window.turnstile) {
      render()
    } else {
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

    return () => {
      cancelled = true
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
