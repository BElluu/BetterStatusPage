import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api/v1/public/events': {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept', 'text/event-stream')
          })
        },
      },
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
