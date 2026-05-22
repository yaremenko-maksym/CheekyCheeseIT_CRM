import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import path from 'path'

export default defineConfig({
  server: {
    port: 3000,
    // host: true слушает на 0.0.0.0 — нужно чтобы LocalTunnel/ngrok мог проксировать с внешки.
    // allowedHosts: ['.loca.lt'] разрешает запросы из туннелей формата <subdomain>.loca.lt
    // (Vite по умолчанию режет non-localhost Host header как "Blocked request").
    host: true,
    allowedHosts: ['.loca.lt'],
  },
  preview: { port: 3000 },
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
  ],
})
