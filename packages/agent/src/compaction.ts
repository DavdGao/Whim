import { entryTokens } from './render.js';

import type { HistoryEntry, SessionView } from '@whimkit/core/contracts';
import type { ChatRequestMessage } from '@whimkit/core/plugin';

// Pure parts of compaction (agent.md §8): where to cut, what to ask, and how to read the reply.

/** The tail kept verbatim holds at most this many history entries. */
const keepEntries = 6;

/** The summary's sections, in order. */
export const summarySections = [
    'goal',
    'current-state',
    'progress',
    'findings',
    'next-steps',
] as const;

/** Where a compaction cuts the current epoch. */
export interface CompactionCut {
    /** The first sequence number kept verbatim; the new epoch's `from`. */
    readonly from: number;
    /** The latest user message, kept verbatim although it is older than `from`. */
    readonly input?: number;
    /** Index into the epoch's entries; entries before it are summarized. */
    readonly index: number;
}

/**
 * The history entries of the current epoch.
 * @param view The session view.
 * @returns Entries from the epoch's start on.
 */
function epochEntries(view: SessionView): HistoryEntry[] {
    const from = view.epoch.context?.from ?? 0;
    return view.history.filter(entry => entry.seq >= from);
}

/**
 * The cut at an index of the epoch's entries, or undefined when it would leave nothing to
 * summarize but the kept user message.
 * @param view The session view.
 * @param entries The epoch's entries.
 * @param index Entries before it are summarized.
 * @returns The cut.
 */
function cutAt(
    view: SessionView,
    entries: readonly HistoryEntry[],
    index: number
): CompactionCut | undefined {
    const from = entries[index]?.seq ?? view.head + 1;
    const isUser = (entry: HistoryEntry) =>
        entry.item.type === 'message' && entry.item.role === 'user';
    const input = view.history.some(entry => entry.seq >= from && isUser(entry))
        ? undefined
        : view.history.findLast(entry => entry.seq < from && isUser(entry))?.seq;
    if (!entries.slice(0, index).some(entry => entry.seq !== input)) return undefined;
    return { from, index, ...(input === undefined ? {} : { input }) };
}

/**
 * Indices where the epoch's entries may be cut: never on a tool result, so calls keep their
 * results, and never between entries sharing a sequence number.
 * @param entries The epoch's entries.
 * @returns Ascending indices from 1 to the entry count.
 */
function boundaries(entries: readonly HistoryEntry[]): number[] {
    const indices: number[] = [];
    for (let index = 1; index <= entries.length; index++) {
        const entry = entries[index];
        if (!entry || (entry.item.type !== 'tool_result' && entry.seq !== entries[index - 1]?.seq))
            indices.push(index);
    }
    return indices;
}

/**
 * Where a compaction cuts: the last few entries stay verbatim, fewer when they are large.
 * @param view The session view.
 * @param tailTokens The most the kept tail may take.
 * @returns The cut, or undefined when nothing could be compacted.
 */
export function compactionCut(view: SessionView, tailTokens: number): CompactionCut | undefined {
    const entries = epochEntries(view);
    let start = entries.length;
    let size = 0;
    while (start > 0 && entries.length - start < keepEntries) {
        const previous = entries[start - 1];
        if (!previous || size + entryTokens(previous) > tailTokens) break;
        size += entryTokens(previous);
        start--;
    }
    for (const index of boundaries(entries).filter(index => index >= start)) {
        const cut = cutAt(view, entries, index);
        if (cut) return cut;
    }
    return undefined;
}

/**
 * A cut covering about the older half of what `cut` covers, for a refused summary request.
 * @param view The session view.
 * @param cut The refused cut.
 * @returns The smaller cut, or undefined when the covered part cannot be split.
 */
export function olderHalf(view: SessionView, cut: CompactionCut): CompactionCut | undefined {
    const entries = epochEntries(view);
    const candidates = boundaries(entries)
        .filter(index => index < cut.index)
        .sort((a, b) => Math.abs(a - cut.index / 2) - Math.abs(b - cut.index / 2));
    for (const index of candidates) {
        const smaller = cutAt(view, entries, index);
        if (smaller) return smaller;
    }
    return undefined;
}

/**
 * The reminder that ends a summary request.
 * @param now The current time.
 * @returns Its text.
 */
