import type {
    EpochContext,
    HistoryEntry,
    MediaBlock,
    Notice,
    SessionView,
    ToolResult,
} from '@whimkit/core/contracts';
import type { ChatRequestMessage, InlineMedia, RequestBlock } from '@whimkit/core/plugin';

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

/** How media in history reaches a request. */
export interface MediaPolicy {
    /** Media types the session's card accepts as input. */
    readonly accepts: (mediaType: string) => boolean;
    /** Media types the adapter carries inside tool results. */
    readonly inToolResults: readonly string[];
    /** Read stored bytes by `file:` URI. */
    readonly read: (uri: string) => Promise<Uint8Array>;
}

/**
 * Escape a value for an XML attribute.
 * @param value The raw value.
 * @returns The escaped value.
 */
const attribute = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/**
 * The text that stands in for media the model cannot read: an identifier and a `file:` URI.
 * @param media The media block.
 * @returns The reference.
 */
export function mediaReference(media: MediaBlock): string {
    return `<data id="${attribute(media.id)}" uri="${attribute(media.uri)}" media_type="${attribute(media.mediaType)}"${media.name ? ` name="${attribute(media.name)}"` : ''}/>`;
}

/**
 * A text file's content wrapped with its identity.
 * @param media A media block carrying `text`.
 * @returns The text.
 */
function textFile(media: MediaBlock & { text: string }): string {
    return `<file id="${attribute(media.id)}" uri="${attribute(media.uri)}"${media.name ? ` name="${attribute(media.name)}"` : ''}>\n${media.text}\n</file>`;
}

/**
 * Convert committed history into request messages. Rendering depends only on history, the
 * card, and the adapter, so the same history always yields the same request prefix.
 *
 * Media follow three rules: a type the card cannot read becomes a `<data>` reference; in a
 * user message a readable type is delivered inline; in a tool result it is delivered inline when
 * the adapter carries that type in tool results, and otherwise the result names its identifier
 * and the media follow in one user message after all results of that assistant message, since
 * providers require results to follow their calls directly.
 * @param history The session history.
 * @param media Media policy of the session's model.
 * @returns Messages in order; notices become user-role reminders.
 */
export async function toRequestMessages(
    history: readonly HistoryEntry[],
    media: MediaPolicy
): Promise<ChatRequestMessage[]> {
    const messages: ChatRequestMessage[] = [];
    const inline = async (block: MediaBlock): Promise<InlineMedia> => ({
        type: 'inline_media',
        mediaType: block.mediaType,
        data: Buffer.from(await media.read(block.uri)).toString('base64'),
    });
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
        const blocks: RequestBlock[] = [];
        for (const block of item.blocks) {
            if (block.type !== 'media') blocks.push(block);
            else if (block.text !== undefined)
                blocks.push({ type: 'text', text: textFile({ ...block, text: block.text }) });
            else if (media.accepts(block.mediaType)) blocks.push(await inline(block));
            else blocks.push({ type: 'text', text: mediaReference(block) });
        }
        messages.push({ role: item.role, blocks });
        const promoted: RequestBlock[] = [];
        for (const block of item.blocks) {
            if (block.type !== 'tool_call') continue;
            const result = results.get(block.callId);
            if (!result) continue;
            const notes: string[] = [];
            const carried: InlineMedia[] = [];
            for (const attached of result.media ?? []) {
                if (!media.accepts(attached.mediaType)) notes.push(mediaReference(attached));
                else if (media.inToolResults.includes(attached.mediaType))
                    carried.push(await inline(attached));
                else {
                    notes.push(
                        `<system-reminder>A ${attached.mediaType} file is returned and will be presented to you with the identifier [${attached.id}].</system-reminder>`
                    );
                    promoted.push(
                        { type: 'text', text: `- ${attached.id} (${attached.mediaType}):` },
                        await inline(attached)
                    );
                }
            }
            messages.push({
                role: 'tool',
                callId: result.callId,
                status: result.status,
                content: [result.content, ...notes].filter(Boolean).join('\n'),
                ...(carried.length ? { media: carried } : {}),
            });
        }
        if (promoted.length)
            messages.push({
                role: 'user',
                blocks: [
                    {
                        type: 'text',
                        text: '<system-reminder>The media returned by the tools above, by identifier:',
                    },
                    ...promoted,
                    { type: 'text', text: '</system-reminder>' },
                ],
            });
    }
    return messages;
}

