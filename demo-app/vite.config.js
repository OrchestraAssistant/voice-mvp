import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      // Demo's own backend and the voice relay are separate services now.
      '/api': 'http://localhost:3001',
      '/voice': 'http://localhost:3002',
    },
  },
})
