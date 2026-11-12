import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readLoginStatus, readQrCode } from './login.js';

describe('readLoginStatus', () => {
    it('tells signed in, signed out, failed and unknown answers apart', () => {
        assert.deepEqual(
            readLoginStatus({ content: '✅ 已登录\n用户名: ada\n\n你可以使用其他功能了。' }),
            {
                state: 'ready',
            }
        );
        assert.deepEqual(
            readLoginStatus({
                content: '❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。',
            }),
            {
                state: 'needs-login',
                detail: 'The Xiaohongshu account is not signed in.',
            }
        );
        assert.deepEqual(readLoginStatus({ content: '检查登录状态失败: timeout', isError: true }), {
            state: 'unavailable',
            detail: 'The Xiaohongshu server failed: 检查登录状态失败: timeout',
        });
        assert.deepEqual(readLoginStatus({ content: 'hello' }), {
            state: 'unavailable',
            detail: 'The Xiaohongshu server gave an unrecognised answer: hello',
        });
    });
});

describe('readQrCode', () => {
    it('turns the image and deadline into a QR sign-in', () => {
        const login = readQrCode({
            content: '请用小红书 App 在 2026-11-12 10:00:00 前扫码登录 👇',
            media: [{ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
        });
        assert.deepEqual(login, {
            kind: 'qr',
            image: 'data:image/png;base64,AQID',
            expiresAt: new Date('2026-11-12T10:00:00').toISOString(),
        });
    });

    it('is done when already signed in, and fails without a code', () => {
        assert.deepEqual(readQrCode({ content: '你当前已处于登录状态' }), { kind: 'done' });
        assert.throws(() => readQrCode({ content: 'x' }), /returned no sign-in code/);
        assert.throws(
            () => readQrCode({ content: 'bad', isError: true }),
            /could not make a sign-in code/
        );
    });
});
