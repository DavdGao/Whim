import {
    chatModelCardSchema,
    entrySchema,
    thinkingLevelSchema,
    tokenUsageSchema,
} from '@whimkit/models';
import { z } from 'zod';

import { failureSchema } from './errors.js';

export const transcriptSchema = z.object({
    sessionId: z.string(),
    head: z.string(),
    card: chatModelCardSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    messages: z.array(entrySchema),
    beforeId: z.string().optional(),
    pending: z.array(entrySchema),
    draft: entrySchema.optional(),
    outcome: z.enum(['running', 'completed', 'interrupted', 'failed']).optional(),
    usage: tokenUsageSchema,
    failure: failureSchema.optional(),
});
export type TranscriptPage = z.infer<typeof transcriptSchema>;
export const artifactSchema = z.object({
    id: z.string(),
    name: z.string().max(255),
    mediaType: z.string(),
    data: z.string().max(13333336),
});

export const uploadSchema = z.strictObject({
    name: z.string().min(1).max(255),
    mediaType: z.string().max(100),
    data: z.string().max(13333336),
});
