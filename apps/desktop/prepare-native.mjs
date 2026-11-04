import { URL } from 'node:url';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuild } from '@electron/rebuild';

const require = createRequire(import.meta.url);
const coreRequire = createRequire(new URL('../../packages/core/package.json', import.meta.url));

export async function prepareNative() {
    const electron = JSON.parse(await readFile(require.resolve('electron/package.json'), 'utf8'));
    const root = fileURLToPath(new URL(`./.native/${electron.version}/`, import.meta.url));
    const binding = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    try {
        await stat(join(root, 'ready'));
        return binding;
    } catch {
        /* Build this Electron ABI once. */
    }
    await mkdir(join(root, 'node_modules'), { recursive: true });
    const source = dirname(await realpath(coreRequire.resolve('better-sqlite3/package.json')));
    await cp(source, join(root, 'node_modules/better-sqlite3'), { recursive: true });
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
            name: 'whim-native-build',
            version: '0.1.0',
            dependencies: {
                'better-sqlite3': JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
                    .version,
            },
        })
    );
    await rebuild({
        buildPath: root,
        electronVersion: electron.version,
        force: true,
        onlyModules: ['better-sqlite3'],
    });
    await stat(binding);
    await writeFile(join(root, 'ready'), electron.version);
    return binding;
}
