import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@perps-platform/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      '@hypernear/client': fileURLToPath(new URL('../packages/hypernear-client/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
