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
    allowedHosts: [
      '.loca.lt',                  // LocalTunnel
      '.trycloudflare.com',        // Cloudflare quick tunnel
      '.serveousercontent.com',    // serveo.net (SSH)
      '.ngrok.io',                 // ngrok legacy
      '.ngrok-free.app',           // ngrok free
      '.ngrok.app',                // ngrok paid
    ],
  },
  preview: {
    port: 3000,
    // То же что для dev — слушать 0.0.0.0 + пропускать .loca.lt туннель.
    host: true,
    allowedHosts: [
      '.loca.lt',                  // LocalTunnel
      '.trycloudflare.com',        // Cloudflare quick tunnel
      '.serveousercontent.com',    // serveo.net (SSH)
      '.ngrok.io',                 // ngrok legacy
      '.ngrok-free.app',           // ngrok free
      '.ngrok.app',                // ngrok paid
    ],
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
  ],
})
