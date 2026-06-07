import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  server: {
    port: 3000,
    // host: true слушает на 0.0.0.0 — нужно чтобы внешний tunnel мог проксировать.
    // allowedHosts ограничен только serveo.net (выбранный provider после провалов
    // LocalTunnel/Cloudflare/ngrok в нашей сети). Если потребуется другой provider —
    // добавить отдельной записью. Vite по умолчанию режет non-localhost Host header
    // как "Blocked request".
    host: true,
    allowedHosts: ['.serveousercontent.com', '.serveo.net'],
    // Прокси для /api → NestJS на 3001 в dev-режиме. Идентичен preview.proxy:
    // фронт ходит на свой origin (http://localhost:3000/api/...), Vite перенаправляет
    // на API. Без этого Dev login и любые api.* запросы из браузера падают
    // на SPA fallback (Vite отдаёт index.html на неизвестные пути).
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3000,
    // То же что для server — слушать 0.0.0.0 + пропускать serveo туннель.
    host: true,
    allowedHosts: ['.serveousercontent.com', '.serveo.net'],
    // Прокси для /api → NestJS на 3001. Когда фронт собран в production-режиме
    // и отдаётся через `vite preview`, браузер делает запросы к /api/...
    // относительно своего origin'а (включая tunnel URL). Этот прокси
    // переадресует их на локальный API. Без прокси через tunnel API недостижим.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@crm/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Стратегия: дробим 2.53 MB vendor bundle на тематические чанки.
        // Порядок if-веток критичен — от специфичного к общему.
        // scheduler/react-is/prop-types — peer-deps react-dom, включены в
        // vendor-react чтобы устранить "Circular chunk" предупреждение Rollup.
        // VitePWA читает этот output объект через configResolved, но manualChunks
        // как функция применяется корректно (проверено debug-build).
        manualChunks: (id: string): string | undefined => {
          // ── React ядро + peer-зависимости ──────────────────────────────
          // scheduler, react-is, prop-types неотделимы от react-dom — без них
          // возникает "Circular chunk: vendor-misc -> vendor-react -> vendor-misc"
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/') ||
            id.includes('node_modules/react-is/') ||
            id.includes('node_modules/prop-types/')
          ) {
            return 'vendor-react'
          }

          // ── TanStack экосистема ─────────────────────────────────────────
          // router / query / form / virtual обновляются вместе → один чанк
          if (id.includes('node_modules/@tanstack/')) {
            return 'vendor-tanstack'
          }

          // ── Drag-and-drop ───────────────────────────────────────────────
          if (id.includes('node_modules/@dnd-kit/')) {
            return 'vendor-dnd'
          }

          // ── Анимации ────────────────────────────────────────────────────
          if (id.includes('node_modules/framer-motion/')) {
            return 'vendor-motion'
          }

          // ── Графики (recharts + d3-* субзависимости) ────────────────────
          if (
            id.includes('node_modules/recharts/') ||
            id.includes('node_modules/d3-') ||
            id.includes('node_modules/victory-vendor/')
          ) {
            return 'vendor-charts'
          }

          // ── CodeMirror редактор ─────────────────────────────────────────
          // Используется только в documents/onboarding — хорошо изолируется
          if (
            id.includes('node_modules/@codemirror/') ||
            id.includes('node_modules/@uiw/react-codemirror') ||
            id.includes('node_modules/@uiw/codemirror') ||
            id.includes('node_modules/codemirror/')
          ) {
            return 'vendor-codemirror'
          }

          // ── Тяжёлые утилиты ─────────────────────────────────────────────
          // libphonenumber-js ~600 KB, react-signature-canvas, react-easy-crop
          if (
            id.includes('node_modules/libphonenumber-js/') ||
            id.includes('node_modules/react-phone-number-input/') ||
            id.includes('node_modules/react-signature-canvas/') ||
            id.includes('node_modules/react-easy-crop/')
          ) {
            return 'vendor-heavy-utils'
          }

          // ── Radix UI примитивы ──────────────────────────────────────────
          if (id.includes('node_modules/@radix-ui/')) {
            return 'vendor-radix'
          }

          // ── Иконки (lucide) ─────────────────────────────────────────────
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons'
          }

          // ── Markdown / diff / unified-экосистема ────────────────────────
          if (
            id.includes('node_modules/react-markdown/') ||
            id.includes('node_modules/diff/') ||
            id.includes('node_modules/remark') ||
            id.includes('node_modules/rehype') ||
            id.includes('node_modules/unified/') ||
            id.includes('node_modules/micromark') ||
            id.includes('node_modules/mdast') ||
            id.includes('node_modules/hast') ||
            id.includes('node_modules/vfile') ||
            id.includes('node_modules/unist')
          ) {
            return 'vendor-markdown'
          }

          // ── Прочие node_modules → общий vendor ──────────────────────────
          // axios, zod, date-fns, sonner, clsx, tailwind-merge, cmdk,
          // react-day-picker, class-variance-authority, tw-animate-css и т. п.
          if (id.includes('node_modules/')) {
            return 'vendor-misc'
          }

          // App-код — Rollup разобьёт по точкам входа (TanStack route chunks)
          return undefined
        },
      },
    },
  },
  plugins: [
    TanStackRouterVite({
      routesDirectory: './app/routes',
      generatedRouteTree: './app/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
    VitePWA({
      // autoUpdate: SW обновляется автоматически в фоне без промпта
      registerType: 'autoUpdate',

      // script: плагин генерирует отдельный registerSW.js и подключает его
      // через <script src="/registerSW.js"> в index.html.
      // Проходит prod-CSP `script-src 'self'` без inline — no nonce required.
      // Не использует virtual:pwa-register — избегает проблем с Rollup resolver
      // в pnpm workspace (zod не hoisted в root node_modules).
      injectRegister: 'script',

      // SW отключён в dev — избегаем stale-кеша при разработке
      devOptions: { enabled: false },

      // Существующий webmanifest в public/ уже содержит все нужные поля.
      // manifest: false — плагин НЕ генерирует дубль манифеста.
      manifest: false,

      workbox: {
        // После code-split крупнейший чанк < 2 MiB.
        // Снижаем с 5 MiB до 2 MiB — соответствует новому максимуму.
        // Дефолт workbox = 2 MiB; явно указываем для документирования намерения.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,

        // Precache только статические ассеты фронта (хешированные имена — immutable)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],

        // SPA fallback: все навигационные запросы → index.html,
        // TanStack Router разруливает маршруты на клиенте
        navigateFallback: '/index.html',

        // НЕ перехватывать /api/* — auth/данные нельзя кешировать навигационно
        navigateFallbackDenylist: [/^\/api\//],

        // Удалять устаревшие кеши при обновлении SW
        cleanupOutdatedCaches: true,

        // SW немедленно берёт управление над всеми клиентами
        clientsClaim: true,

        // Новый SW активируется без ожидания закрытия вкладок
        skipWaiting: true,

        runtimeCaching: [
          {
            // S3-медиа (изображения + PDF): CacheFirst + нормализация ключа.
            // S3-объекты иммутабельны — presigned URL меняется при каждом запросе,
            // но контент по одному и тому же origin+pathname всегда одинаков.
            // Кешируем по origin+pathname, игнорируя presigned query-параметры (X-Amz-*, Expires…).
            //
            // PDF fetch (documents-pdf-preview task):
            //   Добавлен матч для кросс-origin GET-запросов с .pdf в pathname ИЛИ
            //   любого кросс-origin-запроса без /api/ в pathname (presigned S3 blob fetch).
            //   Контракты/инвойсы (same-origin /api/*) не матчатся — они уходят
            //   в api-cache где cacheWillUpdate убивает no-store ответы.
            //
            // Prod NOTE: AWS S3 bucket CORS должен разрешать GET с web-origin
            //   (AllowedOrigins: https://yourdomain.com, AllowedMethods: GET).
            //   В dev MinIO уже сконфигурирован (OPTIONS → Access-Control-Allow-Origin).
            urlPattern: ({ url, request }: { url: URL; request: Request }) => {
              // Кросс-origin (не наш frontend)
              if (url.origin === self.location.origin) return false
              // Исключаем /api/ пути (same-origin proxy — не попадут сюда, но на всякий)
              if (url.pathname.startsWith('/api/')) return false
              // Изображения (по destination)
              if (request.destination === 'image') return true
              // PDF fetch — по расширению или Content-Type (presigned S3 blob)
              if (url.pathname.toLowerCase().endsWith('.pdf')) return true
              // Любой кросс-origin GET без расширения — может быть presigned blob
              // (S3 keys не имеют расширения у PDF если загружен без него)
              if (request.method === 'GET' && request.destination === '') return true
              return false
            },
            handler: 'CacheFirst' as const,
            options: {
              cacheName: 'media-cache',
              plugins: [
                {
                  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
                    const u = new URL(request.url)
                    // Срезаем presigned query-параметры S3 (X-Amz-*, Expires, …)
                    return u.origin + u.pathname
                  },
                  // security MED-1: privacy-инвариант держится на КОДЕ, не на топологии
                  // деплоя. Catch-all ветка (destination === '') при будущем split-origin
                  // API (api.domain.com) может поймать контракт/инвойс-blob с no-store.
                  // Уважаем Cache-Control: no-store → не кешируем приватные документы.
                  cacheWillUpdate: async ({ response }: { response: Response }) => {
                    const cc = response.headers.get('cache-control') ?? ''
                    return cc.includes('no-store') ? null : response
                  },
                },
              ],
              expiration: { maxEntries: 200, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // API GET: NetworkFirst — свежее онлайн, кеш как офлайн-фолбэк (АНТИ-STALE).
            // baseURL аксиоса = http://localhost:3001/api (dev) или VITE_API_URL (prod).
            // Матчим по pathname /api/ + порт 3001 для dev; в prod API на том же origin
            // через прокси (/api/*) — pathname-match покрывает оба сценария.
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              url.pathname.startsWith('/api/') && request.method === 'GET',
            handler: 'NetworkFirst' as const,
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 200, maxAgeSeconds: 86400 },
              cacheableResponse: { statuses: [200] },
              plugins: [
                {
                  // security-MED-1: уважаем Cache-Control: no-store от бэкенда.
                  // Workbox по умолчанию игнорирует no-store и кеширует ответ.
                  // Это критично для PDF-эндпоинтов (employee-contracts,
                  // signed-contracts, onboarding-contract) — приватные трудовые
                  // договоры не должны попадать в api-cache даже временно.
                  // Возвращаем null → Workbox пропускает запись в кеш для этого ответа.
                  cacheWillUpdate: async ({ response }: { response: Response }) => {
                    const cc = response.headers.get('cache-control') ?? ''
                    if (cc.includes('no-store')) {
                      return null
                    }
                    return response
                  },
                },
              ],
            },
          },
        ],
      },
    }),
  ],
})
