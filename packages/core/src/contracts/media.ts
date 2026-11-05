/** Image types Whim recognizes from their leading bytes. */
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/**
 * Identify an image by its signature. Content decides the type; names and claimed types do not.
 * @param bytes The file's bytes.
 * @returns The image media type, or undefined.
 */
export function sniffImage(bytes: Uint8Array): (typeof imageTypes)[number] | undefined {
    const starts = (...signature: number[]) =>
        signature.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (
        starts(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    )
        return 'image/webp';
    return undefined;
}

/**
 * Decode a file as UTF-8 text when it is text: valid UTF-8 without NUL bytes.
 * @param bytes The file's bytes.
 * @returns The text, or undefined for binary content.
 */
export function decodeText(bytes: Uint8Array): string | undefined {
    if (bytes.includes(0)) return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}
