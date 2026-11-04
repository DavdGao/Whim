export const card = {
    kind: 'chat',
    id: 'fixture-chat',
    revision: 1,
    provider: 'fixture',
    adapterId: 'fixture',
    modelId: 'fixture-chat',
    label: 'Deterministic text fixture',
    inputMedia: {
        'text/plain': { routes: [{ delivery: 'text', maxBytes: 100000 }] },
    },
    outputMedia: { 'text/plain': 'supported' },
    contextTokens: 16000,
    maxOutputTokens: 2000,
    capabilities: {
        streaming: true,
        tools: false,
        structuredOutput: false,
        thinking: false,
        webSearch: false,
        webFetch: false,
    },
    requestLimits: { maxAttachments: null, maxAttachmentBytes: null, maxRequestBytes: 100000 },
};
