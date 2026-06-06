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

      // inline: плагин инжектирует скрипт регистрации SW прямо в index.html.
      // Не использует virtual:pwa-register — избегает проблем с Rollup resolver
      // в pnpm workspace (zod не hoisted в root node_modules).
      injectRegister: 'inline',

      // SW отключён в dev — избегаем stale-кеша при разработке
      devOptions: { enabled: false },

      // Существующий webmanifest в public/ уже содержит все нужные поля.
      // manifest: false — плагин НЕ генерирует дубль манифеста.
      manifest: false,

      workbox: {
        // Крупнейший чанк ~2.53 MB (index-*.js, весь vendor bundle).
        // Дефолтный лимит workbox = 2 MiB → build падает с exit 1.
        // Ставим 5 MiB чтобы покрыть текущий размер с запасом.
        // TODO: code-split vendor bundle (dnd-kit / framer-motion / pdf-lib)
        //   чтобы вернуться к дефолту или ~3 MiB — follow-up task.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,

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
