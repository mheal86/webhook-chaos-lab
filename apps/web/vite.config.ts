import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': apiTarget } },
  preview: { host: '127.0.0.1', port: 4173, proxy: { '/api': apiTarget } },
});
