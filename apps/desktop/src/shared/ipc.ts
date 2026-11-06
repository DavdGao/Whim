import { idSchema, thinkingLevelSchema } from '@whimkit/core/contracts';
import { z } from 'zod';

import { localeSchema } from './main-protocol.js';

import type { Locale } from './main-protocol.js';
import type {
    AgentRecord,
    Card,
    Failure,
    HistoryEntry,
    PendingDelivery,
    SessionView,
    ThinkingLevel,
} from '@whimkit/core/contracts';

export { localeSchema };
export type { Locale };

export const chatSlotSchema = z.strictObject({
    credentialId: idSchema,
    cardId: idSchema,
    thinking: thinkingLevelSchema.optional(),
});
export type ChatSlot = z.infer<typeof chatSlotSchema>;

/** How permission asks are answered: by the user, or by a reviewer model first. */
export const permissionSettingsSchema = z.strictObject({
    mode: z.enum(['manual', 'auto']),
    /** The `reviewer` slot: a Chat or Decision card and a credential it accepts. */
    reviewer: z.strictObject({ credentialId: idSchema, cardId: idSchema }).optional(),
});
export type PermissionSettings = z.infer<typeof permissionSettingsSchema>;

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

/** What every agent calls the user; null clears it. */
export const userNameSchema = z.string().trim().min(1).max(60).nullable();

