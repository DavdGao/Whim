import {
    CheckIcon,
    CircleStopIcon,
    FilePenIcon,
    FilePlusIcon,
    FileSearchIcon,
    FileTextIcon,
    FolderSearchIcon,
    GlobeIcon,
    ListIcon,
    SearchIcon,
    ShieldCheckIcon,
    TerminalIcon,
    WrenchIcon,
    XIcon,
} from 'lucide-react';

import { ActionButton } from '../../components/action-button';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import { MediaView } from './media-view';

import type { MessageKey } from '../../lib/messages';
import type {
    Access,
    NativeToolCallBlock,
    OpenCall,
    ToolCallBlock,
    ToolResult,
} from '@whimkit/core/contracts';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
    CodeBlock,
    CodeBlockContent,
    CodeBlockHeader,
    CodeBlockTitle,
} from '@/components/ui/code-block';
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemMedia,
    ItemTitle,
} from '@/components/ui/item';
import {
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceDescription,
    TraceIcon,
    TraceLine,
    TraceTitle,
} from '@/components/ui/trace';

type Phase = 'running' | 'done' | 'failed';

/** Icon and title keys of the base tools; other tools use the generic titles. */
const known: Record<string, { icon: LucideIcon; titles: Record<Phase, MessageKey> }> = {
    Bash: {
        icon: TerminalIcon,
        titles: {
            running: 'tool.Bash.running',
            done: 'tool.Bash.done',
            failed: 'tool.Bash.failed',
        },
    },
    Read: {
        icon: FileTextIcon,
        titles: {
            running: 'tool.Read.running',
            done: 'tool.Read.done',
            failed: 'tool.Read.failed',
        },
    },
    Write: {
        icon: FilePlusIcon,
        titles: {
            running: 'tool.Write.running',
            done: 'tool.Write.done',
            failed: 'tool.Write.failed',
        },
    },
    Edit: {
        icon: FilePenIcon,
        titles: {
            running: 'tool.Edit.running',
            done: 'tool.Edit.done',
            failed: 'tool.Edit.failed',
        },
    },
    Glob: {
        icon: FolderSearchIcon,
        titles: {
            running: 'tool.Glob.running',
            done: 'tool.Glob.done',
            failed: 'tool.Glob.failed',
        },
    },
    Grep: {
        icon: FileSearchIcon,
        titles: {
            running: 'tool.Grep.running',
            done: 'tool.Grep.done',
            failed: 'tool.Grep.failed',
        },
    },
    WebFetch: {
        icon: GlobeIcon,
        titles: {
            running: 'tool.WebFetch.running',
            done: 'tool.WebFetch.done',
            failed: 'tool.WebFetch.failed',
        },
    },
    // Plugin-provided search: titled like provider search, without the query.
    WebSearch: {
        icon: SearchIcon,
        titles: {
            running: 'tool.search.running',
            done: 'tool.search.done',
            failed: 'tool.search.failed',
        },
    },
    JobOutput: {
        icon: ListIcon,
        titles: {
            running: 'tool.JobOutput.running',
            done: 'tool.JobOutput.done',
            failed: 'tool.JobOutput.failed',
        },
    },
    JobStop: {
        icon: CircleStopIcon,
        titles: {
            running: 'tool.JobStop.running',
            done: 'tool.JobStop.done',
            failed: 'tool.JobStop.failed',
        },
    },
};

const generic: Record<Phase, MessageKey> = {
    running: 'tool.generic.running',
    done: 'tool.generic.done',
    failed: 'tool.generic.failed',
};

/**
 * Parse call arguments for display, keeping the raw text when they are not a JSON object.
 * @param text The arguments.
 * @returns Parsed input.
 */
