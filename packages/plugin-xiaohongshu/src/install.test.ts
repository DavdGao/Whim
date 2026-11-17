import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installExecutable } from './install.js';

test('only publishes verified executable bytes and repairs a damaged cache', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whim-connector-'));
    const bytes = Buffer.from('test executable');
    let requests = 0;
    const server = createServer((_request, response) => {
        requests++;
        response.end(bytes);
    });
    t.after(async () => {
        await new Promise<void>((resolve, reject) =>
            server.close(error => (error ? reject(error) : resolve()))
        );
        await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const artifact = {
        version: 'test',
        url: `http://127.0.0.1:${address.port}`,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const signal = new AbortController().signal;
    await assert.rejects(
        installExecutable(directory, { ...artifact, sha256: 'invalid' }, signal),
        /integrity/
    );
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(installExecutable(directory, { ...artifact, size: 1 }, signal), /exceeds/);
    assert.deepEqual(await readdir(directory), []);
    const target = await installExecutable(directory, artifact, signal);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    assert.equal(await installExecutable(directory, artifact, signal), target);
    assert.equal(requests, 3);
    await writeFile(target, 'damaged');
    assert.equal(await installExecutable(directory, artifact, signal), target);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(requests, 4);
    await rm(target);
    await assert.rejects(installExecutable(directory, artifact, AbortSignal.abort()));
    assert.deepEqual(await readdir(directory), []);
});