/** Branch and uncommitted line counts of a folder's git repository. */
export interface GitStatus {
    /** Branch name, or the short commit when HEAD is detached. */
    readonly head: string;
    readonly insertions: number;
    readonly deletions: number;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const maxAttachments = 10;
/** No file the app can deliver is larger; bigger ones are refused before reading. */
export const maxStageBytes = 20 * 1024 * 1024;

/** A staged attachment: its content hash and the type Backend recognized. */
export interface StagedAttachment {
    readonly sha256: string;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: number;
}

/** Parameters of every Renderer → Backend method; validated in Backend. */
export const methodSchemas = {
    'app.state': z.strictObject({}),
    'settings.locale': z.strictObject({ locale: localeSchema }),
    'settings.resumeAfterRestart': z.strictObject({ enabled: z.boolean() }),
    'settings.chatSlot': z.strictObject({ slot: chatSlotSchema }),
    'settings.permissions': z.strictObject({ permissions: permissionSettingsSchema }),
    'settings.agent': z.strictObject({ profile: agentProfileSchema.nullable() }),
    'settings.userName': z.strictObject({ name: userNameSchema }),
    /** A theme id from `AppState.themes`, or null for the default look. */
    'settings.theme': z.strictObject({ theme: z.string().min(1).max(400).nullable() }),
    'credentials.save': z.strictObject({
        id: idSchema.optional(),
        typeId: idSchema,
        label: z.string().trim().min(1).max(200),
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    'credentials.remove': z.strictObject({ id: idSchema }),
    'catalog.reload': z.strictObject({}),
    'plugins.setEnabled': z.strictObject({ id: idSchema, enabled: z.boolean() }),
    /** A plugin client entry calls its own plugin's method (design.md §5.7). */
    'plugin.call': z.strictObject({
        pluginId: idSchema,
        method: z.string().min(1).max(200),
        input: z.unknown(),
    }),
    /** The latest value of every plugin topic; changes follow as `plugin.topic` events. */
    'plugin.topics': z.strictObject({}),
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
    'session.send': z
        .strictObject({
            sessionId: idSchema,
            text: z.string().trim().max(200_000),
            /** Staged attachments by content hash, in the order the user added them. */
            attachments: z
                .array(z.strictObject({ sha256: sha256Schema, name: z.string().max(500) }))
                .max(maxAttachments)
                .default([]),
        })
        .refine(value => value.text.length > 0 || value.attachments.length > 0, {
            message: 'A message needs text or an attachment.',
        }),
    /** Hand over a file the user picked, dropped, or pasted; Backend checks and keeps it. */
    'attachment.stage': z.strictObject({
        name: z.string().min(1).max(500),
        data: z.instanceof(Uint8Array).refine(data => data.byteLength <= maxStageBytes, {
            message: 'The file is too large.',
        }),
    }),
    /** Bytes of a stored media file, for display. */
    'media.read': z.strictObject({ sessionId: idSchema, sha256: sha256Schema }),
    'session.stop': z.strictObject({ sessionId: idSchema }),
    /** An earlier page of a session's history, before the oldest entry the renderer holds. */
    'session.history': z.strictObject({
        sessionId: idSchema,
        beforeSeq: z.number().int().positive(),
        limit: z.number().int().min(1).max(200),
    }),
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
    'session.setWorkspace': z.strictObject({
        sessionId: idSchema,
        workspace: z.string().min(1).max(4096),
    }),
    'workspace.git': z.strictObject({ path: z.string().min(1).max(4096) }),
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
    /** What the manifest declares the plugin registers, shown before it is enabled. */
    readonly contributes: Readonly<Record<ContributionKind, readonly string[]>>;
    /** The client entry's URLs, while the plugin is active and has one. */
    readonly client?: { readonly entry: string; readonly style?: string };
}

export type ContributionKind =
    | 'credentialTypes'
    | 'adapters'
    | 'tools'
    | 'services'
    | 'methods'
    | 'topics'
    | 'pages'
    | 'settingsSections'
    | 'chatTools'
    | 'composerActions';

export interface CredentialTypeInfo {
    readonly id: string;
    readonly pluginId: string;
    readonly schema: Readonly<Record<string, unknown>>;
}

export interface AdapterInfo {
    readonly id: string;
    readonly kind: 'chat' | 'decision';
    readonly pluginId: string;
    readonly credentialTypes: readonly string[];
}

export interface CatalogEntryInfo {
    readonly id: string;
    readonly layer: 'upstream' | 'patched' | 'user';
    readonly pluginId?: string;
    readonly files: readonly string[];
    readonly hidden: boolean;
    readonly card?: Card;
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

/** A plugin theme: token values to apply, and an optional background image URL. */
export interface ThemeInfo {
    /** `<pluginId>#<themeId>`. */
    readonly id: string;
    readonly pluginId: string;
    /** A key in the plugin's locale catalogs. */
    readonly name: string;
    readonly light: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
    readonly image?: string;
}

export interface AppState {
    readonly locale: Locale;
    readonly notices: readonly StartupNotice[];
    readonly resumeAfterRestart: boolean;
    /** What agents call the user, when set. */
    readonly userName?: string;
    /** The effective profile, and whether it is the default. */
    readonly agent: AgentProfile & { readonly isDefault: boolean };
    readonly chatSlot?: ChatSlot;
    readonly permissions: PermissionSettings;
    readonly userCardsDir: string;
    /** The folder a new chat works in when the user picks none. */
    /** Names of the built-in tools every agent has. */
    readonly baseTools: readonly string[];
    readonly plugins: readonly PluginInfo[];
    /** Themes of active plugins (design.md §5.7). */
    readonly themes: readonly ThemeInfo[];
    /** The chosen theme's id, while it is available; the default look otherwise. */
    readonly theme?: string;
    readonly credentialTypes: readonly CredentialTypeInfo[];
    readonly adapters: readonly AdapterInfo[];
    readonly catalog: readonly CatalogEntryInfo[];
    readonly credentials: readonly CredentialInfo[];
    readonly sessions: readonly SessionInfo[];
}

/** A session view with the inbox as an array, safe to copy across context bridges. */
export type SessionSnapshot = Omit<SessionView, 'inbox'> & {
    readonly pending: readonly PendingDelivery[];
    /** The session's own working folder, used while the user has chosen none. */
    readonly defaultWorkspace: string;
    /** Whether `history` holds only the latest page; older entries load on request. */
    readonly hasOlder: boolean;
};

/** One page of earlier history. */
export interface HistoryPage {
    readonly entries: readonly HistoryEntry[];
    readonly hasOlder: boolean;
}

export interface Results {
    'app.state': AppState;
    'settings.locale': null;
    'settings.resumeAfterRestart': null;
    'settings.chatSlot': null;
    'settings.permissions': null;
    'settings.agent': null;
    'settings.userName': null;
    'settings.theme': null;
    'credentials.save': { id: string };
    'credentials.remove': null;
    'catalog.reload': null;
    'plugins.setEnabled': null;
    'plugin.call': unknown;
    'plugin.topics': readonly PluginTopicValue[];
    'session.get': SessionSnapshot;
    'session.create': { sessionId: string };
    'session.decide': null;
    'session.send': { deliveryId: string };
    'session.history': HistoryPage;
    'attachment.stage': StagedAttachment;
    'media.read': Uint8Array;
    'session.stop': null;
    'session.pin': null;
    'session.delete': null;
    'session.continue': null;
    'session.withdraw': null;
    'session.setThinking': null;
    'session.switchModel': null;
    'session.rename': null;
    'session.setWorkspace': null;
    'workspace.git': GitStatus | null;
}

/** Errors crossing IPC: a code for the UI, a message, optional field issues or failure. */
export interface IpcError {
    readonly code: 'invalid' | 'conflict' | 'not-found' | 'unavailable' | 'internal';
    readonly message: string;
    readonly issues?: readonly { path: string; message: string }[];
    readonly failure?: Failure;
}

/** A plugin topic's latest value; `seq` grows with every change. */
export interface PluginTopicValue {
    readonly pluginId: string;
    readonly name: string;
    readonly seq: number;
    readonly value: unknown;
}

/** Backend → Renderer events. */
export type BackendEvent =
    | { readonly type: 'state' }
    | ({ readonly type: 'plugin.topic' } & PluginTopicValue)
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
