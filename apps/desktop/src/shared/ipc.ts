import { idSchema, thinkingLevelSchema } from '@whimkit/core/contracts';
import { z } from 'zod';

import type {
    AgentRecord,
    ChatCard,
    Failure,
    PendingDelivery,
    SessionView,
    ThinkingLevel,
} from '@whimkit/core/contracts';

export const localeSchema = z.enum(['en', 'zh-CN']);
export type Locale = z.infer<typeof localeSchema>;

export const chatSlotSchema = z.strictObject({
    credentialId: idSchema,
    cardId: idSchema,
    thinking: thinkingLevelSchema.optional(),
});
export type ChatSlot = z.infer<typeof chatSlotSchema>;

/** The agent's identity; applies to epochs started after a change. */
export const agentProfileSchema = z.strictObject({
    name: z.string().trim().min(1).max(60),
    systemPrompt: z.string().trim().min(1).max(20_000),
    /** A small image as a `data:` URL; absent for the default icon. */
    icon: z
        .string()
        .max(300_000)
        .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,/)
        .optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** Parameters of every Renderer → Backend method; validated in Backend. */
export const methodSchemas = {
    'app.state': z.strictObject({}),
    'settings.locale': z.strictObject({ locale: localeSchema }),
    'settings.resumeAfterRestart': z.strictObject({ enabled: z.boolean() }),
    'settings.chatSlot': z.strictObject({ slot: chatSlotSchema }),
    'settings.agent': z.strictObject({ profile: agentProfileSchema.nullable() }),
    'credentials.save': z.strictObject({
        id: idSchema.optional(),
        typeId: idSchema,
        label: z.string().trim().min(1).max(200),
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    'credentials.remove': z.strictObject({ id: idSchema }),
    'catalog.reload': z.strictObject({}),
    'plugins.setEnabled': z.strictObject({ id: idSchema, enabled: z.boolean() }),
    'session.get': z.strictObject({ sessionId: idSchema }),
    'session.create': z.strictObject({
        slot: chatSlotSchema,
        workspace: z.string().min(1).max(4096).optional(),
    }),
    'session.decide': z.strictObject({
        sessionId: idSchema,
        callId: idSchema,
        decision: z.enum(['allow', 'deny']),
        scope: z.enum(['once', 'session']),
    }),
    'session.send': z.strictObject({
        sessionId: idSchema,
        text: z.string().trim().min(1).max(200_000),
    }),
    'session.stop': z.strictObject({ sessionId: idSchema }),
    'session.pin': z.strictObject({ sessionId: idSchema, pinned: z.boolean() }),
    'session.delete': z.strictObject({ sessionId: idSchema }),
    'session.continue': z.strictObject({ sessionId: idSchema }),
    'session.withdraw': z.strictObject({ sessionId: idSchema, deliveryId: idSchema }),
    'session.setThinking': z.strictObject({ sessionId: idSchema, thinking: thinkingLevelSchema }),
    'session.switchModel': z.strictObject({
        sessionId: idSchema,
        cardId: idSchema,
        credentialId: idSchema,
    }),
    'session.rename': z.strictObject({
        sessionId: idSchema,
        title: z.string().trim().min(1).max(200),
    }),
} as const;
export type Method = keyof typeof methodSchemas;
export type Params<M extends Method> = z.input<(typeof methodSchemas)[M]>;

export interface PluginInfo {
    readonly id: string;
    readonly version: string;
    readonly source: 'bundled' | 'local';
    readonly installedAt: string;
    readonly enabled: boolean;
    readonly availability: string;
    readonly error?: string;
    readonly locales: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** Plugin logo as a `data:` URL. */
    readonly icon?: string;
    /** Named card icons as `data:` URLs. */
    readonly icons: Readonly<Record<string, string>>;
    readonly category: 'models' | 'tools' | 'other';
    /** What the plugin registered: model adapters, credential types, and tool names. */
    readonly adapters: number;
    readonly credentialTypes: number;
    readonly tools: readonly string[];
}

export interface CredentialTypeInfo {
    readonly id: string;
    readonly pluginId: string;
    readonly schema: Readonly<Record<string, unknown>>;
}

export interface AdapterInfo {
    readonly id: string;
    readonly pluginId: string;
    readonly credentialTypes: readonly string[];
}

export interface CatalogEntryInfo {
    readonly id: string;
    readonly layer: 'upstream' | 'patched' | 'user';
    readonly pluginId?: string;
    readonly files: readonly string[];
    readonly hidden: boolean;
    readonly card?: ChatCard;
    readonly issues: readonly string[];
}

export interface CredentialInfo {
    readonly id: string;
    readonly typeId: string;
    readonly label: string;
    readonly values: Readonly<Record<string, unknown>>;
    readonly secretsSet: readonly string[];
    readonly createdAt: string;
    readonly available: boolean;
}

export interface SessionInfo {
    readonly sessionId: string;
    readonly title: string;
    readonly cardId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly running: boolean;
    readonly pinned: boolean;
}

/** One-time startup events the user should know about. */
export type StartupNotice = { readonly kind: 'database-moved'; readonly path: string };

export interface AppState {
    readonly locale: Locale;
    readonly notices: readonly StartupNotice[];
    readonly resumeAfterRestart: boolean;
    /** The effective profile, and whether it is the default. */
    readonly agent: AgentProfile & { readonly isDefault: boolean };
    readonly chatSlot?: ChatSlot;
    readonly userCardsDir: string;
    /** The folder a new chat works in when the user picks none. */
    readonly defaultWorkspace: string;
    /** Names of the built-in tools every agent has. */
    readonly baseTools: readonly string[];
    readonly plugins: readonly PluginInfo[];
    readonly credentialTypes: readonly CredentialTypeInfo[];
    readonly adapters: readonly AdapterInfo[];
    readonly catalog: readonly CatalogEntryInfo[];
    readonly credentials: readonly CredentialInfo[];
    readonly sessions: readonly SessionInfo[];
}

/** A session view with the inbox as an array, safe to copy across context bridges. */
export type SessionSnapshot = Omit<SessionView, 'inbox'> & {
    readonly pending: readonly PendingDelivery[];
};

export interface Results {
    'app.state': AppState;
    'settings.locale': null;
    'settings.resumeAfterRestart': null;
    'settings.chatSlot': null;
    'settings.agent': null;
    'credentials.save': { id: string };
    'credentials.remove': null;
    'catalog.reload': null;
    'plugins.setEnabled': null;
    'session.get': SessionSnapshot;
    'session.create': { sessionId: string };
    'session.decide': null;
    'session.send': { deliveryId: string };
    'session.stop': null;
    'session.pin': null;
    'session.delete': null;
    'session.continue': null;
    'session.withdraw': null;
    'session.setThinking': null;
    'session.switchModel': null;
    'session.rename': null;
}

/** Errors crossing IPC: a code for the UI, a message, optional field issues or failure. */
export interface IpcError {
    readonly code: 'invalid' | 'conflict' | 'not-found' | 'unavailable' | 'internal';
    readonly message: string;
    readonly issues?: readonly { path: string; message: string }[];
    readonly failure?: Failure;
}

/** Backend → Renderer events. */
export type BackendEvent =
    | { readonly type: 'state' }
    | {
          readonly type: 'records';
          readonly sessionId: string;
          readonly records: readonly AgentRecord[];
      }
    | {
          readonly type: 'stream';
          readonly sessionId: string;
          readonly attemptId: string;
          readonly part: 'text' | 'reasoning';
          readonly text: string;
      }
    | {
          readonly type: 'discarded';
          readonly sessionId: string;
          readonly attemptId: string;
          readonly failure: Failure;
      };

export const requestEnvelopeSchema = z.strictObject({
    kind: z.literal('request'),
    id: z.number().int().nonnegative(),
    method: z.string(),
    params: z.unknown(),
});

export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        kind: z.literal('response'),
        id: z.number().int(),
        ok: z.literal(true),
        value: z.unknown(),
    }),
    z.strictObject({
        kind: z.literal('response'),
        id: z.number().int(),
        ok: z.literal(false),
        error: z.looseObject({ code: z.string(), message: z.string() }),
    }),
]);

export const eventEnvelopeSchema = z.strictObject({
    kind: z.literal('event'),
    event: z.looseObject({ type: z.enum(['state', 'records', 'stream', 'discarded']) }),
});

export type { ThinkingLevel };
