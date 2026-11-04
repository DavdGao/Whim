// Bundles the Electron main, preload, and Backend entries. Workspace packages stay external so
// Core can start its DB worker and plugins load from their own package directories.
import { build } from 'esbuild';

const common = {
    bundle: true,
    platform: 'node',
    target: 'node24',
    sourcemap: true,
    logLevel: 'warning',
};
const external = ['electron', '@whimkit/*'];

await Promise.all([
    build({
        ...common,
        entryPoints: ['src/main/main.ts'],
        outfile: 'dist/main.js',
        format: 'esm',
        external,
    }),
    build({
        ...common,
        entryPoints: ['src/backend/backend.ts'],
        outfile: 'dist/backend.js',
        format: 'esm',
        external,
    }),
    // Sandboxed preloads must be CommonJS.
    build({
        ...common,
        entryPoints: ['src/main/preload.ts'],
        outfile: 'dist/preload.cjs',
        format: 'cjs',
        external: ['electron'],
    }),
]);
