import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'
import { codeLanguageIds } from './src/core/codeLanguages.ts'
import { developmentBridge } from './scripts/dev-bridge.mjs'

export default defineConfig({
  plugins: [solid(), developmentBridge()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext' },
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['lowlight', ...codeLanguageIds.map((id) => `highlight.js/lib/languages/${id}`)],
  },
  test: { environment: 'happy-dom', globals: false, include: ['tests/**/*.test.ts'] },
})
