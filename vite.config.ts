import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext' },
  test: { environment: 'happy-dom', globals: false, include: ['tests/**/*.test.ts'] },
})
