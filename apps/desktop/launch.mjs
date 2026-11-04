import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

import { prepareNative } from './prepare-native.mjs';

const require = createRequire(import.meta.url);
const nativeBinding = await prepareNative();
const child = spawn(require('electron'), ['.'], {
    stdio: 'inherit',
    env: { ...process.env, WHIM_SQLITE_BINDING: nativeBinding },
});
child.on('error', error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
child.on('exit', code => {
    process.exitCode = code ?? 1;
});
