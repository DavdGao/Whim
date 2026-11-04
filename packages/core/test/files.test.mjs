import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { card } from '../../../test/card.mjs';
import { FileService } from '../dist/files.js';
import { SqliteStore } from '../dist/store.js';

test('file admission preserves original bytes and rejects unsupported, oversized, and invalid content', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whim-files-'));
    const store = await SqliteStore.open(join(directory, 'test.sqlite'));
    t.after(async () => {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const service = new FileService(store);
    const signal = new globalThis.AbortController().signal;
    const upload = {
        name: 'note.txt',
        mediaType: 'text/plain',
        data: Buffer.from('Remember this.').toString('base64'),
    };
    const result = await service.prepare([upload], card, signal);
    assert.deepEqual(result.blocks, [
        {
            type: 'text',
            text: '<attachment name="note.txt" media-type="text/plain">\nRemember this.\n</attachment>',
        },
    ]);
    assert.deepEqual(await store.getArtifact(result.attachments[0].id), {
        ...upload,
        id: result.attachments[0].id,
    });
    for (const invalid of [
        { ...upload, data: Buffer.from([255, 255]).toString('base64') },
        { ...upload, data: Buffer.alloc(100001, 65).toString('base64') },
        { ...upload, mediaType: 'application/octet-stream' },
        { ...upload, mediaType: 'image/png' },
    ])
        await assert.rejects(
            service.prepare([invalid], card, signal),
            error => error.failure.category === 'invalid-input'
        );
});

test('PDF extraction runs off-thread and admits bounded selectable text', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whim-pdf-'));
    const store = await SqliteStore.open(join(directory, 'test.sqlite'));
    t.after(async () => {
        await store.close();
        await rm(directory, { recursive: true, force: true });
    });
    const content = 'BT /F1 12 Tf 40 100 Td (PDF fixture text) Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const start = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const result = await new FileService(store).prepare(
        [
            {
                name: 'fixture.pdf',
                mediaType: 'application/pdf',
                data: Buffer.from(pdf).toString('base64'),
            },
        ],
        card,
        new globalThis.AbortController().signal
    );
    assert.deepEqual(result.blocks, [
        {
            type: 'text',
            text: '<attachment name="fixture.pdf" media-type="application/pdf">\n[Page 1]\nPDF fixture text\n</attachment>',
        },
    ]);
});
