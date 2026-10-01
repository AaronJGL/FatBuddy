import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'FatBuddy 開飯輪盤',
        short_name: 'FatBuddy',
        description: '快速決定今天吃什麼',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5f6f2',
        theme_color: '#263d30',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://server.fatbuddy.workers.dev',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://server.fatbuddy.workers.dev',
        changeOrigin: true,
      },
    },
  },
})