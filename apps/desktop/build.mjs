import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

await build({
    entryPoints: ['src/main.ts', 'src/backend.ts'],
    outdir: 'dist',
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
});
await build({
    entryPoints: ['src/preload.ts'],
    outfile: 'dist/preload.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
});
await buildRenderer({
    root: 'src/renderer',
    base: './',
    plugins: [tailwindcss()],
    build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
