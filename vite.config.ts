import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { replayApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), replayApiPlugin()],
});
