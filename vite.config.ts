import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import solid from '@solidjs/vite-plugin'
import { codeLanguageIds } from './src/core/codeLanguages.ts'
import { developmentBridge } from './scripts/dev-bridge.mjs'

function trimPreviewAssets(): Plugin {
  let previewAssets: string
  return {
    name: 'onebox-trim-preview-assets',
    apply: 'build',
    configResolved({ root, build }) {
      previewAssets = resolve(root, build.outDir, 'file-viewer')
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        // Flyfish copies its full offline asset set before this hook.
        await Promise.all(['vendor/design', 'wasm/typst', 'renderers/typst.iife.js', 'vendor/drawio']
          .map((path) => rm(resolve(previewAssets, path), { recursive: true, force: true })))
      },
    },
  }
}

export default defineConfig({
  plugins: [solid(), developmentBridge(), fileViewerRenderers({ inject: false, copyAssets: true }), trimPreviewAssets()],
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
    include: ['lowlight', 'mathlive', 'yaml', ...codeLanguageIds.map((id) => `highlight.js/lib/languages/${id}`)],
  },
  test: { environment: 'happy-dom', globals: false, include: ['tests/**/*.test.ts'] },
})
