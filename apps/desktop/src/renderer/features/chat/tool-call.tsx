import { CheckIcon, GlobeIcon, ShieldCheckIcon, XIcon } from 'lucide-react';

import { ActionButton } from '../../components/action-button';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';

import type { MessageKey } from '../../lib/messages';
import type {
    Access,
    NativeToolCallBlock,
    OpenCall,
    ToolCallBlock,
    ToolResult,
} from '@whimkit/core/contracts';
import type { ToolUIPart } from 'ai';

import {
    Confirmation,
    ConfirmationActions,
    ConfirmationRequest,
    ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import {
    Tool,
    ToolContent,
    ToolHeader,
    ToolInput,
    ToolOutput,
} from '@/components/ai-elements/tool';

type Display = { state: ToolUIPart['state']; label: MessageKey };

/**
 * Map a call's progress to the Tool component's state and a translated label.
 * @param open The open call, when it has no result yet.
 * @param result Its result.
 * @param jobRunning Whether its background job is still running.
 * @returns The display state.
 */
function display(
    open: OpenCall | undefined,
    result: ToolResult | undefined,
    jobRunning: boolean
): Display {
    if (result)
        switch (result.status) {
            case 'success':
                return { state: 'output-available', label: 'tool.status.success' };
            case 'error':
                return { state: 'output-error', label: 'tool.status.error' };
            case 'lost':
                return { state: 'output-error', label: 'tool.status.lost' };
            case 'denied':
                return { state: 'output-denied', label: 'tool.status.denied' };
            case 'cancelled':
                return { state: 'output-denied', label: 'tool.status.cancelled' };
            case 'background':
                return jobRunning
                    ? { state: 'input-available', label: 'tool.status.background' }
                    : { state: 'output-available', label: 'tool.status.backgroundEnded' };
        }
    if (open?.state === 'asking')
        return { state: 'approval-requested', label: 'tool.status.asking' };
    if (open?.state === 'running')
        return { state: 'input-available', label: 'tool.status.running' };
    return { state: 'input-available', label: 'tool.status.pending' };
}

/**
 * Parse call arguments for display, keeping the raw text when they are not JSON.
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
        <li className="flex min-w-0 gap-2">
            <span className="text-muted-foreground shrink-0">{t(key)}</span>
            <code className="min-w-0 truncate">{value}</code>
        </li>
    );
}

/**
 * A local tool call with its arguments, approval request, and result.
 * @param props The call.
 * @param props.sessionId The session.
 * @param props.block The call block.
 * @param props.open Its open state, when it has no result yet.
 * @param props.result Its result.
 * @param props.jobRunning Whether its background job is still running.
 * @returns The tool card.
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
    const shown = display(open, result, jobRunning);
    const decide = (decision: 'allow' | 'deny', scope: 'once' | 'session') =>
        call('session.decide', { sessionId, callId: block.callId, decision, scope });
    return (
        <Tool defaultOpen={open?.state === 'asking'} className="mb-0 rounded-2xl">
            <ToolHeader
                type={`tool-${block.name}`}
                title={block.name}
                state={shown.state}
                statusLabel={t(shown.label)}
            />
            <ToolContent>
                <ToolInput input={parseArguments(block.arguments)} label={t('tool.input')} />
                {result && (
                    <ToolOutput
                        label={
                            result.status === 'success' ? t('tool.output') : t('tool.status.error')
                        }
                        output={
                            result.status === 'success' || result.status === 'background'
                                ? result.content
                                : undefined
                        }
                        errorText={
                            result.status === 'success' || result.status === 'background'
                                ? undefined
                                : result.content
                        }
                    />
                )}
            </ToolContent>
            {open?.state === 'asking' && (
                <Confirmation
                    approval={{ id: block.callId }}
                    state="approval-requested"
                    className="m-3 mt-0 w-auto rounded-xl"
                >
                    <ConfirmationTitle>
                        <span className="flex items-center gap-2 font-medium">
                            <ShieldCheckIcon className="size-4" />
                            {t('tool.ask.title', { name: block.name })}
                        </span>
                    </ConfirmationTitle>
                    <ConfirmationRequest>
                        <ul className="mt-1 flex flex-col gap-1 text-xs">
                            {(open.access ?? []).map((access, index) => (
                                <AccessLine key={index} access={access} />
                            ))}
                        </ul>
                    </ConfirmationRequest>
                    <ConfirmationActions>
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
                    </ConfirmationActions>
                </Confirmation>
            )}
        </Tool>
    );
}

/**
 * A call the provider executed, such as a web search.
 * @param props The block.
 * @param props.block The native call.
 * @returns A compact tool card.
 */
export function NativeToolView({ block }: { block: NativeToolCallBlock }) {
    const { t } = useT();
    const title =
        block.tool === 'web_search'
            ? t('tool.native.search')
            : block.tool === 'web_fetch'
              ? t('tool.native.fetch')
              : block.tool;
    return (
        <Tool className="mb-0 rounded-2xl">
            <ToolHeader
                type={`tool-${block.tool}`}
                title={block.query ? `${title}: ${block.query}` : title}
                state={block.status === 'completed' ? 'output-available' : 'output-error'}
                statusLabel={
                    block.status === 'completed' ? t('tool.status.success') : t('tool.status.error')
                }
            />
            {block.urls?.length ? (
                <ToolContent>
                    <ul className="flex flex-col gap-1 p-4 text-xs">
                        {block.urls.map(url => (
                            <li key={url} className="flex min-w-0 items-center gap-2">
                                <GlobeIcon className="text-muted-foreground size-3.5 shrink-0" />
                                <span className="truncate">{url}</span>
                            </li>
                        ))}
                    </ul>
                </ToolContent>
            ) : null}
        </Tool>
    );
}
