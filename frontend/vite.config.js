import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Listen on all interfaces
    allowedHosts: true, // Allow all hosts (RunPod changing URLs)
    hmr: {
      clientPort: 443, // RunPod exposes via HTTPS (443)
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Force strict deduplication of React to avoid "Invalid Hook Call"
    dedupe: ['react', 'react-dom'],
  },
})