/**
 * Bytes counted per inline image: providers bill images by resolution, not size, so a fixed
 * upper-leaning allowance (about 2,000 tokens) stands in until an adapter counts tokens itself.
 */
const mediaEstimateBytes = 6000;

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
            bytes += (message.media?.length ?? 0) * mediaEstimateBytes;
            continue;
        }
        for (const block of message.blocks)
            if (block.type === 'inline_media') bytes += mediaEstimateBytes;
            else
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

/**
 * The request messages of the current epoch: after a compaction, a reminder carrying the summary
 * and the transcript's `file:` URI, the kept user message when it is older than the epoch's start,
 * then the history the summary does not cover.
 * @param view The session view.
 * @param media Media policy of the session's model.
 * @param until Leave out history from this sequence number on; a summary request's cut.
 * @returns Messages in order.
 */
export async function epochMessages(
    view: SessionView,
    media: MediaPolicy,
    until = Infinity
): Promise<ChatRequestMessage[]> {
    const context = view.epoch.context;
    const from = context?.from ?? 0;
    const messages = await toRequestMessages(
        view.history.filter(
            entry => entry.seq < until && (entry.seq >= from || entry.seq === context?.input)
        ),
        media
    );
    if (!context) return messages;
    return [
        { role: 'user', blocks: [{ type: 'text', text: summaryReminder(context) }] },
        ...messages,
    ];
}

/**
 * How a compacted epoch opens.
 * @param context The epoch's compaction context.
 * @returns The reminder text.
 */
export function summaryReminder(context: EpochContext): string {
    return `<system-reminder>The earlier part of this conversation was compacted to save context. Its full transcript is at ${context.transcript}; Read it when you need exact earlier details.${context.input === undefined ? '' : " The user's latest message follows verbatim."}\n\nSummary of the earlier conversation:\n${context.summary}</system-reminder>`;
}

/**
 * A rough upper-leaning token size of one history entry, for choosing a compaction cut.
 * @param entry The entry.
 * @returns Estimated tokens.
 */
export function entryTokens(entry: HistoryEntry): number {
    const item = entry.item;
    const media =
        item.type === 'tool_result'
            ? (item.media?.length ?? 0)
            : item.type === 'message'
              ? item.blocks.filter(block => block.type === 'media' && block.text === undefined)
                    .length
              : 0;
    return Math.ceil(
        (new TextEncoder().encode(JSON.stringify(item)).length + media * mediaEstimateBytes) / 3
    );
}

/**
 * Plain-text transcript of history entries, written to the session folder before a compaction
 * and given to the summary call. Media appear as references or, for text files, their content.
 * Reasoning and opaque provider state are left out.
 * @param history The entries to transcribe.
 * @returns Markdown text.
 */
export function transcriptText(history: readonly HistoryEntry[]): string {
    const parts: string[] = [];
    for (const { item } of history) {
        if (item.type === 'notice') {
            parts.push(`### Notice\n${renderNotice(item)}`);
            continue;
        }
        if (item.type === 'tool_result') {
            parts.push(
                [
                    `### Tool result (${item.name}, ${item.status})`,
                    item.content,
                    ...(item.media ?? []).map(mediaReference),
                ]
                    .filter(Boolean)
                    .join('\n')
            );
            continue;
        }
        const lines: string[] = [];
        for (const block of item.blocks) {
            if (block.type === 'text') lines.push(block.text);
            else if (block.type === 'media')
                lines.push(
                    block.text !== undefined
                        ? textFile({ ...block, text: block.text })
                        : mediaReference(block)
                );
            else if (block.type === 'tool_call')
                lines.push(`[Called ${block.name} with ${block.arguments}]`);
            else if (block.type === 'native_tool_call')
                lines.push(
                    `[Provider ${block.tool}${block.query ? `: ${block.query}` : ''}${block.urls?.length ? ` (${block.urls.join(', ')})` : ''}]`
                );
        }
        if (lines.length)
            parts.push(`### ${item.role === 'user' ? 'User' : 'Assistant'}\n${lines.join('\n')}`);
    }
    return parts.join('\n\n');
}
