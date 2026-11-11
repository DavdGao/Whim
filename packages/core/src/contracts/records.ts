import { z } from 'zod';

import { frozenChatCardSchema, idSchema, thinkingLevelSchema } from './card.js';
import { failureSchema } from './failure.js';

export const textBlockSchema = z.strictObject({ type: z.literal('text'), text: z.string() });
export const reasoningBlockSchema = z.strictObject({
    type: z.literal('reasoning'),
    text: z.string(),
    /** Wall time from the first reasoning delta to the first answer delta or the attempt's end. */
    durationMs: z.number().int().nonnegative().optional(),
});
/** Opaque provider state replayed only through the adapter that produced it. */
export const continuationBlockSchema = z.strictObject({
    type: z.literal('continuation'),
    adapter: idSchema,
    format: z.number().int().positive(),
    data: z.unknown(),
});
/** A complete function call; `arguments` is the provider's exact JSON text, kept for replay. */
export const toolCallBlockSchema = z.strictObject({
    type: z.literal('tool_call'),
    callId: idSchema,
    name: z.string().min(1).max(200),
    arguments: z.string(),
});
/** A call the provider executed itself; Core shows and replays it but never runs it. */
export const nativeToolCallBlockSchema = z.strictObject({
    type: z.literal('native_tool_call'),
    adapter: idSchema,
    format: z.number().int().positive(),
    /** Standard id (`web_search`, `web_fetch`) or a plugin-namespaced id. */
    tool: z.string().min(1).max(200),
    status: z.enum(['completed', 'failed']),
    query: z.string().optional(),
    urls: z.array(z.string()).optional(),
    data: z.unknown(),
});
/**
 * A file the user attached or a tool returned, stored once under the session's `media/` folder.
 * Text files keep their decoded content here, so replay never re-reads the file; other media
 * are read from `uri` when a request is prepared.
 */
export const mediaBlockSchema = z.strictObject({
    type: z.literal('media'),
    /** Stable, model-facing identifier, such as `img-3f9a2c1b`. */
    id: z.string().min(1).max(64),
    mediaType: z.string().min(1).max(200),
    name: z.string().max(500).optional(),
    /** `file:` URI of the stored bytes. */
    uri: z.string().startsWith('file:'),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Decoded content of a text file. */
    text: z.string().optional(),
});
export type MediaBlock = z.infer<typeof mediaBlockSchema>;

export const blockSchema = z.discriminatedUnion('type', [
    textBlockSchema,
    mediaBlockSchema,
    reasoningBlockSchema,
    continuationBlockSchema,
    toolCallBlockSchema,
    nativeToolCallBlockSchema,
]);
export type Block = z.infer<typeof blockSchema>;
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;
export type NativeToolCallBlock = z.infer<typeof nativeToolCallBlockSchema>;

export const messageSchema = z.strictObject({
    type: z.literal('message'),
    id: idSchema,
    role: z.enum(['user', 'assistant']),
    blocks: z.array(blockSchema),
});
export type Message = z.infer<typeof messageSchema>;

export const noticeOriginSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('core'), service: z.string().min(1) }),
    z.strictObject({ type: z.literal('plugin'), pluginId: idSchema }),
    z.strictObject({ type: z.literal('user') }),
]);

const noticeBase = {
    type: z.literal('notice'),
    id: idSchema,
    origin: noticeOriginSchema,
    observedAt: z.iso.datetime(),
};

/** Core notice kinds; each kind owns a typed payload. */
export const noticeSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        ...noticeBase,
        kind: z.literal('interrupted'),
        payload: z.strictObject({
            runId: idSchema,
            reason: z.enum(['user', 'plugin-removed']),
        }),
    }),
    z.strictObject({
        ...noticeBase,
        kind: z.literal('restarted'),
        payload: z.strictObject({ runId: idSchema }),
    }),
    z.strictObject({
        ...noticeBase,
        kind: z.literal('job-finished'),
        payload: z.strictObject({
            jobId: idSchema,
            callId: idSchema,
            tool: z.string(),
            status: z.enum(['completed', 'failed', 'cancelled']),
        }),
        /** Output tail, already bounded. */
        text: z.string(),
    }),
    z.strictObject({
        ...noticeBase,
        kind: z.literal('job-lost'),
        payload: z.strictObject({ jobId: idSchema, callId: idSchema, tool: z.string() }),
    }),
    /** A schedule of the session fired (design.md §4.1.1); `text` is its message. */
    z.strictObject({
        ...noticeBase,
        kind: z.literal('schedule-fired'),
        payload: z.strictObject({
            scheduleId: idSchema,
            name: z.string(),
            /** The time it was due, which is earlier than `observedAt` when it fired late. */
            dueAt: z.iso.datetime(),
            /** It was due while Whim was not running or the Mac was asleep. */
            late: z.boolean(),
        }),
        text: z.string(),
    }),
    /** The user moved the chat to another folder between runs. */
    z.strictObject({
        ...noticeBase,
        kind: z.literal('workspace-changed'),
        payload: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }),
    }),
]);
export type Notice = z.infer<typeof noticeSchema>;

