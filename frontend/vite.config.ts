import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // pdf.js alone is ~700 kB; that's fine for an app served from this machine.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    // The Python backend; see ../backend.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
