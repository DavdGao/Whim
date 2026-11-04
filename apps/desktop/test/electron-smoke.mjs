import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { _electron as electron } from '@playwright/test';
import { prepareNative } from '../prepare-native.mjs';

const nativeBinding = await prepareNative();
const directory = await mkdtemp(join(tmpdir(), 'whim-electron-'));
let app;
try {
    const startupAt = performance.now();
    app = await electron.launch({
        args: ['.'],
        env: { ...process.env, WHIM_DATA_DIR: directory, WHIM_SQLITE_BINDING: nativeBinding },
    });
    app.process().stderr.on('data', data => process.stderr.write(data));
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => {
        errors.push(error.message);
        process.stderr.write(`${error.message}\n`);
    });
    await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
    process.stdout.write(`Startup to ready UI: ${Math.round(performance.now() - startupAt)} ms\n`);
    await page.getByRole('combobox', { name: 'Thinking' }).click();
    await page.getByRole('option', { name: 'Off', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option', { name: '简体中文' }).click();
    await page.getByRole('heading', { name: '现在，你在想什么？' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '现在，你在想什么？' }).waitFor();
    await page.getByRole('combobox', { name: '语言' }).click();
    await page.getByRole('option', { name: 'English' }).click();
    if (!process.env.DASHSCOPE_API_KEY)
        throw new Error(
            'Live Electron smoke requires DASHSCOPE_API_KEY; no live pass can be claimed.'
        );
    await page
        .getByRole('textbox', { name: 'Write a message…' })
        .fill('Reply with exactly WHIM_DESKTOP_OK.');
    await page.getByRole('textbox', { name: 'Write a message…' }).press('Enter');
    await page
        .locator('.message.assistant')
        .filter({ hasText: 'WHIM_DESKTOP_OK' })
        .first()
        .waitFor({ timeout: 90000 });
    await page
        .getByRole('button', { name: 'Stop response' })
        .waitFor({ state: 'hidden', timeout: 90000 });
    await page.screenshot({ path: '/tmp/whim-desktop-chat.png' });
    await page
        .getByRole('textbox', { name: 'Write a message…' })
        .fill(
            'Write a long numbered list of 200 ideas for creative hobbies. Include one sentence per idea.'
        );
    await page.getByRole('textbox', { name: 'Write a message…' }).press('Enter');
    await page.getByRole('button', { name: 'Stop response' }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).first().click();
    await page.locator('.conversation').last().click();
    assert.equal(await page.getByRole('log').count(), 1);
    await page.waitForFunction(
        () =>
            [...globalThis.document.querySelectorAll('.message.assistant .message-text')].at(-1)
                ?.textContent.length > 30,
        undefined,
        { timeout: 90000 }
    );
    const stopAt = performance.now();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.getByText('Interrupted', { exact: true }).waitFor();
    process.stdout.write(`Stop to settled UI: ${Math.round(performance.now() - stopAt)} ms\n`);
    const partial = await page.locator('.message.assistant').nth(1).innerText();
    assert.ok(partial.length > 4);
    await app.close();
    app = undefined;
    app = await electron.launch({
        args: ['.'],
        env: { ...process.env, WHIM_DATA_DIR: directory, WHIM_SQLITE_BINDING: nativeBinding },
    });
    page = await app.firstWindow();
    await page.locator('.conversation').last().click();
    await page
        .locator('.message.assistant')
        .filter({ hasText: 'WHIM_DESKTOP_OK' })
        .first()
        .waitFor();
    assert.equal(await page.locator('.message.assistant').nth(1).innerText(), partial);
    assert.deepEqual(errors, []);
    process.stdout.write(
        'Electron live chat, language persistence, and restart recovery passed.\n'
    );
} finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
}
