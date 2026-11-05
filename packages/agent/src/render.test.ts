import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toRequestMessages } from './render.js';

import type { HistoryEntry, MediaBlock } from '@whimkit/core/contracts';

const image: MediaBlock = {
    type: 'media',
    id: 'img-0011aabb',
    mediaType: 'image/png',
    name: 'a b.png',
    uri: 'file:///tmp/s/media/0011aabb.png',
    bytes: 3,
    sha256: '0011aabb'.padEnd(64, '0'),
};

const read = async () => new Uint8Array([1, 2, 3]);
const inline = { type: 'inline_media', mediaType: 'image/png', data: 'AQID' } as const;

/**
 * History: a user message with an image, then two tool calls whose first result has an image.
 * @returns The entries.
 */
function history(): HistoryEntry[] {
    return [
        {
            seq: 1,
            item: {
                type: 'message',
                id: 'u',
                role: 'user',
                blocks: [{ type: 'text', text: 'look' }, image],
            },
        },
        {
            seq: 2,
            item: {
                type: 'message',
                id: 'a',
                role: 'assistant',
                blocks: [
                    { type: 'tool_call', callId: 'c1', name: 'Read', arguments: '{}' },
                    { type: 'tool_call', callId: 'c2', name: 'Read', arguments: '{}' },
                ],
            },
        },
        {
            seq: 3,
            item: {
                type: 'tool_result',
                id: 'r2',
                callId: 'c2',
                name: 'Read',
                status: 'success',
                content: 'text',
            },
        },
        {
            seq: 4,
            item: {
                type: 'tool_result',
                id: 'r1',
                callId: 'c1',
                name: 'Read',
                status: 'success',
                content: 'an image',
                media: [{ ...image, name: 'shot.png' }],
            },
        },
    ] as HistoryEntry[];
}

describe('media in requests', () => {
    it('inlines readable media and promotes tool media after all results', async () => {
        const messages = await toRequestMessages(history(), {
            accepts: type => type === 'image/png',
            inToolResults: [],
            read,
        });
        assert.deepEqual(messages, [
            { role: 'user', blocks: [{ type: 'text', text: 'look' }, inline] },
            {
                role: 'assistant',
                blocks: [
                    { type: 'tool_call', callId: 'c1', name: 'Read', arguments: '{}' },
                    { type: 'tool_call', callId: 'c2', name: 'Read', arguments: '{}' },
                ],
            },
            {
                role: 'tool',
                callId: 'c1',
                status: 'success',
                content:
                    'an image\n<system-reminder>A image/png file is returned and will be presented to you with the identifier [img-0011aabb].</system-reminder>',
            },
            { role: 'tool', callId: 'c2', status: 'success', content: 'text' },
            {
                role: 'user',
                blocks: [
                    {
                        type: 'text',
                        text: '<system-reminder>The media returned by the tools above, by identifier:',
                    },
                    { type: 'text', text: '- img-0011aabb (image/png):' },
                    inline,
                    { type: 'text', text: '</system-reminder>' },
                ],
            },
        ]);
    });

    it('carries tool media inline when the adapter supports it', async () => {
        const messages = await toRequestMessages(history(), {
            accepts: () => true,
            inToolResults: ['image/png'],
            read,
        });
        assert.deepEqual(messages[2], {
            role: 'tool',
            callId: 'c1',
            status: 'success',
            content: 'an image',
            media: [inline],
        });
        assert.equal(messages.length, 4);
    });

    it('references media the model cannot read by file URI', async () => {
        const messages = await toRequestMessages(history(), {
            accepts: () => false,
            inToolResults: [],
            read: () => Promise.reject(new Error('not read')),
        });
        assert.deepEqual(messages[0], {
            role: 'user',
            blocks: [
                { type: 'text', text: 'look' },
                {
                    type: 'text',
                    text: '<data id="img-0011aabb" uri="file:///tmp/s/media/0011aabb.png" media_type="image/png" name="a b.png"/>',
                },
            ],
        });
        assert.equal(
            messages[2]?.role === 'tool' ? messages[2].content : undefined,
            'an image\n<data id="img-0011aabb" uri="file:///tmp/s/media/0011aabb.png" media_type="image/png" name="shot.png"/>'
        );
    });
});
