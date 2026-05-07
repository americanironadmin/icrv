import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

// Pull VITE_* values out of frontend/wrangler.toml [vars] so the same file is
// the single source of truth for both Pages Functions runtime config and the
// Vite build-time bundle. Without this, [vars] are runtime-only and end up
// empty in the client bundle (the SignIn panel then shows the "team domain
// not configured" notice and the SIGN IN button goes nowhere).
function loadWranglerViteVars(): Record<string, string> {
  const path = resolve(__dirname, 'wrangler.toml')
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  // Capture from the [vars] header to the next [section] header (or EOF).
  // (No \Z in JS regex — use a lookahead that allows end-of-string.)
  const section = text.match(/^\[vars\]\s*$([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/m)
  if (!section) return {}
  const out: Record<string, string> = {}
  for (const raw of section[1].split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const kv = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/)
    if (kv && kv[1].startsWith('VITE_')) out[kv[1]] = kv[2]
  }
  return out
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: Object.fromEntries(
    Object.entries(loadWranglerViteVars()).map(([k, v]) => [
      `import.meta.env.${k}`,
      // process.env wins so a Pages dashboard / CI env var can still override
      // the committed wrangler.toml default.
      JSON.stringify(process.env[k] ?? v),
    ]),
  ),
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
