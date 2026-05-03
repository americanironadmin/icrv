import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // PR 5 / M3: strip console.* and debugger from production bundles. The
  // Sentry SDK keeps its own internal logging (uses logger.info, not bare
  // console.*) so observability survives the strip.
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          utils: ['axios', 'date-fns', 'papaparse'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'https://api.icrv.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
}))
