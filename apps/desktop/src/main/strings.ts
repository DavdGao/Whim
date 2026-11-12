import type { Locale } from '../shared/main-protocol.js';

// Main's own strings: the menu bar item, notifications, and the quit dialog (design.md §4.1).

const en = {
    nothingRunning: 'Nothing running',
    running: 'Running: {count}',
    untitled: 'New chat',
    needsYou: '{title} — needs you',
    open: 'Open Whim',
    quit: 'Quit Whim',
    quitTitle: 'Quit Whim while chats are running?',
    quitDetail:
        'Running chats: {count}. Quitting interrupts them; you can continue them after reopening Whim. Closing the window instead keeps them running.',
    quitConfirm: 'Quit',
    cancel: 'Cancel',
    completed: 'Finished',
    failed: 'Stopped with an error',
    waiting: 'Waiting for your approval',
    signin: 'Sign in again to keep it running',
    setup: 'Needs setup before it can run',
};

export type MainStringKey = keyof typeof en;

const catalogs: Record<Locale, Record<MainStringKey, string>> = {
    en,
    'zh-CN': {
        nothingRunning: '没有正在运行的对话',
        running: '正在运行：{count}',
        untitled: '新对话',
        needsYou: '{title} — 等你处理',
        open: '打开 Whim',
        quit: '退出 Whim',
        quitTitle: '还有对话在运行，确定退出 Whim？',
        quitDetail:
            '正在运行的对话：{count}。退出会中断它们，重新打开 Whim 后可以继续。只关闭窗口则会让它们继续运行。',
        quitConfirm: '退出',
        cancel: '取消',
        completed: '已完成',
        failed: '出错停止',
        waiting: '等待你的批准',
        signin: '需要重新登录才能继续运行',
        setup: '需要先完成设置才能运行',
    },
};

/**
 * Translate one of Main's strings, filling `{name}` placeholders.
 * @param locale The UI locale Backend reported.
 * @param key The string.
 * @param values Placeholder values.
 * @returns The text.
 */
export function mainText(
    locale: Locale,
    key: MainStringKey,
    values?: Record<string, string | number>
): string {
    return catalogs[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        String(values?.[name] ?? match)
    );
}