export const toolResultStatusSchema = z.enum([
    'success',
    'error',
    'denied',
    'cancelled',
    'background',
    'lost',
]);

/** The one result of a tool call. */
/** A file's version as a tool observed it: enough to tell whether it changed since. */
export const fileVersionSchema = z.strictObject({
    path: z.string().min(1),
    mtimeMs: z.number().nonnegative(),
    size: z.number().int().nonnegative(),
});
export type FileVersion = z.infer<typeof fileVersionSchema>;

export const toolResultSchema = z.strictObject({
    type: z.literal('tool_result'),
    id: idSchema,
    callId: idSchema,
    name: z.string(),
    status: toolResultStatusSchema,
    content: z.string(),
    jobId: idSchema.optional(),
    /** Where the full output was written when `content` is a preview. */
    offload: z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative() }).optional(),
    /** Images or other media the tool returned alongside its text. */
    media: z.array(mediaBlockSchema).optional(),
    /** Files the call read or wrote, as they were afterwards; Edit and Write check against them. */
    files: z.array(fileVersionSchema).optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const contextItemSchema = z.union([messageSchema, noticeSchema, toolResultSchema]);
export type ContextItem = z.infer<typeof contextItemSchema>;

export const usageSchema = z.strictObject({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const assistantOutputSchema = z.strictObject({
    messageId: idSchema,
    blocks: z.array(blockSchema),
});
export type AssistantOutput = z.infer<typeof assistantOutputSchema>;

/** What a tool call touches; permissions are decided from it. Paths are absolute. */
export const accessSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['read', 'write']), path: z.string().min(1) }),
    z.strictObject({ kind: z.literal('execute'), command: z.string() }),
    z.strictObject({ kind: z.literal('network'), url: z.string() }),
    /** A tool of an MCP server the user has not trusted (design.md §7.7). */
    z.strictObject({ kind: z.literal('mcp'), server: z.string(), tool: z.string() }),
]);
export type Access = z.infer<typeof accessSchema>;

/** What an automatic review concluded. */
export const reviewOutcomeSchema = z.enum(['allow', 'deny', 'ask']);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/** A session-scoped permission grant. */
export const permissionRuleSchema = z.strictObject({
    tool: z.string(),
    kind: z.enum(['read', 'write', 'execute', 'network', 'mcp']),
    /** Path prefix, command word, host, or `<server>/<tool>`. */
    pattern: z.string(),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/** A tool as declared to the model, frozen in the epoch. */
export const toolDeclarationSchema = z.strictObject({
    name: z.string().min(1).max(64),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

/**
 * What a compacted epoch's requests start from: a summary of everything before `from`, whose
 * full text was written to `transcript` (a `file:` URI) before the epoch was committed.
 */
export const epochContextSchema = z.strictObject({
    summary: z.string(),
    /** History entries with a smaller sequence number are covered by the summary. */
    from: z.number().int().positive(),
    transcript: z.string().startsWith('file:'),
    /** The latest user message, kept verbatim although it is older than `from`. */
    input: z.number().int().positive().optional(),
});
export type EpochContext = z.infer<typeof epochContextSchema>;

export const placementSchema = z.enum(['next-step', 'next-run']);
export const interruptReasonSchema = z.enum(['user', 'shutdown', 'crash', 'plugin-removed']);

export const attemptResultSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('completed'), output: assistantOutputSchema }),
    z.strictObject({ status: z.literal('interrupted'), output: assistantOutputSchema }),
    z.strictObject({ status: z.literal('failed'), failure: failureSchema }),
]);

export const runResultSchema = z.discriminatedUnion('outcome', [
    z.strictObject({ outcome: z.literal('completed') }),
    z.strictObject({ outcome: z.literal('interrupted'), reason: interruptReasonSchema }),
    z.strictObject({ outcome: z.literal('failed'), failure: failureSchema }),
]);

