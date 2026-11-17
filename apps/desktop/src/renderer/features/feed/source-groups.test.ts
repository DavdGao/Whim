/// <reference types="node" />

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { groupSources } from './source-groups';

import type { SourceState } from '../../../shared/ipc';

it('separates ready, broken, and missing configuration while keeping source order', () => {
    const entries: { id: string; health: SourceState }[] = [
        {
            id: 'new-server',
            health: {
                state: 'needs-setup',
                detail: 'Missing server',
                fix: { kind: 'mcp', server: 'missing' },
            },
        },
        { id: 'signed-out', health: { state: 'needs-login', detail: 'Sign in again' } },
        { id: 'ready', health: { state: 'ready' } },
        {
            id: 'offline',
            health: {
                state: 'needs-setup',
                detail: 'Server disabled',
                fix: { kind: 'mcp', server: 'configured' },
            },
        },
        {
            id: 'new-account',
            health: {
                state: 'needs-setup',
                detail: 'Missing credential',
                fix: { kind: 'credential', typeId: 'missing' },
            },
        },
        {
            id: 'locked-account',
            health: {
                state: 'needs-setup',
                detail: 'Credential unavailable',
                fix: { kind: 'credential', typeId: 'configured' },
            },
        },
        { id: 'unavailable', health: { state: 'unavailable', detail: 'Connection failed' } },
        { id: 'plugin-disabled', health: { state: 'needs-setup', detail: 'Plugin disabled' } },
        { id: 'ready-later', health: { state: 'ready' } },
    ];
    const sources = entries.map(entry => ({
        ...entry,
        name: entry.id,
        sessionId: entry.id,
        template: 'test#source',
        running: false,
    }));
    const before = structuredClone(sources);
    const groups = groupSources({
        sources,
        credentials: [
            {
                id: 'credential',
                typeId: 'configured',
                label: 'Account',
                values: {},
                secretsSet: [],
                createdAt: '2026-11-17T00:00:00.000Z',
                available: false,
            },
        ],
        mcpServers: [
            {
                id: 'configured',
                label: 'Source',
                enabled: false,
                trusted: false,
                secrets: [],
                transport: { kind: 'stdio', command: 'fixture', args: [], env: {} },
                status: { state: 'disabled' },
            },
        ],
    });
    assert.deepEqual(
        groups.map(group => ({ id: group.id, sources: group.sources.map(source => source.id) })),
        [
            { id: 'ready', sources: ['ready', 'ready-later'] },
            {
                id: 'invalid',
                sources: [
                    'signed-out',
                    'offline',
                    'locked-account',
                    'unavailable',
                    'plugin-disabled',
                ],
            },
            { id: 'unconfigured', sources: ['new-server', 'new-account'] },
        ]
    );
    assert.deepEqual(sources, before);
});

it('moves a source when health changes and omits empty groups', () => {
    const source = {
        id: 'source',
        sessionId: 'session',
        template: 'test#source',
        name: 'Source',
        running: false,
    };
    for (const [health, id] of [
        [{ state: 'ready' }, 'ready'],
        [{ state: 'needs-login', detail: 'Sign in again' }, 'invalid'],
        [{ state: 'ready' }, 'ready'],
    ] as const) {
        assert.deepEqual(
            groupSources({
                sources: [{ ...source, health }],
                credentials: [],
                mcpServers: [],
            }),
            [{ id, sources: [{ ...source, health }] }]
        );
    }
    assert.deepEqual(groupSources({ sources: [], credentials: [], mcpServers: [] }), []);
});
