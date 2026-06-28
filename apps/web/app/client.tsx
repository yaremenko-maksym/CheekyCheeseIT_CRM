import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'

// Service Worker регистрируется плагином vite-plugin-pwa автоматически
// через injectRegister: 'script' — плагин генерирует registerSW.js и
// подключает его через <script src="/registerSW.js"> в index.html.
// CSP-safe: проходит `script-src 'self'` без нужды в inline-скрипте или nonce.
// SW активен только в production (devOptions.enabled: false в vite.config.ts).

// После редеплоя новый SW активируется и чистит старый precache.
// Открытая вкладка с устаревшим shell-ом пытается загрузить удалённые lazy-чанки
// → `vite:preloadError`. Обработчик перезагружает страницу (index.html no-cache →
// свежий shell → новые чанки). Guard предотвращает бесконечный цикл если чанк
// реально отсутствует (перезагрузка не чаще раза в 10 секунд).
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event: Event) => {
    const KEY = 'vite-preload-reload-ts'
    const last = Number(sessionStorage.getItem(KEY) || '0')
    // Перезагружаемся максимум раз в ~10 сек: снимаем stale-deploy, но не зацикливаемся
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem(KEY, String(Date.now()))
      event.preventDefault()
      window.location.reload()
    }
  })
}

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
