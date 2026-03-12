import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port for dev server
  server: {
    port: 1420,
    strictPort: true,
  },
  // Required for Tauri to work with HMR
  envPrefix: ['VITE_', 'TAURI_'],
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
  build: {
    // Tauri supports es2021
    target: ['es2022', 'chrome100', 'safari16'],
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