/** Every fact the journal can hold. Bodies are versioned through the record envelope. */
export const bodySchema = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('session.created'),
        title: z.string().max(200),
        credentialId: idSchema,
        thinking: thinkingLevelSchema.optional(),
        workspace: z.string().min(1).optional(),
    }),
    z.strictObject({
        type: z.literal('session.updated'),
        title: z.string().max(200).optional(),
        credentialId: idSchema.optional(),
        thinking: thinkingLevelSchema.nullable().optional(),
        workspace: z.string().min(1).optional(),
    }),
    z.strictObject({
        type: z.literal('epoch.started'),
        epochId: idSchema,
        reason: z.enum(['initial', 'model-switch', 'compaction']),
        system: z.string(),
        card: frozenChatCardSchema,
        renderer: z.number().int().positive(),
        tools: z.array(toolDeclarationSchema).default([]),
        nativeTools: z.array(z.string()).default([]),
        /** Standard tool ids the adapter runs as separate provider calls. */
        providerTools: z.array(z.string()).default([]),
        /** Set once the session was compacted; model switches carry it forward. */
        context: epochContextSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('compaction.started'),
        compactionId: idSchema,
        runId: idSchema,
    }),
    /** One summary request; its usage counts in the session's usage, not its context. */
    z.strictObject({
        type: z.literal('compaction.attempted'),
        compactionId: idSchema,
        usage: usageSchema,
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('compaction.finished'),
        compactionId: idSchema,
        outcome: z.enum(['succeeded', 'failed']),
        /** Usage of the summary call in records written before `compaction.attempted` existed. */
        usage: usageSchema.optional(),
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('delivery.accepted'),
        deliveryId: idSchema,
        placement: placementSchema,
        item: contextItemSchema,
    }),
    z.strictObject({ type: z.literal('delivery.withdrawn'), deliveryId: idSchema }),
    z.strictObject({
        type: z.literal('run.started'),
        runId: idSchema,
        trigger: z.enum(['user', 'continue', 'restart', 'job', 'schedule']),
    }),
    z.strictObject({
        type: z.literal('step.prepared'),
        runId: idSchema,
        stepId: idSchema,
        consumed: z.array(idSchema),
    }),
    z.strictObject({
        type: z.literal('attempt.started'),
        runId: idSchema,
        stepId: idSchema,
        attemptId: idSchema,
        number: z.number().int().positive(),
    }),
    z.strictObject({
        type: z.literal('attempt.finished'),
        attemptId: idSchema,
        usage: usageSchema,
        result: attemptResultSchema,
    }),
    z.strictObject({
        type: z.literal('retry.scheduled'),
        runId: idSchema,
        stepId: idSchema,
        number: z.number().int().positive(),
        at: z.iso.datetime(),
        failure: failureSchema,
    }),
    z.strictObject({
        type: z.literal('interrupt.requested'),
        runId: idSchema,
        reason: interruptReasonSchema,
    }),
    z.strictObject({
        type: z.literal('run.ended'),
        runId: idSchema,
        result: runResultSchema,
    }),
    z.strictObject({
        type: z.literal('permission.requested'),
        runId: idSchema,
        callId: idSchema,
        name: z.string(),
        access: z.array(accessSchema),
        /** Present when the reviewer answers before the user (auto mode). */
        reviewer: z.strictObject({ cardId: idSchema }).optional(),
    }),
    /**
     * The reviewer's answer. `allow` and `deny` settle the call for this call only; `ask`, and a
     * failed review, leave it waiting for the user.
     */
    z.strictObject({
        type: z.literal('permission.reviewed'),
        runId: idSchema,
        callId: idSchema,
        outcome: reviewOutcomeSchema,
        /** Why, for the user and, on a denial, the model. Bounded. */
        reason: z.string().max(2000),
        /** Counted in the session's usage, not its context. */
        usage: usageSchema,
        failure: failureSchema.optional(),
    }),
    z.strictObject({
        type: z.literal('permission.decided'),
        runId: idSchema,
        callId: idSchema,
        decision: z.enum(['allow', 'deny']),
        scope: z.enum(['once', 'session']),
        /** Rules granted for the rest of the session when `scope` is `session`. */
        rules: z.array(permissionRuleSchema).default([]),
    }),
    z.strictObject({
        type: z.literal('tool.started'),
        runId: idSchema,
        callId: idSchema,
        jobId: idSchema,
    }),
    z.strictObject({ type: z.literal('tool.finished'), result: toolResultSchema }),
    /** Tokens of a provider call a tool made; counted in the session's usage, not its context. */
    z.strictObject({ type: z.literal('tool.usage'), callId: idSchema, usage: usageSchema }),
    z.strictObject({
        type: z.literal('job.ended'),
        jobId: idSchema,
        status: z.enum(['completed', 'failed', 'cancelled', 'lost']),
    }),
]);
export type Body = z.infer<typeof bodySchema>;
export type BodyOf<T extends Body['type']> = Extract<Body, { type: T }>;

export const recordSchema = z.strictObject({
    id: idSchema,
    sessionId: idSchema,
    seq: z.number().int().positive(),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    operationId: idSchema,
    body: bodySchema,
});
export type AgentRecord = z.infer<typeof recordSchema>;
