import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MediaBlock } from '../contracts/records.js';

const extensions: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'text/plain': 'txt',
    'application/pdf': 'pdf',
};

/**
 * Store bytes once in a media folder, named by their SHA-256, and describe them as a block.
 * Writing goes through a temporary file, so a reader never sees a partial file.
 * @param dir The session's media folder.
 * @param data The bytes.
 * @param mediaType Their media type.
 * @param options A display name, and decoded text for text files.
 * @param options.name The original file name.
 * @param options.text Decoded content of a text file.
 * @returns The media block.
 */
export async function storeMedia(
    dir: string,
    data: Uint8Array,
    mediaType: string,
    options: { readonly name?: string; readonly text?: string } = {}
): Promise<MediaBlock> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const path = join(dir, `${sha256}.${extensions[mediaType] ?? 'bin'}`);
    const exists = await stat(path).then(
        () => true,
        () => false
    );
    if (!exists) {
        await mkdir(dir, { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, data);
        await rename(temporary, path);
    }
    const kind = mediaType.startsWith('image/')
        ? 'img'
        : mediaType.startsWith('text/')
          ? 'txt'
          : 'file';
    return {
        type: 'media',
        id: `${kind}-${sha256.slice(0, 8)}`,
        mediaType,
        ...(options.name ? { name: options.name } : {}),
        uri: pathToFileURL(path).href,
        bytes: data.byteLength,
        sha256,
        ...(options.text !== undefined ? { text: options.text } : {}),
    };
}
