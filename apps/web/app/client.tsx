import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'

// Service Worker регистрируется плагином vite-plugin-pwa автоматически
// через injectRegister: 'inline' — скрипт инжектируется в index.html.
// SW активен только в production (devOptions.enabled: false в vite.config.ts).

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
