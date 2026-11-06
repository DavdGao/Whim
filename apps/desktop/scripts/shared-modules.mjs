// Shares the Renderer's React and UI modules with plugin client entries (design.md §5.7).
//
// The Renderer publishes each shared module object on `globalThis.__whimShared` (see
// `src/renderer/plugins/shared-modules.ts`). This Vite plugin emits one forwarding ES module per
// specifier under `shared/`, and a static import map that resolves the bare specifiers plugin code
// imports to those files. The import map's hash is added to the page's script CSP.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';

/** Shared CommonJS packages; their export names come from loading them. */
const packages = ['react', 'react/jsx-runtime', 'react-dom', 'sonner'];

const identifier = /^[A-Za-z_$][\w$]*$/;

/**
 * List a directory's files recursively.
 * @param dir The directory.
 * @returns Absolute file paths.
 */
async function walk(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(path)));
        else files.push(path);
    }
    return files;
}

/**
 * Read the export names of ES module sources without bundling them.
 * @param files Source files.
 * @returns Export names by file.
 */
async function moduleExports(files) {
    const result = await build({
        entryPoints: files,
        bundle: false,
        write: false,
        metafile: true,
        format: 'esm',
        jsx: 'automatic',
        outdir: 'shared-exports',
        logLevel: 'silent',
    });
    const names = new Map();
    for (const output of Object.values(result.metafile.outputs))
        if (output.entryPoint) names.set(join(process.cwd(), output.entryPoint), output.exports);
    return names;
}

/**
 * The forwarding module for one specifier.
 * @param specifier The shared specifier.
 * @param names Its export names.
 * @returns Module source.
 */
function forwarder(specifier, names) {
    const named = names.filter(name => name !== 'default' && identifier.test(name));
    return [
        `const m = globalThis.__whimShared[${JSON.stringify(specifier)}];`,
        'export default m.default ?? m;',
        named.length ? `export const { ${named.join(', ')} } = m;` : '',
        '',
    ].join('\n');
}

/**
 * The Vite plugin.
 * @param uiRoot The `@whimkit/ui` package's `src` directory.
 * @returns The plugin.
 */
export function sharedModules(uiRoot) {
    const require = createRequire(join(process.cwd(), 'package.json'));
    let modules = [];
    return {
        name: 'whim-shared-modules',
        apply: 'build',
        async buildStart() {
            modules = packages.map(specifier => ({
                specifier,
                names: Object.keys(require(specifier)),
            }));
            const files = [
                ...(await walk(join(uiRoot, 'components'))).filter(file => file.endsWith('.tsx')),
                join(uiRoot, 'lib', 'utils.ts'),
            ];
            const exports = await moduleExports(files);
            for (const file of files)
                modules.push({
                    specifier: `@whimkit/ui/${relative(uiRoot, file)
                        .split('\\')
                        .join('/')
                        .replace(/\.tsx?$/, '')}`,
                    names: exports.get(file) ?? [],
                });
        },
        generateBundle() {
            for (const { specifier, names } of modules)
                this.emitFile({
                    type: 'asset',
                    fileName: `shared/${specifier.replace(/^@whimkit\//, '')}.js`,
                    source: forwarder(specifier, names),
                });
        },
        transformIndexHtml: {
            order: 'post',
            handler(html) {
                const imports = Object.fromEntries(
                    modules.map(({ specifier }) => [
                        specifier,
                        `./shared/${specifier.replace(/^@whimkit\//, '')}.js`,
                    ])
                );
                const map = JSON.stringify({ imports });
                const hash = createHash('sha256').update(map).digest('base64');
                const csp =
                    /(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*script-src [^;"]*)/;
                if (!csp.test(html)) throw new Error('index.html needs a script-src CSP.');
                // After the CSP meta, before any module script.
                return html
                    .replace(csp, `$1 'sha256-${hash}'`)
                    .replace(
                        /(<meta\s+http-equiv="Content-Security-Policy"[^>]*>)/,
                        `$1\n        <script type="importmap">${map}</script>`
                    );
            },
        },
    };
}
