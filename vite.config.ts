import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flakyReplayApi } from "./src/server/api.js";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    flakyReplayApi({
      dataFile: resolve(process.cwd(), "data/store.json"),
      seedFile: resolve(process.cwd(), "samples/runs.ndjson"),
    }),
  ],
});
