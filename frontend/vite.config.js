import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Listen on all interfaces
    allowedHosts: true, // Allow all hosts (RunPod changing URLs)
    hmr: {
      clientPort: 443, // RunPod exposes via HTTPS (443)
      // path: '/ws', // Optional, depends on proxy
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
