import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { _electron as electron } from '@playwright/test';
import { prepareNative } from '../prepare-native.mjs';

const directory = await mkdtemp(join(tmpdir(), 'whim-shell-'));
let app;
try {
    app = await electron.launch({
        args: ['.'],
        env: {
            ...process.env,
            WHIM_DATA_DIR: directory,
            WHIM_SQLITE_BINDING: await prepareNative(),
        },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => {
        errors.push(error.message);
        process.stderr.write(`${error.message}\n`);
    });
    await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
    for (let index = 0; index < 3; index++) {
        await page.getByRole('button', { name: 'New conversation', exact: true }).first().click();
        await page.locator('.conversation').nth(index).waitFor();
        assert.equal(await page.getByRole('log').count(), 1);
    }
    await page.locator('.conversation').last().click();
    await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
    assert.equal(await page.getByRole('log').count(), 1);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
        await page
            .getByRole('button', { name: 'Settings', exact: true })
            .first()
            .evaluate(element => element === globalThis.document.activeElement),
        true
    );
    await page.getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option', { name: '简体中文' }).click();
    await page.getByRole('heading', { name: '现在，你在想什么？' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '现在，你在想什么？' }).waitFor();
    await page.screenshot({ path: '/tmp/whim-shell-zh.png' });
    await page.getByRole('combobox', { name: '语言' }).click();
    await page.getByRole('option', { name: 'English' }).click();
    await page.getByRole('heading', { name: 'What’s on your mind?' }).waitFor();
    await page.screenshot({ path: '/tmp/whim-shell-en.png' });
    assert.deepEqual(errors, []);
    process.stdout.write(
        'Electron shell: navigation, single transcript, dialog keyboard focus, and persisted language passed.\n'
    );
} finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
}
