import { fileURLToPath, URL } from 'node:url'
import { defineConfig, lazyPlugins } from 'vite-plus'
import react from '@vitejs/plugin-react'

const serverOptions = {
  // Vite refuses requests for any host it does not know, so the public
  // hostname behind the Cloudflare tunnel got a 403 on every page.
  allowedHosts: ['chess.uwe.rw', ...(process.env.ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])],
  headers: {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  },
  proxy: {
    '/api': {
      // Inside the compose stack `localhost` is the frontend container
      // itself, so every proxied request answered 502; compose points this
      // at the backend service.
      target: process.env.API_PROXY_TARGET ?? 'http://localhost:8000',
      changeOrigin: true,
    },
  },
}

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  optimizeDeps: {
    exclude: ['@lichess-org/stockfish-web'],
  },
  plugins: lazyPlugins(() => [
    react(),
    {
      name: 'cross-origin-isolation',
      configureServer(server) {
        server.middlewares.use((_, res, next) => {
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          next()
        })
      },
    },
  ]),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/chess.js/') ||
            id.includes('/node_modules/react-chessboard/')
          ) {
            return 'chess'
          }

          if (
            id.includes('/node_modules/@tanstack/react-query/') ||
            id.includes('/node_modules/axios/') ||
            id.includes('/node_modules/zustand/')
          ) {
            return 'query'
          }

          return undefined
        },
      },
    },
  },
  server: serverOptions,
  // The production build is served the same way: the engine's threads need
  // cross-origin isolation, and the API sits behind the same proxy.
  preview: serverOptions,
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
