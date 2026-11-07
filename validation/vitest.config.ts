import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Use core's source directly: no build step needed on ci32.
    alias: { '@perps-platform/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    // Live tests spend one shared funder account: never run files in parallel (nonce clashes).
    fileParallelism: false,
  },
});
