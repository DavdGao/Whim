import type { HistoryEntry, Notice } from '@whimkit/core/contracts';
import type { ChatRequestMessage } from '@whimkit/core/plugin';

/** Version of the notice renderer; recorded in each epoch because it shapes the prompt. */
export const rendererVersion = 1;

/**
 * Render a notice as model-facing text.
 * @param notice The notice.
 * @returns The reminder text.
 */
export function renderNotice(notice: Notice): string {
    let text: string;
    switch (notice.kind) {
        case 'interrupted':
            text =
                notice.payload.reason === 'user'
                    ? 'The user interrupted you.'
                    : 'Your previous response was interrupted because its model plugin was removed.';
            break;
        case 'restarted':
            text = 'The application restarted and your previous response was cut off.';
            break;
    }
    return `<system-reminder>${text}</system-reminder>`;
}

/**
 * Convert committed history into request messages.
 * @param history The session history.
 * @returns Messages in order; notices become user-role reminders.
 */
export function toRequestMessages(history: readonly HistoryEntry[]): ChatRequestMessage[] {
    return history.map(entry =>
        entry.item.type === 'message'
            ? { role: entry.item.role, blocks: entry.item.blocks }
            : { role: 'user', blocks: [{ type: 'text', text: renderNotice(entry.item) }] }
    );
}

/**
 * Estimate input tokens conservatively when the adapter cannot count them.
 * @param system The system prompt.
 * @param messages The request messages.
 * @returns An upper-leaning token estimate.
 */
export function estimateTokens(system: string, messages: readonly ChatRequestMessage[]): number {
    const encoder = new TextEncoder();
    let bytes = encoder.encode(system).length;
    for (const message of messages) {
        bytes += 16;
        for (const block of message.blocks)
            bytes +=
                block.type === 'continuation'
                    ? encoder.encode(JSON.stringify(block.data)).length
                    : encoder.encode(block.text).length;
    }
    // UTF-8 bytes / 3 overestimates English and roughly matches CJK (3 bytes per character).
    return Math.ceil(bytes / 3);
}
