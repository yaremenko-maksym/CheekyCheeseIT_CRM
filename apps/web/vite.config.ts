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
        // Разбиваем 2.53 MB vendor bundle на тематические чанки:
        // 1. Ни один чанк не превышает ~1.5 MB → workbox лимит снижен до 2 MiB
        // 2. Браузер кеширует стабильные вендоры отдельно от app-кода
        // 3. Параллельная загрузка нескольких чанков быстрее одного 2.5 MB
        manualChunks(id) {
          // ── React ядро ──────────────────────────────────────────────────
          // react + react-dom изменяются редко → долгий TTL в браузерном кеше
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react'
          }

          // ── TanStack экосистема ─────────────────────────────────────────
          // router / query / form / virtual обновляются вместе → один чанк логичен
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
        // Снижаем с 5 MiB до 2 MiB (2 * 1024 * 1024) — чуть выше нового максимума.
        // Дефолт workbox = 2 MiB, явно указываем для ясности намерения.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,

        // Precache только статические ассеты фронта (хешированные имена — immutable)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],

        // SPA fallback: все навигационные запросы → index.html,
        // TanStack Router разруливает маршруты на клиенте
        navigateFallback: '/index.html',

        // НЕ перехватывать /api/* — auth/данные нельзя кешировать
        navigateFallbackDenylist: [/^\/api\//],

        // Удалять устаревшие кеши при обновлении SW
        cleanupOutdatedCaches: true,

        // SW немедленно берёт управление над всеми клиентами
        clientsClaim: true,

        // Новый SW активируется без ожидания закрытия вкладок
        skipWaiting: true,

        // НЕ добавляем runtimeCaching для /api/* или S3 presigned-URL:
        // - /api/* содержит приватные auth/данные — кешировать опасно
        // - S3 presigned-URL меняется каждый запрос — кеш бесполезен
        // - PDF (контракты/инвойсы) — no-store, private — не трогать
      },
    }),
  ],
})
