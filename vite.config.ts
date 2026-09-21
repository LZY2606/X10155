import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiHandler, type ApiRequest } from './src/server/api.js';
import { loadOrSeedStore, saveStore } from './src/server/persistence.js';

const STORE_FILE = new URL('./data/store.json', import.meta.url).pathname;

function apiMiddleware(): PluginOption {
  return {
    name: 'flaky-replay-api',
    configureServer(server) {
      const store = loadOrSeedStore(STORE_FILE);
      const handle = createApiHandler(store);

      server.middlewares.use('/api', (req: IncomingMessage, res: ServerResponse) => {
        readJson(req)
          .then((body) => {
            const request: ApiRequest = {
              method: req.method ?? 'GET',
              path: (req.url ?? '').split('?')[0],
              body,
            };
            // /api 前缀已被 middleware mount 吃掉，补回来以匹配路由。
            const response = handle({ ...request, path: `/api${request.path}` });
            send(res, response.status, response.body, () => saveStore(STORE_FILE, store));
          })
          .catch((error: unknown) => {
            server.config.logger.error((error as Error).stack ?? String(error));
            send(res, 500, { error: '服务器内部错误' });
          });
      });
    },
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  afterSend?: () => void,
): void {
  const isString = typeof body === 'string';
  res.statusCode = status;
  res.setHeader('content-type', isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.end(isString ? body : JSON.stringify(body), () => afterSend?.());
}

export default defineConfig({
  plugins: [react(), apiMiddleware()],
  server: { host: '127.0.0.1', port: 5231 },
});
