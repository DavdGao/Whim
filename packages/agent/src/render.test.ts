import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderNotice, toRequestMessages, transcriptText } from './render.js';

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

describe('conversation file', () => {
    it('writes each entry as one element tagged with its sequence number and time', () => {
        const at = '2026-11-11T08:00:00.000Z';
        const entries: HistoryEntry[] = [
            {
                seq: 1,
                at,
                item: {
                    type: 'message',
                    id: 'u',
                    role: 'user',
                    blocks: [{ type: 'text', text: 'read a' }],
                },
            },
            {
                seq: 2,
                at,
                status: 'interrupted',
                item: {
                    type: 'message',
                    id: 'a',
                    role: 'assistant',
                    blocks: [
                        { type: 'reasoning', text: 'look first' },
                        { type: 'reasoning', text: '' },
                        { type: 'text', text: 'Reading.' },
                        { type: 'tool_call', callId: 'c"1', name: 'Read', arguments: '{"p":"a"}' },
                    ],
                },
            },
            {
                seq: 3,
                at,
                item: {
                    type: 'tool_result',
                    id: 'r',
                    callId: 'c"1',
                    name: 'Read',
                    status: 'success',
                    content: 'line 1\nline 2',
                    media: [image],
                },
            },
            {
                seq: 4,
                at,
                item: {
                    type: 'notice',
                    id: 'n',
                    origin: { type: 'core', service: 'agent' },
                    observedAt: at,
                    kind: 'interrupted',
                    payload: { runId: 'r1', reason: 'user' },
                },
            },
        ];
        assert.equal(
            transcriptText(entries),
            [
                `<user seq="1" time="${at}">\nread a\n</user>`,
                `<assistant seq="2" time="${at}" status="interrupted">\n<reasoning>\nlook first\n</reasoning>\nReading.\n<tool_call id="c&quot;1" name="Read">{"p":"a"}</tool_call>\n</assistant>`,
                `<tool_result seq="3" time="${at}" call_id="c&quot;1" name="Read" status="success">\nline 1\nline 2\n<data id="img-0011aabb" uri="file:///tmp/s/media/0011aabb.png" media_type="image/png" name="a b.png"/>\n</tool_result>`,
                `<notice seq="4" time="${at}" kind="interrupted">\nThe user interrupted you.\n</notice>`,
            ].join('\n\n')
        );
    });
});

describe('notices', () => {
    it('renders a fired schedule as a notification with its metadata as attributes', () => {
        assert.equal(
            renderNotice({
                type: 'notice',
                id: 'n',
                origin: { type: 'core', service: 'schedules' },
                observedAt: '2026-11-11T01:00:20.000Z',
                kind: 'schedule-fired',
                payload: {
                    scheduleId: 'a1b2c3d4',
                    name: 'Say "hi" <now>',
                    dueAt: '2026-11-11T01:00:00.000Z',
                    late: true,
                },
                text: 'Write the briefing.\nKeep it short.',
            }),
            '<system-notification kind="schedule" schedule="a1b2c3d4" name="Say &quot;hi&quot; &lt;now>" due="2026-11-11T01:00:00.000Z" time="2026-11-11T01:00:20.000Z" late="true">\nWrite the briefing.\nKeep it short.\n</system-notification>'
        );
    });
});
