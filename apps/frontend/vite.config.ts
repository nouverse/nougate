import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '');
  const BACKEND_URL = env.VITE_BACKEND_URL || env.BASE_URL || 'http://localhost:3000';

  return {
    plugins: [
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
      }),
      react(),
      tailwindcss(),
    ],
    base: '/frontend/',
    envDir: '../../',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': BACKEND_URL,
        '/openai': BACKEND_URL,
        '/anthropic': BACKEND_URL,
        '/oauth': BACKEND_URL,
      },
    },
  };
});
