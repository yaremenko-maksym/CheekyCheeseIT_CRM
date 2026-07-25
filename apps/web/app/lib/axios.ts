import axios from 'axios'

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
    return Promise.reject(error)
  },
)
