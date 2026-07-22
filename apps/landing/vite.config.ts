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
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 3002,
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
    }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
})
