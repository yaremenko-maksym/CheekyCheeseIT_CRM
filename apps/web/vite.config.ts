import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { pwaRuntimeCaching } from './app/lib/pwa-runtime-caching'

export default defineConfig({
  // Per-build cache buster for persistQueryClient (see __root.tsx CACHE_BUSTER):
  // each build gets a unique value so the IndexedDB persist cache invalidates on
  // deploy (prevents stale serialised query shapes). A deploy pipeline may set
  // VITE_BUILD_VERSION (e.g. the git sha) to override the timestamp default.
  define: {
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(
      process.env.VITE_BUILD_VERSION ?? `b-${Date.now().toString(36)}`,
    ),
  },
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
        target: process.env['VITE_PROXY_API_TARGET'] ?? 'http://localhost:3001',
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
        target: process.env['VITE_PROXY_API_TARGET'] ?? 'http://localhost:3001',
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
          // Транзитивные зависимости recharts v3 (redux/@reduxjs/toolkit/react-redux/
          // reselect/immer/redux-thunk — внутренний стор анимаций; eventemitter3 —
          // событийная шина; internmap — d3-array; decimal.js-light/es-toolkit —
          // числовые/утилитарные хелперы) НЕ матчились ни одним из старых правил и
          // проваливались в общий vendor-misc catch-all. manualChunks работает на
          // уровне физического файла: если хоть один модуль из vendor-misc
          // статически достижим из entry (axios/zod/sonner и т. п.), Vite помечает
          // ВЕСЬ файл на modulepreload — включая эти транзитивные зависимости,
          // хотя сам recharts используется только в FinanceChart (не на первом
          // экране). Поэтому им нужен СВОЙ физический чанк, куда нет статического
          // пути из entry. Подтверждено `pnpm why <pkg>` — единственный потребитель
          // везде recharts.
          if (
            id.includes('node_modules/recharts/') ||
            id.includes('node_modules/d3-') ||
            id.includes('node_modules/victory-vendor/') ||
            id.includes('node_modules/redux/') ||
            id.includes('node_modules/redux-thunk/') ||
            id.includes('node_modules/react-redux/') ||
            id.includes('node_modules/@reduxjs/') ||
            id.includes('node_modules/reselect/') ||
            id.includes('node_modules/immer/') ||
            id.includes('node_modules/eventemitter3/') ||
            id.includes('node_modules/internmap/') ||
            id.includes('node_modules/decimal.js-light/') ||
            id.includes('node_modules/es-toolkit/')
          ) {
            return 'vendor-charts'
          }

          // ── CodeMirror редактор ─────────────────────────────────────────
          // Используется только в documents/onboarding — хорошо изолируется.
          // @lezer/* (грамматики парсера) + crelt/style-mod/w3c-keyname/@marijn —
          // транзитивные зависимости @codemirror/* с ДРУГИМ именем пакета, тоже
          // проваливались в vendor-misc (подтверждено `pnpm why @lezer/common`
          // и т. п. — единственный потребитель везде codemirror-стек).
          if (
            id.includes('node_modules/@codemirror/') ||
            id.includes('node_modules/@uiw/react-codemirror') ||
            id.includes('node_modules/@uiw/codemirror') ||
            id.includes('node_modules/codemirror/') ||
            id.includes('node_modules/@lezer/') ||
            id.includes('node_modules/crelt/') ||
            id.includes('node_modules/style-mod/') ||
            id.includes('node_modules/w3c-keyname/') ||
            id.includes('node_modules/@marijn/')
          ) {
            return 'vendor-codemirror'
          }

          // ── Тяжёлые утилиты ─────────────────────────────────────────────
          // libphonenumber-js ~600 KB, react-signature-canvas, react-easy-crop.
          // country-flag-icons (флаги стран, ~230 KB нераспакованными!) и
          // input-format/classnames — транзитивные зависимости
          // react-phone-number-input (флаги подключаются через отдельный
          // подпуть `react-phone-number-input/flags`, но сам пакет
          // country-flag-icons резолвится по СВОЕМУ имени и не матчился старым
          // правилом). normalize-wheel — транзитивная зависимость
          // react-easy-crop (обработка колеса мыши при зуме). Все подтверждены
          // `pnpm why` — единственный потребитель именно эти два пакета.
          if (
            id.includes('node_modules/libphonenumber-js/') ||
            id.includes('node_modules/react-phone-number-input/') ||
            id.includes('node_modules/react-signature-canvas/') ||
            id.includes('node_modules/react-easy-crop/') ||
            id.includes('node_modules/country-flag-icons/') ||
            id.includes('node_modules/input-format/') ||
            id.includes('node_modules/classnames/') ||
            id.includes('node_modules/normalize-wheel/')
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

          // ── Календарь (react-day-picker) ─────────────────────────────────
          // Используется только в date-picker.tsx → legend-роуте и диалоге
          // создания транзакции (finance) — не на первом экране. @date-fns/tz —
          // транзитивная зависимость react-day-picker (подтверждено `pnpm why`),
          // НЕ путать с обычным `date-fns` (тот используется в app-шелле —
          // notifications-bell — и остаётся в общем vendor-misc).
          if (
            id.includes('node_modules/react-day-picker/') ||
            id.includes('node_modules/@date-fns/')
          ) {
            return 'vendor-calendar'
          }

          // ── Command palette (cmdk) ────────────────────────────────────────
          // Используется только внутри phone-input.tsx (выбор страны) и
          // chip-полей HR/Accountant — везде за диалогом, не на первом экране.
          if (id.includes('node_modules/cmdk/')) {
            return 'vendor-cmdk'
          }

          // ── Markdown / diff / unified-экосистема ────────────────────────
          // Хвост транзитивных зависимостей remark/rehype/hast с ДРУГИМИ
          // именами пакетов (zwitch/bail/devlop — внутренности unified;
          // markdown-table/decode-named-character-reference/ccount/
          // longest-streak/trim-lines — micromark/mdast-util-gfm;
          // property-information/space-separated-tokens/comma-separated-tokens/
          // html-url-attributes/style-to-object/style-to-js/inline-style-parser/
          // is-plain-obj/estree-util-is-identifier-name/@ungap/structured-clone —
          // hast-util-to-jsx-runtime и mdast-util-to-hast). Подтверждено
          // `pnpm why` — единственный потребитель везде react-markdown/remark-gfm.
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
            id.includes('node_modules/unist') ||
            id.includes('node_modules/zwitch/') ||
            id.includes('node_modules/bail/') ||
            id.includes('node_modules/devlop/') ||
            id.includes('node_modules/markdown-table/') ||
            id.includes('node_modules/property-information/') ||
            id.includes('node_modules/space-separated-tokens/') ||
            id.includes('node_modules/comma-separated-tokens/') ||
            id.includes('node_modules/html-url-attributes/') ||
            id.includes('node_modules/trough/') ||
            id.includes('node_modules/decode-named-character-reference/') ||
            id.includes('node_modules/ccount/') ||
            id.includes('node_modules/longest-streak/') ||
            id.includes('node_modules/trim-lines/') ||
            id.includes('node_modules/is-plain-obj/') ||
            id.includes('node_modules/estree-util-is-identifier-name/') ||
            id.includes('node_modules/style-to-object/') ||
            id.includes('node_modules/style-to-js/') ||
            id.includes('node_modules/inline-style-parser/') ||
            id.includes('node_modules/@ungap/')
          ) {
            return 'vendor-markdown'
          }

          // ── Прочие node_modules → общий vendor ──────────────────────────
          // axios, zod, date-fns, sonner, clsx, tailwind-merge,
          // class-variance-authority, tw-animate-css, idb-keyval и т. п. —
          // всё, что реально нужно на первом экране (app-шелл, auth-guard,
          // тосты, персист query-client) либо не выделено в отдельный чанк.
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
      // Auto-split each route's component/loader into its own lazy chunk so the
      // entry graph no longer statically imports all 30 routes (which pulled
      // codemirror/recharts/markdown/etc. into the eager modulepreload set →
      // ~3.2 MB parsed on first paint → 9 s dashboard + main-thread jank).
      autoCodeSplitting: true,
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

        // НЕ перехватывать /api/* — auth/данные нельзя кешировать навигационно.
        // (Это ограничивает только navigation-фолбэк; /api/* GET-запросы XHR/fetch
        // из SPA не являются навигациями и обходят SW отдельно — см. runtimeCaching
        // ниже, там для /api/* больше НЕТ ни одного правила вообще.)
        navigateFallbackDenylist: [/^\/api\//],

        // Удалять устаревшие кеши при обновлении SW.
        // ВАЖНО: это чистит только versioned PRECACHE-кеши (workbox-precache-*,
        // имя меняется на каждом билде). Runtime-кеши с фиксированным именем
        // (media-cache) этим НЕ затрагиваются — они живут, пока их явно не
        // удалят (logout — см. app/lib/use-logout.ts) или не истечёт
        // `expiration`. api-cache больше не существует как runtime-кеш вообще,
        // поэтому очистка уже накопленного у пользователей идёт отдельным
        // явным шагом — см. importScripts ниже.
        cleanupOutdatedCaches: true,

        // SW немедленно берёт управление над всеми клиентами (включая уже
        // ЗАГРУЖЕННУЮ страницу посреди сессии), в паре со skipWaiting ниже.
        //
        // Это осознанно ОСТАВЛЕНО как есть (не отключено) — рассуждение из
        // PR "fix(web): stop routing API requests through the service worker":
        //   1. app/client.tsx уже давно и намеренно построен вокруг этой пары:
        //      controllerchange → полный `window.location.reload()`
        //      (app/lib/sw-reload.ts, unit-тесты покрывают решение) плюс
        //      `vite:preloadError` → тот же forced reload (app/lib/preload-reload.ts).
        //      Отключить clientsClaim — значит оставить старые вкладки работать
        //      на устаревшем JS-бандле до следующей навигации (undermины
        //      registerType: 'autoUpdate') и одновременно СЛОМАТЬ этот уже
        //      протестированный механизм, который рассчитан именно на claim
        //      посреди сессии.
        //   2. Путь, который РЕАЛЬНО вызвал 16.7s зависание (см. PR) — это
        //      /api/* GET через api-cache; после его удаления единственные
        //      маршруты, которые SW ещё перехватывает (respondWith), — это
        //      precache (JS/CSS/HTML, навигации) и media-cache
        //      (кросс-origin картинки/PDF из S3/R2). Первый уже покрыт п.1
        //      (forced reload вместо зависания). Второй — низкочастотный
        //      (ленивая загрузка по требованию, не 5 параллельных вызовов на
        //      каждом маунте приложения, как было с /api/*) и деградирует
        //      мягко (просто картинка не подгрузится сразу — не блокирует
        //      весь UI, как блокировали зависшие /api/* данные).
        clientsClaim: true,

        // Новый SW активируется без ожидания закрытия вкладок
        skipWaiting: true,

        // Довесок к сгенерированному sw.js: один-в-один activate-обработчик,
        // который удаляет ОСТАВШИЙСЯ на устройствах кеш `api-cache`/`media-cache`
        // + связанные записи IndexedDB `workbox-expiration` (правило для этих
        // кешей удалено/сужено ниже, но у уже установленных SW они могли
        // накопиться — см. комментарий в самом файле). Файл лежит в public/
        // (копируется в билд как есть) и подключается через importScripts()
        // внутри сгенерированного SW — штатный механизм workbox-build именно
        // для такого случая (см. его типы: "useful when you want to let
        // Workbox create your top-level service worker file, but want to
        // include some additional code").
        //
        // security HIGH-1 (task-scan-cache-leak round 2, security-review PR
        // #479): ИМЯ этого файла ОБЯЗАНО версионироваться при каждом
        // изменении его ПОВЕДЕНИЯ (сейчас v2; следующее — v3, и т.д.), и это
        // значение здесь обновляется В ТОМ ЖЕ коммите. Причина — путь файла
        // подпадает под nginx-правило `*.js → immutable, 1y` (см. заголовок
        // самого файла), а SW регистрируется без `updateViaCache` (дефолт
        // 'imports') — значит importScripts()-импорты идут через ОБЫЧНЫЙ
        // HTTP-кеш, а не всегда со свежей сети, в отличие от самого sw.js.
        // Правка ЭТОГО файла под ТЕМ ЖЕ именем невидима для устройства, у
        // которого старое тело уже закешировано на год — проверено живьём на
        // проде (v1 без переименования не доехал ни до одного устройства).
        // Переименование — гарантированный cache miss (новый URL никогда не
        // резолвился в кешированную запись), поэтому доставка гарантирована.
        importScripts: ['/sw-purge-v2.js'],

        // Правила матчинга вынесены в app/lib/pwa-runtime-caching.ts —
        // подробности (в т.ч. почему здесь больше нет /api/*-правила) там же,
        // плюс регрессионный тест pwa-runtime-caching.spec.ts.
        runtimeCaching: pwaRuntimeCaching,
      },
    }),
  ],
})
