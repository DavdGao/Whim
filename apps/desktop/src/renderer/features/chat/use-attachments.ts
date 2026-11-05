import { useCallback, useEffect, useRef, useState } from 'react';

import { maxAttachments, maxStageBytes } from '../../../shared/ipc';
import { call, ClientError } from '../../lib/client';

import type { StagedAttachment } from '../../../shared/ipc';

/** An attachment in the composer, from pick or drop until the message is sent. */
export interface PendingAttachment {
    readonly key: string;
    readonly name: string;
    /** A local preview for images, revoked when the attachment leaves the composer. */
    readonly preview?: string;
    readonly status: 'staging' | 'ready' | 'error';
    readonly staged?: StagedAttachment;
    readonly error?: string;
}

/**
 * The composer's attachments: each file is handed to Backend once, which recognizes its type
 * and keeps it until the message is sent.
 * @returns The attachments and actions on them.
 */
export function useAttachments() {
    const [items, setItems] = useState<PendingAttachment[]>([]);
    const previews = useRef(new Set<string>());

    useEffect(() => {
        const urls = previews.current;
        return () => {
            for (const url of urls) URL.revokeObjectURL(url);
        };
    }, []);

    const update = (key: string, change: Partial<PendingAttachment>) =>
        setItems(current =>
            current.map(item => (item.key === key ? { ...item, ...change } : item))
        );

    // The latest count, for capping additions without side effects in a state updater.
    const count = useRef(0);
    useEffect(() => {
        count.current = items.length;
    }, [items]);

    const stage = useCallback(async (key: string, file: File) => {
        if (file.size > maxStageBytes) {
            update(key, { status: 'error', error: 'tooLarge' });
            return;
        }
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            const staged = await call('attachment.stage', { name: file.name || 'pasted', data });
            update(key, { status: 'ready', staged });
        } catch (error) {
            update(key, {
                status: 'error',
                error: error instanceof ClientError ? error.message : String(error),
            });
        }
    }, []);

    const add = useCallback(
        (files: readonly File[]) => {
            const added = files.slice(0, Math.max(0, maxAttachments - count.current)).map(file => {
                const preview = file.type.startsWith('image/')
                    ? URL.createObjectURL(file)
                    : undefined;
                if (preview) previews.current.add(preview);
                return {
                    file,
                    item: {
                        key: crypto.randomUUID(),
                        name: file.name || 'pasted',
                        ...(preview ? { preview } : {}),
                        status: 'staging',
                    } satisfies PendingAttachment,
                };
            });
            count.current += added.length;
            setItems(current => [...current, ...added.map(entry => entry.item)]);
            for (const { file, item } of added) void stage(item.key, file);
        },
        [stage]
    );

    const remove = useCallback((key: string) => {
        setItems(current => {
            const item = current.find(entry => entry.key === key);
            if (item?.preview) {
                URL.revokeObjectURL(item.preview);
                previews.current.delete(item.preview);
            }
            return current.filter(entry => entry.key !== key);
        });
    }, []);

    const clear = useCallback(() => {
        setItems(current => {
            for (const item of current)
                if (item.preview) {
                    URL.revokeObjectURL(item.preview);
                    previews.current.delete(item.preview);
                }
            return [];
        });
    }, []);

    return { items, add, remove, clear };
}
