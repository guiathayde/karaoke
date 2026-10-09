import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: api, xfwd: true },
      '/media': { target: api, xfwd: true },
      '/ws': { target: api.replace('http', 'ws'), ws: true, xfwd: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
