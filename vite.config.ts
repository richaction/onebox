import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'
import { codeLanguageIds } from './src/core/codeLanguages.ts'
import { developmentBridge } from './scripts/dev-bridge.mjs'

export default defineConfig({
  plugins: [solid(), developmentBridge(), fileViewerRenderers({ inject: false, copyAssets: true })],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/public/file-viewer/**'] } },
  build: {
    target: 'esnext',
    license: true,
    rolldownOptions: { input: { main: 'index.html', preview: 'preview-frame.html' } },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    entries: ['index.html'],
    include: ['lowlight', ...codeLanguageIds.map((id) => `highlight.js/lib/languages/${id}`)],
  },
  test: { environment: 'happy-dom', globals: false, include: ['tests/**/*.test.ts'] },
})
