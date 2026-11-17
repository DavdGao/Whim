/// <reference types="node" />

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { groupSources } from './source-groups';

import type { SourceInfo, SourceTemplateInfo } from '../../../shared/ipc';

const arxiv: SourceTemplateInfo = {
    id: 'arxiv',
    pluginId: 'arxiv',
    name: 'arXiv',
    description: 'Papers',
    login: false,
};
const reddit: SourceTemplateInfo = {
    id: 'reddit',
    pluginId: 'reddit',
    name: 'Reddit',
    description: 'Posts',
    login: false,
    credentialType: 'reddit#oauth',
};
const xhs: SourceTemplateInfo = {
    id: 'xhs',
    pluginId: 'xhs',
    name: 'Xiaohongshu',
    description: 'Notes',
    login: true,
    mcpServer: 'xiaohongshu',
};

it('shows available templates as candidates without creating any sources', () => {
    assert.deepEqual(groupSources({ sources: [], sourceTemplates: [arxiv, reddit, xhs] }), {
        ready: [],
        candidates: [
            { kind: 'new', template: arxiv },
            { kind: 'new', template: reddit },
            { kind: 'new', template: xhs },
        ],
    });
    assert.deepEqual(groupSources({ sources: [], sourceTemplates: [] }), {
        ready: [],
        candidates: [],
    });
});

it('keeps checked ready sessions above candidates and preserves existing unfinished sessions', () => {
    const ready: SourceInfo = {
        id: 'papers',
        sessionId: 'papers-session',
        name: 'Papers',
        template: 'arxiv',
        running: true,
        health: { state: 'ready', checkedAt: '2026-11-17T00:00:00.000Z' },
    };
    const unchecked: SourceInfo = {
        id: 'more-papers',
        sessionId: 'more-papers-session',
        name: 'More papers',
        template: 'arxiv',
        running: false,
        health: { state: 'ready' },
    };
    const login: SourceInfo = {
        id: 'notes',
        sessionId: 'notes-session',
        name: 'Notes',
        template: 'xhs',
        running: false,
        health: {
            state: 'needs-login',
            detail: 'Scan code',
            checkedAt: '2026-11-17T00:00:00.000Z',
        },
    };
    const removed: SourceInfo = {
        id: 'old',
        sessionId: 'old-session',
        name: 'Old source',
        template: 'removed',
        running: false,
        health: {
            state: 'needs-setup',
            detail: 'Plugin disabled',
            checkedAt: '2026-11-17T00:00:00.000Z',
        },
    };
    const sources = [login, ready, unchecked, removed];
    const before = structuredClone(sources);
    assert.deepEqual(groupSources({ sources, sourceTemplates: [arxiv, reddit, xhs] }), {
        ready: [ready],
        candidates: [
            { kind: 'existing', source: login, template: xhs },
            { kind: 'existing', source: unchecked, template: arxiv },
            { kind: 'existing', source: removed },
            { kind: 'new', template: reddit },
        ],
    });
    assert.deepEqual(sources, before);
});

it('promotes successful configuration, demotes failures, and restores deleted candidates', () => {
    const pending: SourceInfo = {
        id: 'reddit-source',
        sessionId: 'reddit-session',
        name: 'Reddit',
        template: 'reddit',
        running: false,
        health: {
            state: 'needs-setup',
            detail: 'Credentials required',
            checkedAt: '2026-11-17T00:00:00.000Z',
        },
    };
    assert.deepEqual(groupSources({ sources: [pending], sourceTemplates: [reddit] }), {
        ready: [],
        candidates: [{ kind: 'existing', source: pending, template: reddit }],
    });
    const connected: SourceInfo = {
        ...pending,
        health: { state: 'ready', checkedAt: '2026-11-17T00:01:00.000Z' },
    };
    assert.deepEqual(groupSources({ sources: [connected], sourceTemplates: [reddit] }), {
        ready: [connected],
        candidates: [],
    });
    const failed: SourceInfo = {
        ...connected,
        health: {
            state: 'unavailable',
            detail: 'Token revoked',
            checkedAt: '2026-11-17T00:02:00.000Z',
        },
    };
    assert.deepEqual(groupSources({ sources: [failed], sourceTemplates: [reddit] }), {
        ready: [],
        candidates: [{ kind: 'existing', source: failed, template: reddit }],
    });
    assert.deepEqual(groupSources({ sources: [], sourceTemplates: [reddit] }), {
        ready: [],
        candidates: [{ kind: 'new', template: reddit }],
    });
});
