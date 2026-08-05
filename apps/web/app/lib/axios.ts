import axios from 'axios'
import { getUserFacingErrorMessage, stripQueryString } from './axios-utils'

// Dot access — hotfix (task-telemetry-env-gate): `import.meta.env['VITE_API_URL']`
// (bracket) is NOT statically foldable by Vite's build-time replacement, so
// it was always `undefined` in prod bundles. Harmless here only by
// coincidence — `'/api'` IS the correct same-origin prod fallback — but a
// real `VITE_API_URL` build override was being silently ignored.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.location.href = '/login'
    }

    // task fix/api-error-messages: fix the honest-message problem HERE,
    // once, instead of at every one of the dozens of `toast.error(...
    // ${e.message})` / `err.message` call sites across the app (they all
    // read this same rejected error's `.message`) — see axios-utils.ts's
    // `getUserFacingErrorMessage` doc for the priority order. The raw
    // technical detail (status, method, url, axios's own message) is never
    // useful to the end user, but IS useful to a developer — it goes to the
    // console (local-only, never transmitted anywhere) here, never to the
    // UI. Query string stripped — same MED-2 policy as telemetry (see
    // `stripQueryString` doc): a query string can carry PII just like a
    // response body can, and path + method + status is enough to debug.
    console.error(
      '[api]',
      error.config?.method?.toUpperCase?.() ?? '?',
      stripQueryString(error.config?.url),
      '→',
      error.response?.status ?? '(no response)',
      '—',
      error.message,
    )

    // security-review round 2, HIGH-1 (repro-confirmed on axios 1.17.0):
    // `Error.prototype.stack` is materialized LAZILY by V8 — the header
    // line ("AxiosError: <message>") is built from whatever `.message`
    // holds at the moment something FIRST reads `.stack`, not at throw
    // time. Axios's own `Axios.prototype.request` reads `.stack` (to
    // append call-site frames) AFTER this interceptor's rejected handler
    // runs, so if we mutate `.message` first, that later read freezes the
    // header with OUR (possibly backend-echoed, e.g. containing an email)
    // text — permanently, since the string is cached after first access.
    // Reading `.stack` ourselves HERE — before the mutation — forces V8 to
    // materialize it now, while `.message` still holds axios's own safe,
    // generic text ("Request failed with status code 409"); every later
    // reader (axios internals, our own telemetry) sees that frozen-safe
    // header, no matter what `.message` becomes afterwards. Verified via a
    // repro against the real installed axios (custom `adapter` + real
    // `settle()`, not a hand-built error) — see axios.repro.spec.ts.
    void error.stack
    error.message = getUserFacingErrorMessage(error)

    return Promise.reject(error)
  },
)
