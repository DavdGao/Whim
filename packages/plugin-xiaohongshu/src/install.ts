import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const connector = {
    version: '2.7.4',
    url: 'https://github.com/xpzouying/xiaohongshu-mcp/releases/download/v2.7.4/xiaohongshu-mcp-darwin-arm64',
    sha256: '8e0194952251f6da2e2911bbc30934abec760b8eaa9ee811b0d0358656435673',
    size: 16851250,
};

/**
 * Download a bounded, pinned executable and publish it only after verifying its digest.
 * @param directory Private installation directory.
 * @param artifact Pinned release metadata.
 * @param signal Stops downloading when the launcher closes.
 * @returns The verified executable path.
 */
export async function installExecutable(
    directory: string,
    artifact: typeof connector,
    signal: AbortSignal
): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `connector-${artifact.version}`);
    try {
        const existing = await readFile(target);
        if (
            existing.length === artifact.size &&
            createHash('sha256').update(existing).digest('hex') === artifact.sha256
        ) {
            await chmod(target, 0o700);
            return target;
        }
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const response = await fetch(artifact.url, { signal });
    if (!response.ok || !response.body)
        throw new Error(`Connector download failed (HTTP ${response.status}).`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > artifact.size)
            throw new Error('Connector download exceeds its verified release size.');
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
        size !== artifact.size ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
        throw new Error('Connector download failed integrity verification.');
    signal.throwIfAborted();
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        await writeFile(temporary, bytes, { mode: 0o700 });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
    return target;
}
