import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// shortcut: the browser only needs the intent builders, so @hypernear/client points at intents.ts and skips near-api-js; widen when a page needs more of the client.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@hypernear/client': fileURLToPath(new URL('../packages/hypernear-client/src/intents.ts', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: ['..'] } },
  build: { rollupOptions: { input: { main: 'index.html', c13: 'c13.html' } } },
});
