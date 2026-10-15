import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, '../../', '');
  const BACKEND_URL = env.VITE_BACKEND_URL || env.BASE_URL || 'http://localhost:3000';

  return {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    plugins: [
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
      }),
      react(),
      tailwindcss(),
    ],
    /**
     * Relative in a build, so one bundle serves the gateway's own `/frontend/` and a host that mounts
     * it under a prefix of its own (Nouride's `/llm-gateway/frontend/`). The server makes the entry
     * document's references absolute per request (`backend/src/router/entry-document.ts`), which a
     * deep link needs; the bundle resolves its own chunks from where it was loaded.
     *
     * The dev server keeps the absolute base: it serves the page itself, at `/frontend/`.
     */
    base: command === 'build' ? './' : '/frontend/',
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
