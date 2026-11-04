import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { foldRecords } from '../dist/index.js';
import { SqliteStore } from '../dist/store.js';

test(
    'real process termination preserves the publication cutoff and recovery distinguishes a crash',
    { timeout: 15000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'whim-crash-'));
        const child = fork(
            new URL('./crash-child.mjs', import.meta.url),
            [join(directory, 'journal.sqlite')],
            { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
        );
        let store;
        try {
            assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            assert.deepEqual(await exited, [null, 'SIGKILL']);
            store = await SqliteStore.open(join(directory, 'journal.sqlite'));
            const history = await store.read('crash-session');
            assert.equal(
                foldRecords(history).attempts.get('attempt').chunks.join(''),
                'Persisted before SIGKILL.'
            );
            const command = { type: 'recover', sessionId: 'crash-session', operationId: 'recover' };
            const recovered = await store.execute(command);
            assert.deepEqual(await store.execute(command), recovered);
            const view = foldRecords(await store.read('crash-session'));
            assert.deepEqual(view.messages.slice(-2), [
                {
                    id: 'reply',
                    role: 'assistant',
                    origin: 'assistant',
                    blocks: [{ type: 'text', text: 'Persisted before SIGKILL.' }],
                },
                {
                    id: recovered[0].id,
                    role: 'user',
                    origin: 'host',
                    blocks: [
                        {
                            type: 'text',
                            text: '<system-reminder>The previous response stopped (crash). Its saved text is incomplete.</system-reminder>',
                        },
                    ],
                },
            ]);
            assert.equal(view.held, false);
            assert.equal(view.run, null);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await store?.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
);
