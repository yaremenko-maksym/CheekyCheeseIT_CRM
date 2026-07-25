import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  server: {
    port: 3002,
    proxy: {
      '/api': {
        // Same override pattern as apps/web/vite.config.ts — lets Coder/QA
        // point dev at a scratch API instance on a non-default port without
        // editing this file.
        target: process.env['VITE_PROXY_API_TARGET'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3002,
    proxy: {
      // Same override pattern as `server.proxy` above — `scripts/prerender.mjs`
      // sets VITE_PROXY_API_TARGET=$PRERENDER_API_ORIGIN before starting this
      // preview server programmatically, so the SPA's client-side
      // `fetch('/api/...')` (TanStack loaders) resolve against the real
      // vacancies API while every route is being snapshotted headlessly
      // (task-landing-seo-prerender.md §1).
      '/api': {
        target: process.env['VITE_PROXY_API_TARGET'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // '@crm/shared/public' MUST be listed before the plain '@crm/shared'
      // entry below — Vite/@rollup/plugin-alias matches importee-startsWith
      // in array order, and '@crm/shared/public'.startsWith('@crm/shared/')
      // is ALSO true, so the general entry would otherwise shadow this one
      // and wrongly resolve to a subpath of a FILE (index.ts), not a
      // directory. Points straight at packages/shared's narrow
      // Lighthouse-safe subset (see that file's doc comment / PR #421 RCA)
      // instead of the full 28-domain schema barrel.
      '@crm/shared/public': path.resolve(__dirname, '../../packages/shared/src/public.ts'),
      // Same pattern as apps/web/vite.config.ts — resolve straight to TS
      // source instead of `dist/index.js`. The CJS `tsc`-built dist re-exports
      // via `export *` chains that Rollup's static named-export analysis
      // cannot always see through (build broke on `publicVacancySchema`
      // otherwise), and this also skips the extra `pnpm --filter @crm/shared
      // build` step during local dev.
      '@crm/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Same rationale as apps/web/vite.config.ts's perf-pass manualChunks
        // (project_ui_perf_pass memory), scaled down for the landing's much
        // smaller dependency set: split the single ~527 KB vendor bundle so a
        // route only pays parse/compile cost for what it actually uses, and
        // browsers can fetch+start-parsing chunks in parallel instead of one
        // long blocking download (task-landing-seo-prerender.md §3 mobile
        // Lighthouse budget). Order matters — specific before general.
        manualChunks: (id: string): string | undefined => {
          if (
            (id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')) &&
            // react-dom/server (`markdownToHtml` in markdown-body.tsx — used
            // only by `/careers/:slug`'s JobPosting JSON-LD description,
            // task-landing-seo-prerender.md, owner decision 2026-07-24) is
            // its own separate, much heavier entry point (server-rendering
            // machinery) — deliberately EXCLUDED from this shared bucket so
            // it stays isolated to that one route's own chunk instead of
            // bloating `/` and `/careers`'s vendor-react with client-side
            // weight they never execute (confirmed via Lighthouse: sweeping
            // it in here dropped `/`'s mobile performance score from 93 to
            // exactly 90 — no margin left for CI/production variance).
            !id.includes('react-dom/server') &&
            !id.includes('react-dom-server')
          ) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/@tanstack/')) {
            return 'vendor-tanstack'
          }
          if (id.includes('node_modules/framer-motion/')) {
            return 'vendor-motion'
          }
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons'
          }
          // Deliberately NOT a catch-all `vendor-misc` bucket here (unlike
          // apps/web): grouping EVERY remaining node_modules dep into one
          // shared chunk would pull react-markdown/remark-gfm (used only by
          // `/careers/:slug`) into every route's import graph, undoing
          // autoCodeSplitting's per-route isolation. Anything not matched
          // above (zod, clsx, react-markdown, ...) is left to Rollup's own
          // automatic per-entry chunking, which already keeps it correctly
          // route-scoped.
          return undefined
        },
      },
    },
  },
  plugins: [
    TanStackRouterVite({
      routesDirectory: './app/routes',
      generatedRouteTree: './app/routeTree.gen.ts',
      // Same as apps/web/vite.config.ts (perf pass, see
      // project_ui_perf_pass memory) — each route's component/loader gets its
      // own chunk instead of one eager bundle. On the landing this keeps
      // react-markdown/remark-gfm (only used by `/careers/:slug`) out of the
      // `/` critical path (task-landing-seo-prerender.md §3).
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
})
