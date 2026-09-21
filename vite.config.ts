import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { Store } from './src/core/store.js';
import { createApiHandler } from './src/server/api.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function apiPlugin(): Plugin {
  const store = new Store(path.join(rootDir, 'data', 'store.json'));
  const handler = createApiHandler(store, rootDir);
  return {
    name: 'flaky-replay-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        void handler(req, res);
      });
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
});
