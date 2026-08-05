import axios from 'axios'
import { getUserFacingErrorMessage } from './axios-utils'

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
    // console (local-only) here, never to the UI.
    console.error(
      '[api]',
      error.config?.method?.toUpperCase?.() ?? '?',
      error.config?.url ?? '?',
      '→',
      error.response?.status ?? '(no response)',
      '—',
      error.message,
    )
    error.message = getUserFacingErrorMessage(error)

    return Promise.reject(error)
  },
)
