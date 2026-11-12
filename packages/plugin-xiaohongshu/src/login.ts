import type { SourceHealth, SourceLogin, ToolOutput } from '@whimkit/core/plugin';

// xiaohongshu-mcp (https://github.com/xpzouying/xiaohongshu-mcp) answers in Chinese text; these
// functions read the two answers Whim needs: whether the account is signed in, and the QR code.

/**
 * Read the answer of `check_login_status`.
 * @param output The tool's result.
 * @returns Whether the source can run.
 */
export function readLoginStatus(output: ToolOutput): SourceHealth {
    if (output.isError)
        return { state: 'unavailable', detail: `The Xiaohongshu server failed: ${output.content}` };
    // "❌ 未登录" also contains "登录", so test it first.
    if (output.content.includes('未登录'))
        return { state: 'needs-login', detail: 'The Xiaohongshu account is not signed in.' };
    if (output.content.includes('已登录')) return { state: 'ready' };
    return {
        state: 'unavailable',
        detail: `The Xiaohongshu server gave an unrecognised answer: ${output.content.slice(0, 200)}`,
    };
}

/**
 * Read the answer of `get_login_qrcode`.
 * @param output The tool's result.
 * @returns The code to show, or done when the account is already signed in.
 */
export function readQrCode(output: ToolOutput): SourceLogin {
    if (output.isError)
        throw new Error(`The Xiaohongshu server could not make a sign-in code: ${output.content}`);
    if (output.content.includes('已处于登录状态')) return { kind: 'done' };
    const image = output.media?.find(item => item.mediaType.startsWith('image/'));
    if (!image) throw new Error('The Xiaohongshu server returned no sign-in code.');
    // "…在 2026-11-12 10:00:00 前扫码登录": local time on this machine.
    const deadline = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(output.content);
    const expires = deadline ? new Date(`${deadline[1]}T${deadline[2]}`) : undefined;
    return {
        kind: 'qr',
        image: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
        ...(expires && !Number.isNaN(expires.getTime())
            ? { expiresAt: expires.toISOString() }
            : {}),
    };
}
