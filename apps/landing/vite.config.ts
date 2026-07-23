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
      // Same pattern as apps/web/vite.config.ts — resolve straight to TS
      // source instead of `dist/index.js`. The CJS `tsc`-built dist re-exports
      // via `export *` chains that Rollup's static named-export analysis
      // cannot always see through (build broke on `publicVacancySchema`
      // otherwise), and this also skips the extra `pnpm --filter @crm/shared
      // build` step during local dev.
      '@crm/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
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
