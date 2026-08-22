import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Required so the tunnel hostname (trycloudflare.com etc.) is accepted.
      host: true,
      allowedHosts: true,
      /**
       * Proxy /api to the backend during development. This keeps the frontend
       * same-origin, which avoids CORS entirely and means one tunnel is enough
       * to serve both the app and its API to Telegram.
       */
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
    },
  };
});
