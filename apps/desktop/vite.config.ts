import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'src/renderer',
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) } },
    build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
