import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'

// Service Worker регистрируется плагином vite-plugin-pwa автоматически
// через injectRegister: 'script' — плагин генерирует registerSW.js и
// подключает его через <script src="/registerSW.js"> в index.html.
// CSP-safe: проходит `script-src 'self'` без нужды в inline-скрипте или nonce.
// SW активен только в production (devOptions.enabled: false в vite.config.ts).

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