export function summaryHint(now: Date): string {
    return `<system-reminder>
It is now ${now.toISOString()}. The conversation above will be replaced by your summary to save context; only its most recent part, which is not shown here, and the user's latest message stay verbatim. Write the summary now so that the work can continue from it alone. Do not call any tools; this reply is not shown to the user.

Answer in the conversation's language with exactly these five sections:
<goal>What the user wants overall, with their constraints and preferences. Quote wording that matters.</goal>
<current-state>Where the work stands now: what exists, what is running, what is decided.</current-state>
<progress>What changed since the previous summary, or since the start when there is none: files created or changed, commands run and their outcomes, decisions made.</progress>
<findings>Facts and conclusions established so far, each with its evidence and whether it is verified.</findings>
<next-steps>Everything still pending or awaited, in order, including requests of the user not done yet.</next-steps>

Rules:
- Describe the current state. Do not copy the previous summary; carry over what still holds, rewritten where it changed.
- When something was corrected, keep only the corrected version and say what it replaces.
- Copy identifiers exactly as written: file paths and file: URIs, media identifiers such as img-…, job ids, URLs, names, and numbers. When one was not recorded in the conversation, write "not recorded"; never reconstruct it from memory.
- Use absolute dates and times only.
- List every pending item.
</system-reminder>`;
}

/** Why a summary reply is asked for again. */
export type SummaryProblem =
    | { readonly kind: 'missing'; readonly sections: readonly string[] }
    | { readonly kind: 'tool-call' }
    | { readonly kind: 'cut' };

/**
 * The reminder asking for the summary once more.
 * @param problem What was wrong with the reply.
 * @returns Its text.
 */
export function correctionHint(problem: SummaryProblem): string {
    const reason =
        problem.kind === 'missing'
            ? `Your summary is missing ${problem.sections.map(name => `<${name}>`).join(', ')}.`
            : problem.kind === 'tool-call'
              ? 'You called a tool; tools cannot run now.'
              : 'Your summary was cut off at the output limit; write it more concisely.';
    return `<system-reminder>${reason} Write the complete summary again with all five sections, and nothing else.</system-reminder>`;
}

/** A parsed summary reply. */
export interface ParsedSummary {
    /** The sections found, in canonical order and form; empty when none were. */
    readonly summary: string;
    readonly missing: readonly string[];
}

/**
 * Read the tagged sections of a summary reply, also when the model escaped the tags.
 * @param reply The reply's text.
 * @returns The sections in canonical form and the names of missing ones.
 */
export function parseSummary(reply: string): ParsedSummary {
    const text = reply.replace(
        new RegExp(`&lt;(/?)(${summarySections.join('|')})&gt;`, 'g'),
        '<$1$2>'
    );
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of summarySections) {
        const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
        if (match) found.push(`<${name}>\n${(match[1] ?? '').trim()}\n</${name}>`);
        else missing.push(name);
    }
    return { summary: found.join('\n\n'), missing };
}

/**
 * Shorten every text longer than `limit` in the middle, keeping its beginning and end.
 * @param messages Request messages; the last `keep` are left unchanged.
 * @param limit The longest text left, in characters.
 * @param keep How many trailing messages (the instructions) stay as they are.
 * @returns The shortened messages.
 */
export function trimLongTexts(
    messages: readonly ChatRequestMessage[],
    limit: number,
    keep: number
): ChatRequestMessage[] {
    const shorten = (text: string) => {
        if (text.length <= limit) return text;
        const half = Math.floor(limit / 2);
        return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(-half)}`;
    };
    return messages.map((message, index) => {
        if (index >= messages.length - keep) return message;
        if (message.role === 'tool') return { ...message, content: shorten(message.content) };
        return {
            ...message,
            blocks: message.blocks.map(block =>
                block.type === 'text' || block.type === 'reasoning'
                    ? { ...block, text: shorten(block.text) }
                    : block
            ),
        };
    });
}

/**
 * The longest text of a request, in characters.
 * @param messages Request messages.
 * @returns Its length.
 */
export function longestText(messages: readonly ChatRequestMessage[]): number {
    let longest = 0;
    for (const message of messages)
        if (message.role === 'tool') longest = Math.max(longest, message.content.length);
        else
            for (const block of message.blocks)
                if (block.type === 'text' || block.type === 'reasoning')
                    longest = Math.max(longest, block.text.length);
    return longest;
}
