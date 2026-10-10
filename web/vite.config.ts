import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// "npm run build" writes straight into the server's wwwroot, so the server serves the UI.
// "npm run dev" gives hot reload and forwards everything else to a server on port 8080.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../server/wwwroot', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/media': 'http://localhost:8080',
      '/player': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
