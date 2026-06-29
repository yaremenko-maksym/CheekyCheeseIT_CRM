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
import { shouldReloadOnControllerChange } from './lib/sw-reload'

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

// Форс-перезагрузка открытых вкладок при редеплое (новый SW берёт управление).
//
// VitePWA (autoUpdate + skipWaiting + clientsClaim) устанавливает новый SW в фоне,
// но открытая вкладка продолжает работать на старом JS-бандле в памяти.
// Чтобы пользователь сразу получал свежую версию:
//   1. controllerchange — стреляет когда новый SW становится контроллером страницы.
//      Перезагружаем страницу один раз (guard: только если контроллер уже был).
//   2. registration.update() каждые 60 с — idle-вкладки иначе не узнают о редеплое
//      (браузер проверяет SW только при навигации или раз в 24 ч).
//      update() → браузер скачивает новый SW → skipWaiting+clientsClaim →
//      controllerchange → reload (п.1).
//
// Решение форс-reload принято владельцем осознанно: «больших / длинных форм нет».
// Логика guard'а — в ./lib/sw-reload (покрыта unit-тестами).
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  try {
    const hadControllerAtLoad = navigator.serviceWorker.controller !== null
    let alreadyReloading = false

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (shouldReloadOnControllerChange({ hadControllerAtLoad, alreadyReloading })) {
        alreadyReloading = true
        window.location.reload()
      }
    })

    // Периодический poll чтобы idle-вкладки замечали редеплой.
    navigator.serviceWorker.ready
      .then((registration) => {
        setInterval(
          () => {
            registration.update().catch(() => {
              // update() может упасть в offline — игнорируем.
            })
          },
          60 * 1000, // 60 секунд
        )
      })
      .catch(() => {
        // serviceWorker.ready отклоняется только при аномальных состояниях браузера.
      })
  } catch {
    // Safari private mode и некоторые браузеры выбрасывают SecurityError при
    // обращении к serviceWorker — молча пропускаем, чтобы не ломать загрузку.
  }
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
