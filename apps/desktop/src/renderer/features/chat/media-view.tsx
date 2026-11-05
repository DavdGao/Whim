import { useEffect, useState } from 'react';

import { call } from '../../lib/client';

import type { MediaBlock } from '@whimkit/core/contracts';

import {
    Attachment,
    AttachmentInfo,
    AttachmentPreview,
    Attachments,
} from '@/components/ai-elements/attachments';

/**
 * A blob URL for a stored media file, loaded from Backend and revoked on unmount.
 * @param sessionId The session.
 * @param block The media block.
 * @returns The URL once loaded.
 */
function useMediaUrl(sessionId: string, block: MediaBlock): string | undefined {
    const [url, setUrl] = useState<string>();
    const image = block.mediaType.startsWith('image/');
    useEffect(() => {
        if (!image) return;
        let created: string | undefined;
        let cancelled = false;
        call('media.read', { sessionId, sha256: block.sha256 }).then(
            data => {
                if (cancelled) return;
                created = URL.createObjectURL(
                    new Blob([new Uint8Array(data)], { type: block.mediaType })
                );
                setUrl(created);
            },
            () => undefined
        );
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [sessionId, block.sha256, block.mediaType, image]);
    return url;
}

/**
 * One stored file: an image thumbnail, or a chip with the file's name.
 * @param props Item props.
 * @param props.sessionId The session.
 * @param props.block The media block.
 * @returns The item.
 */
function MediaItem({ sessionId, block }: { sessionId: string; block: MediaBlock }) {
    const url = useMediaUrl(sessionId, block);
    return (
        <Attachment
            data={{
                id: block.id,
                type: 'file',
                mediaType: block.mediaType,
                url: url ?? '',
                ...(block.name ? { filename: block.name } : {}),
            }}
            title={block.name ?? block.id}
        >
            <AttachmentPreview />
            <AttachmentInfo />
        </Attachment>
    );
}

/**
 * Files attached to a message or returned by a tool.
 * @param props View props.
 * @param props.sessionId The session.
 * @param props.media The media blocks.
 * @param props.align Where the row sits: under a user message on the right.
 * @returns The files, or null when there are none.
 */
export function MediaView({
    sessionId,
    media,
    align = 'end',
}: {
    sessionId: string;
    media: readonly MediaBlock[];
    align?: 'start' | 'end';
}) {
    if (media.length === 0) return null;
    const images = media.filter(block => block.mediaType.startsWith('image/'));
    const files = media.filter(block => !block.mediaType.startsWith('image/'));
    return (
        <div
            className={
                align === 'end' ? 'ml-auto flex flex-col items-end gap-2' : 'flex flex-col gap-2'
            }
        >
            {images.length > 0 && (
                <Attachments variant="grid" className={align === 'start' ? 'ml-0' : undefined}>
                    {images.map(block => (
                        <MediaItem key={block.id} sessionId={sessionId} block={block} />
                    ))}
                </Attachments>
            )}
            {files.length > 0 && (
                <Attachments
                    variant="inline"
                    className={align === 'end' ? 'justify-end' : undefined}
                >
                    {files.map(block => (
                        <MediaItem key={block.id} sessionId={sessionId} block={block} />
                    ))}
                </Attachments>
            )}
        </div>
    );
}
