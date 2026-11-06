import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { sharedModules } from './scripts/shared-modules.mjs';

export default defineConfig({
    root: 'src/renderer',
    base: './',
    plugins: [
        react(),
        tailwindcss(),
        sharedModules(fileURLToPath(new URL('../../packages/ui/src', import.meta.url))),
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) } },
    build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
