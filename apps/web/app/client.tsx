import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { registerSW } from 'virtual:pwa-register'
import { createRouter } from './router'

// Регистрируем Service Worker для кеширования статических ассетов.
// immediate: true — регистрация сразу, не откладывая до load события.
// SW активен только в production (devOptions.enabled: false в vite.config.ts).
registerSW({ immediate: true })

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
