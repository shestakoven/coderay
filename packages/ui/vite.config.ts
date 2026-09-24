import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://127.0.0.1:4317', ws: true, changeOrigin: true } },
  },
});
