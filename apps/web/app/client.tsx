import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'
import {
  decidePreloadReload,
  PRELOAD_RELOAD_COUNT_KEY,
  PRELOAD_RELOAD_RESET_MS,
  PRELOAD_RELOAD_TS_KEY,
} from './lib/preload-reload'

// Service Worker регистрируется плагином vite-plugin-pwa автоматически
// через injectRegister: 'script' — плагин генерирует registerSW.js и
// подключает его через <script src="/registerSW.js"> в index.html.
// CSP-safe: проходит `script-src 'self'` без нужды в inline-скрипте или nonce.
// SW активен только в production (devOptions.enabled: false в vite.config.ts).

// После редеплоя новый SW активируется и чистит старый precache.
// Открытая вкладка с устаревшим shell-ом пытается загрузить удалённые lazy-чанки
// → `vite:preloadError`. Обработчик перезагружает страницу (index.html no-cache →
// свежий shell → новые чанки). Логика guard'а (throttle + cap) — в ./lib/preload-reload
// (покрыта unit-тестами); здесь — обвязка вокруг sessionStorage / window.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event: Event) => {
    let state: { last: number; count: number }
    try {
      state = {
        last: Number(sessionStorage.getItem(PRELOAD_RELOAD_TS_KEY) || '0'),
        count: Number(sessionStorage.getItem(PRELOAD_RELOAD_COUNT_KEY) || '0'),
      }
    } catch {
      // sessionStorage недоступен (напр. Safari private mode) — без рабочего
      // guard'а авто-reload пропускаем, чтобы не уйти в бесконечный цикл.
      return
    }

    const now = Date.now()
    const { shouldReload, nextCount } = decidePreloadReload(now, state)
    if (!shouldReload) return

    try {
      sessionStorage.setItem(PRELOAD_RELOAD_COUNT_KEY, String(nextCount))
      sessionStorage.setItem(PRELOAD_RELOAD_TS_KEY, String(now))
    } catch {
      // не смогли записать guard-состояние — не перезагружаемся (иначе цикл).
      return
    }

    event.preventDefault()
    window.location.reload()
  })
}

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

// Успешный маунт: гасим guard через PRELOAD_RELOAD_RESET_MS «тишины». Если страница
// прожила этот интервал без нового vite:preloadError — деплой подхватился, эпизод
// закрыт, и будущий редеплой снова восстановится. Сброс ОТЛОЖЕН намеренно:
// синхронный сброс обнулял бы счётчик на каждом заходе и вернул бы бесконечный цикл
// на реально битом деплое (ошибка прилетает раньше таймера → cap копится и тормозит).
if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(PRELOAD_RELOAD_COUNT_KEY)
      sessionStorage.removeItem(PRELOAD_RELOAD_TS_KEY)
    } catch {
      // sessionStorage недоступен — гасить нечего.
    }
  }, PRELOAD_RELOAD_RESET_MS)
}
