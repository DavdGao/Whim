import type { HistoryEntry, Notice, ToolResult } from '@whimkit/core/contracts';
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
        case 'job-finished':
            text = `Background job ${notice.payload.jobId} (${notice.payload.tool}) ${notice.payload.status === 'completed' ? 'finished' : notice.payload.status}.${notice.text ? `\nOutput:\n${notice.text}` : ''}`;
            break;
        case 'job-lost':
            text = `Background job ${notice.payload.jobId} (${notice.payload.tool}) was lost when the application restarted; its outcome is unknown.`;
            break;
        case 'workspace-changed':
            text = `The user changed the working folder from ${notice.payload.from} to ${notice.payload.to}. Tools now run there and relative paths resolve against it; paths mentioned earlier in this conversation refer to the previous folder.`;
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
    const messages: ChatRequestMessage[] = [];
    // Results are committed as they complete; providers expect them in call order, right after
    // the message that called them, so they are gathered and placed there.
    const results = new Map<string, ToolResult>();
    for (const entry of history)
        if (entry.item.type === 'tool_result') results.set(entry.item.callId, entry.item);
    for (const entry of history) {
        const item = entry.item;
        if (item.type === 'tool_result') continue;
        if (item.type === 'notice') {
            messages.push({ role: 'user', blocks: [{ type: 'text', text: renderNotice(item) }] });
            continue;
        }
        messages.push({ role: item.role, blocks: item.blocks });
        for (const block of item.blocks) {
            if (block.type !== 'tool_call') continue;
            const result = results.get(block.callId);
            if (result)
                messages.push({
                    role: 'tool',
                    callId: result.callId,
                    status: result.status,
                    content: result.content,
                });
        }
    }
    return messages;
}

/**
 * Estimate input tokens conservatively when the adapter cannot count them.
 * @param system The system prompt.
 * @param messages The request messages.
 * @param tools Tool declarations sent with the request.
 * @returns An upper-leaning token estimate.
 */
export function estimateTokens(
    system: string,
    messages: readonly ChatRequestMessage[],
    tools: readonly unknown[] = []
): number {
    const encoder = new TextEncoder();
    let bytes = encoder.encode(system).length + encoder.encode(JSON.stringify(tools)).length;
    for (const message of messages) {
        bytes += 16;
        if (message.role === 'tool') {
            bytes += encoder.encode(message.content).length;
            continue;
        }
        for (const block of message.blocks)
            bytes += encoder.encode(
                block.type === 'text' || block.type === 'reasoning'
                    ? block.text
                    : block.type === 'tool_call'
                      ? block.name + block.arguments
                      : JSON.stringify(block.type === 'continuation' ? block.data : block)
            ).length;
    }
    // UTF-8 bytes / 3 overestimates English and roughly matches CJK (3 bytes per character).
    return Math.ceil(bytes / 3);
}
