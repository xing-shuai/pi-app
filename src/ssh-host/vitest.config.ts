import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/ssh-host/**/*.test.ts'], testTimeout: 15000, hookTimeout: 15000 },
})
