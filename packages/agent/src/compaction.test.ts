import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSummary, trimLongTexts } from './compaction.js';

describe('parseSummary', () => {
    it('reads the sections in canonical order, also when the tags were escaped', () => {
        const reply = [
            'Here is the summary.',
            '&lt;next-steps&gt;Run the tests.&lt;/next-steps&gt;',
            '<goal> Ship it </goal>',
            '<current-state>Built.</current-state>',
            '<progress>Wrote a.ts.</progress>',
            '<findings>None.</findings>',
        ].join('\n');
        assert.deepEqual(parseSummary(reply), {
            summary: [
                '<goal>\nShip it\n</goal>',
                '<current-state>\nBuilt.\n</current-state>',
                '<progress>\nWrote a.ts.\n</progress>',
                '<findings>\nNone.\n</findings>',
                '<next-steps>\nRun the tests.\n</next-steps>',
            ].join('\n\n'),
            missing: [],
        });
    });

    it('names the missing sections', () => {
        assert.deepEqual(parseSummary('<goal>G</goal><progress>P'), {
            summary: '<goal>\nG\n</goal>',
            missing: ['current-state', 'progress', 'findings', 'next-steps'],
        });
    });
});

describe('trimLongTexts', () => {
    it('shortens long texts in the middle and leaves the trailing instructions alone', () => {
        const long = `${'a'.repeat(10)}${'b'.repeat(10)}`;
        assert.deepEqual(
            trimLongTexts(
                [
                    { role: 'user', blocks: [{ type: 'text', text: long }] },
                    { role: 'tool', callId: 'c', status: 'success', content: long },
                    { role: 'user', blocks: [{ type: 'text', text: 'short' }] },
                    { role: 'user', blocks: [{ type: 'text', text: long }] },
                ],
                8,
                1
            ),
            [
                {
                    role: 'user',
                    blocks: [{ type: 'text', text: 'aaaa\n[… 12 characters omitted …]\nbbbb' }],
                },
                {
                    role: 'tool',
                    callId: 'c',
                    status: 'success',
                    content: 'aaaa\n[… 12 characters omitted …]\nbbbb',
                },
                { role: 'user', blocks: [{ type: 'text', text: 'short' }] },
                { role: 'user', blocks: [{ type: 'text', text: long }] },
            ]
        );
    });
});