function parseArguments(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * The short subject of a call shown in its title: the command, path, pattern, or URL.
 * @param name The tool name.
 * @param input Parsed arguments.
 * @returns The subject.
 */
function subject(name: string, input: unknown): string {
    if (typeof input !== 'object' || input === null) return name;
    const fields = input as Record<string, unknown>;
    for (const key of ['command', 'path', 'pattern', 'url', 'jobId']) {
        const value = fields[key];
        if (typeof value === 'string' && value)
            return key === 'url' ? value.replace(/^https?:\/\//, '') : value;
    }
    return name;
}

/**
 * Where a call stands, for its line.
 * @param open The open call, when it has no result yet.
 * @param result Its result.
 * @param jobRunning Whether its background job is still running.
 * @returns The phase and an optional status note.
 */
function progress(
    open: OpenCall | undefined,
    result: ToolResult | undefined,
    jobRunning: boolean
): { phase: Phase; note?: MessageKey; active: boolean } {
    if (!result)
        return open?.state === 'running'
            ? { phase: 'running', active: true }
            : {
                  phase: 'running',
                  active: false,
                  note: open?.state === 'asking' ? 'tool.status.asking' : 'tool.status.pending',
              };
    switch (result.status) {
        case 'success':
            return { phase: 'done', active: false };
        case 'error':
            return { phase: 'failed', active: false };
        case 'lost':
            return { phase: 'failed', active: false, note: 'tool.status.lost' };
        case 'denied':
            return { phase: 'running', active: false, note: 'tool.status.denied' };
        case 'cancelled':
            return { phase: 'running', active: false, note: 'tool.status.cancelled' };
        case 'background':
            return jobRunning
                ? { phase: 'running', active: true, note: 'tool.status.background' }
                : { phase: 'done', active: false, note: 'tool.status.backgroundEnded' };
    }
}

/**
 * One activity line, expandable when it has details.
 * @param props Line props.
 * @param props.icon Leading icon.
 * @param props.title Title text.
 * @param props.note Trailing status text.
 * @param props.status Line status.
 * @param props.children Details shown when expanded.
 * @returns The line.
 */
function ActivityLine({
    icon: Icon,
    title,
    note,
    status,
    children,
}: {
    icon: LucideIcon;
    title: string;
    note?: string | undefined;
    status?: 'running' | 'error' | undefined;
    children?: ReactNode;
}) {
    const line = (
        <TraceLine status={status}>
            <TraceIcon>
                <Icon />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            {note && <TraceDescription>{note}</TraceDescription>}
        </TraceLine>
    );
    if (!children) return line;
    return (
        <TraceCollapsible>
            <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
        </TraceCollapsible>
    );
}

/**
 * A labelled code block for a call's input or output.
 * @param props Block props.
 * @param props.label Header label.
 * @param props.text Content.
 * @param props.error Whether it is an error.
 * @returns The block.
 */
function Details({ label, text, error }: { label: string; text: string; error?: boolean }) {
    return (
        <CodeBlock size="sm" variant={error ? 'destructive' : 'default'}>
            <CodeBlockHeader>
                <CodeBlockTitle>{label}</CodeBlockTitle>
            </CodeBlockHeader>
            <CodeBlockContent wrap className="max-h-64">
                {text}
            </CodeBlockContent>
        </CodeBlock>
    );
}

/**
 * One line describing what a call will touch.
 * @param props The access.
 * @param props.access One access entry.
 * @returns The line.
 */
function AccessLine({ access }: { access: Access }) {
    const { t } = useT();
    const [key, value]: [MessageKey, string] =
        access.kind === 'execute'
            ? ['tool.access.execute', access.command]
            : access.kind === 'network'
              ? ['tool.access.network', access.url]
              : [access.kind === 'read' ? 'tool.access.read' : 'tool.access.write', access.path];
    return (
        <span className="flex min-w-0 gap-2">
            <span className="shrink-0">{t(key)}</span>
            <code className="text-foreground min-w-0 truncate">{value}</code>
        </span>
    );
}

/**
 * A local tool call as a trace line, with an approval prompt while it waits for the user.
 * @param props The call.
 * @param props.sessionId The session.
 * @param props.block The call block.
 * @param props.open Its open state, when it has no result yet.
 * @param props.result Its result.
 * @param props.jobRunning Whether its background job is still running.
 * @returns The line.
 */
export function ToolCallView({
    sessionId,
    block,
    open,
    result,
    jobRunning,
}: {
    sessionId: string;
    block: ToolCallBlock;
    open: OpenCall | undefined;
    result: ToolResult | undefined;
    jobRunning: boolean;
}) {
    const { t } = useT();
    const input = parseArguments(block.arguments);
    const target = subject(block.name, input);
    const tool = known[block.name];
    const Icon = tool?.icon ?? WrenchIcon;
    const shown = progress(open, result, jobRunning);
    const title = t((tool?.titles ?? generic)[shown.phase], { target, name: block.name });
    const decide = (decision: 'allow' | 'deny', scope: 'once' | 'session') =>
        call('session.decide', { sessionId, callId: block.callId, decision, scope });
    const failed = result !== undefined && !['success', 'background'].includes(result.status);
    const inputText =
        block.name === 'Bash' && typeof input === 'object' && input !== null
            ? `$ ${target}`
            : typeof input === 'string'
              ? input
              : JSON.stringify(input, null, 2);
    return (
        <>
            <ActivityLine
                icon={Icon}
                title={title}
                note={shown.note && t(shown.note)}
                status={shown.active ? 'running' : shown.phase === 'failed' ? 'error' : undefined}
            >
                {result && (
                    <div className="flex flex-col gap-2">
                        <Details label={t('tool.input')} text={inputText} />
                        {result.content && (
                            <Details
                                label={failed ? t('tool.status.error') : t('tool.output')}
                                text={result.content}
                                error={failed}
                            />
                        )}
                        {result.media && (
                            <MediaView sessionId={sessionId} media={result.media} align="start" />
                        )}
                    </div>
                )}
            </ActivityLine>
            {open?.state === 'asking' && (
                // Padding matches the corner radius; the negative margin of the same size widens
                // the card past the text column so its icon and buttons line up with the text edges.
                <Item
                    variant="outline"
                    size="sm"
                    className="-mx-4 w-[calc(100%+2rem)] gap-3 rounded-2xl px-4 py-3"
                >
                    <ItemMedia variant="icon">
                        <Icon />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                        <ItemTitle>{t('tool.ask.title', { name: block.name })}</ItemTitle>
                        <ItemDescription className="flex flex-col gap-0.5 text-xs">
                            {(open.access ?? []).map((access, index) => (
                                <AccessLine key={index} access={access} />
                            ))}
                        </ItemDescription>
                    </ItemContent>
                    <ItemActions className="flex-wrap justify-end">
                        <ActionButton
                            size="sm"
                            variant="ghost"
                            icon={<XIcon />}
                            action={() => decide('deny', 'once')}
                        >
                            {t('tool.ask.deny')}
                        </ActionButton>
                        <ActionButton
                            size="sm"
                            variant="outline"
                            icon={<ShieldCheckIcon />}
                            action={() => decide('allow', 'session')}
                        >
                            {t('tool.ask.session')}
                        </ActionButton>
                        <ActionButton
                            size="sm"
                            icon={<CheckIcon />}
                            action={() => decide('allow', 'once')}
                        >
                            {t('tool.ask.once')}
                        </ActionButton>
                    </ItemActions>
                </Item>
            )}
        </>
    );
}

/**
 * A call the provider executed, such as a web search, as a trace line listing the pages.
 * @param props The block.
 * @param props.block The native call.
 * @returns The line.
 */
export function NativeToolView({ block }: { block: NativeToolCallBlock }) {
    const { t } = useT();
    const search = block.tool === 'web_search';
    const failed = block.status !== 'completed';
    const target = block.urls?.[0]?.replace(/^https?:\/\//, '') ?? '';
    const title = search
        ? t(failed ? 'tool.search.failed' : 'tool.search.done')
        : t(failed ? 'tool.WebFetch.failed' : 'tool.WebFetch.done', { target });
    return (
        <ActivityLine
            icon={search ? SearchIcon : GlobeIcon}
            title={title}
            status={failed ? 'error' : undefined}
        >
            {search && block.urls?.length ? (
                <div className="flex flex-col gap-1.5">
                    {block.urls.map(url => (
                        <TraceLine key={url}>
                            <TraceIcon>
                                <GlobeIcon />
                            </TraceIcon>
                            <TraceTitle>{url.replace(/^https?:\/\//, '')}</TraceTitle>
                        </TraceLine>
                    ))}
                </div>
            ) : null}
        </ActivityLine>
    );
}
