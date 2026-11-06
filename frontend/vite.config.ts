import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Development only: Vite serves the UI on :5006 and proxies /api to the
// service (`npm start` runs both). In daily use the service serves frontend/dist itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5006,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5005', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
