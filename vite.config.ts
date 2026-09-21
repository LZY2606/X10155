import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { Store } from "./src/server/store.js";
import { createApiHandler } from "./src/server/api.js";

function apiPlugin(): Plugin {
  return {
    name: "flaky-replay-api",
    configureServer(server) {
      const store = new Store(path.resolve("data/store.json"));
      const handle = createApiHandler(store);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          next();
          return;
        }
        handle(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
});
