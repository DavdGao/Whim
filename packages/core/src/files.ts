import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { imageSize } from 'image-size';
import { z } from 'zod';

import { ApplicationError } from './errors.js';
import { uploadSchema } from './presentation.js';

import type { SqliteStore } from './store.js';
import type { ChatModelCard, Entry } from '@whimkit/models';

/** Admit user-selected bytes, retain originals, and prepare bounded model content. */
export class FileService {
    /** Bind file operations to the sole business database.
     * @param store The authoritative artifact store.
     */
    constructor(private readonly store: SqliteStore) {}

    /** Validate content and model eligibility before persisting prepared attachment references.
     * @param files User-selected bytes, not arbitrary filesystem paths.
     * @param card The frozen session model.
     * @param signal Cancellation for parsing and admission.
     * @returns Context blocks and original-file metadata.
     */
    async prepare(
        files: z.infer<typeof uploadSchema>[],
        card: ChatModelCard,
        signal: AbortSignal
    ): Promise<Pick<Entry, 'blocks' | 'attachments'>> {
        const blocks: Entry['blocks'] = [];
        const attachments: NonNullable<Entry['attachments']> = [];
        const originals = [];
        let total = 0;
        try {
            if (files.length > 4) throw new Error('Too many attachments.');
            for (const input of files) {
                signal.throwIfAborted();
                const file = uploadSchema.parse(input);
                const bytes = Buffer.from(file.data, 'base64');
                total += bytes.length;
                if (!bytes.length || total > 10000000 || bytes.toString('base64') !== file.data)
                    throw new Error('Invalid attachment bytes.');
                let mediaType: string;
                let text: string | undefined;
                if (bytes.subarray(0, 5).toString() === '%PDF-') {
                    mediaType = 'application/pdf';
                    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), {
                        workerData: new Uint8Array(bytes),
                    });
                    try {
                        text = await new Promise<string>((resolve, reject) => {
                            const fail = () => reject(new Error('PDF parsing interrupted.'));
                            const timer = setTimeout(fail, 10000);
                            signal.addEventListener('abort', fail, { once: true });
                            worker.once('exit', () => {
                                clearTimeout(timer);
                                signal.removeEventListener('abort', fail);
                                reject(new Error('PDF parser exited.'));
                            });
                            worker.once('error', reject);
                            worker.once('message', (value: unknown) => {
                                const result = z
                                    .object({ text: z.string().optional() })
                                    .parse(value);
                                if (result.text) resolve(result.text);
                                else reject(new Error('PDF cannot be extracted within limits.'));
                            });
                            if (signal.aborted) fail();
                        });
                    } finally {
                        await worker.terminate();
                    }
                } else if (file.mediaType.startsWith('image/')) {
                    const image = imageSize(bytes);
                    const mime = image.type === 'jpg' ? 'image/jpeg' : `image/${image.type}`;
                    if (
                        !['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
                        mime !== file.mediaType ||
                        !image.width ||
                        !image.height ||
                        image.width < 28 ||
                        image.height < 28 ||
                        image.width > 3840 ||
                        image.height > 3840 ||
                        image.width * image.height > 8294400 ||
                        Math.max(image.width, image.height) / Math.min(image.width, image.height) >
                            200
                    )
                        throw new Error('Unsupported image dimensions or format.');
                    mediaType = mime;
                    const support = card.inputMedia[mediaType];
                    const route = support?.routes.find(
                        item =>
                            item.delivery === 'inline-bytes' &&
                            (!item.protocol || item.protocol === 'responses')
                    );
                    if (
                        !route ||
                        (route.maxBytes !== null && bytes.length > route.maxBytes) ||
                        (route.maxEncodedBytes != null &&
                            file.data.length + mediaType.length + 13 > route.maxEncodedBytes)
                    )
                        throw new Error('Image not supported by model.');
                } else {
                    if (
                        !['text/plain', 'text/markdown', 'application/json'].includes(
                            file.mediaType
                        )
                    )
                        throw new Error('Unsupported file format.');
                    mediaType = file.mediaType;
                    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    if (text.includes('\0') || bytes.length > 100000)
                        throw new Error('Text attachment exceeds limits.');
                }
                const id = createHash('sha256')
                    .update(file.name)
                    .update('\0')
                    .update(mediaType)
                    .update('\0')
                    .update(bytes)
                    .digest('hex');
                const artifact = { id, name: file.name, mediaType, size: bytes.length };
                attachments.push(artifact);
                originals.push({ id, name: file.name, mediaType, data: file.data });
                if (text !== undefined)
                    blocks.push({
                        type: 'text',
                        text: `<attachment name=${JSON.stringify(file.name)} media-type=${JSON.stringify(mediaType)}>\n${text}\n</attachment>`,
                    });
                else blocks.push({ type: 'image', artifact });
            }
            for (const original of originals) {
                signal.throwIfAborted();
                await this.store.putArtifact(original);
            }
            return { blocks, attachments };
        } catch (cause) {
            throw new ApplicationError(
                { category: 'invalid-input', retry: 'after-change', outcome: 'rejected' },
                { cause }
            );
        }
    }

    /** Resolve saved bytes, independent of the original file's later edits or removal.
     * @param id The artifact identity.
     * @param signal Cancellation for this model request.
     * @returns The inline provider data URI.
     */
    async image(id: string, signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        const artifact = await this.store.getArtifact(id);
        signal.throwIfAborted();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType))
            throw new Error('Artifact is not an image.');
        return `data:${artifact.mediaType};base64,${artifact.data}`;
    }
}
