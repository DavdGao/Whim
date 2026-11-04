import { Button, Message, MessageContent, MessageHeader, ScrollArea } from '@whimkit/ui';
import { Plus, Settings } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

import type { Snapshot, Command } from '../contracts.js';
import type { en } from './catalog.js';

/**
 * Render bounded history pages while preserving the scroll anchor on prepend.
 * @returns The rendered component.
 * @param root0
 * @param root0.snapshot
 * @param root0.running
 * @param root0.t
 * @param root0.onSettings
 * @param root0.onCreate
 * @param root0.invoke
 */
export function Transcript({
    snapshot,
    running,
    t,
    onSettings,
    onCreate,
    invoke,
}: {
    snapshot?: Snapshot;
    running: boolean;
    t: typeof en;
    onSettings: () => void;
    onCreate: () => void;
    invoke: (command: Command) => Promise<boolean>;
}) {
    const root = useRef<HTMLDivElement>(null);
    const bottom = useRef(true);
    const loading = useRef(false);
    const anchor = useRef<number | undefined>(undefined);
    const page = snapshot?.page;
    useLayoutEffect(() => {
        bottom.current = true;
        anchor.current = undefined;
    }, [snapshot?.selectedId]);
    const entries = [
        ...(page?.messages ?? []),
        ...(page?.pending ?? []),
        ...(page?.draft ? [page.draft] : []),
    ];
    const load = async () => {
        const viewport = root.current?.querySelector<HTMLElement>(
            '[data-radix-scroll-area-viewport]'
        );
        if (!page?.beforeId || !snapshot?.selectedId || loading.current || !viewport) return;
        loading.current = true;
        bottom.current = false;
        anchor.current = viewport.scrollHeight;
        try {
            await invoke({
                type: 'history',
                sessionId: snapshot.selectedId,
                beforeId: page.beforeId,
            });
        } finally {
            loading.current = false;
        }
    };
    useLayoutEffect(() => {
        const viewport = root.current?.querySelector<HTMLElement>(
            '[data-radix-scroll-area-viewport]'
        );
        if (!viewport) return;
        if (anchor.current !== undefined) {
            viewport.scrollTop += viewport.scrollHeight - anchor.current;
            anchor.current = undefined;
        } else if (bottom.current) viewport.scrollTop = viewport.scrollHeight;
    }, [page]);
    return (
        <ScrollArea
            ref={root}
            className="flex-1 min-h-0 basis-0"
            onScrollCapture={event => {
                const viewport = event.target as HTMLElement;
                if (!viewport.hasAttribute('data-radix-scroll-area-viewport')) return;
                bottom.current =
                    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
                if (viewport.scrollTop < 32 && page?.beforeId) void load();
            }}
        >
            <div
                className="transcript mx-auto w-full max-w-3xl px-8 py-8"
                role="log"
                aria-label={t.conversations}
                aria-live="off"
            >
                {!snapshot && <p role="status">{t.loading}</p>}
                {page?.beforeId && (
                    <Button variant="ghost" className="mb-4" onClick={() => void load()}>
                        {t.loadEarlier}
                    </Button>
                )}
                {snapshot && !entries.length && (
                    <div className="welcome flex min-h-[42vh] flex-col items-center justify-center gap-4 text-center">
                        <h1 className="text-2xl font-semibold tracking-tight">{t.welcome}</h1>
                        <p className="text-sm text-muted-foreground">{t.intro}</p>
                        {!snapshot.configured && (
                            <Button variant="outline" onClick={onSettings}>
                                <Settings />
                                {t.settings}
                            </Button>
                        )}
                        {!snapshot.selectedId && (
                            <Button onClick={onCreate}>
                                <Plus />
                                {t.newChat}
                            </Button>
                        )}
                    </div>
                )}
                {entries.map(message => (
                    <Message
                        key={message.id}
                        className={`message ${message.origin} mb-7 flex-col gap-2`}
                    >
                        <MessageHeader className="px-0">
                            {message.origin === 'assistant'
                                ? t.assistant
                                : message.origin === 'host'
                                  ? t.host
                                  : t.you}
                        </MessageHeader>
                        {message.blocks
                            .filter(block => block.type === 'reasoning')
                            .map((block, index) => (
                                <details key={index} className="text-xs text-muted-foreground">
                                    <summary>{t.reasoning}</summary>
                                    <p className="whitespace-pre-wrap mt-2">{block.text}</p>
                                </details>
                            ))}
                        {message.attachments?.length ? (
                            <div className="flex gap-2 text-xs text-muted-foreground">
                                {message.attachments.map(file => (
                                    <span key={file.id}>{file.name}</span>
                                ))}
                            </div>
                        ) : null}
                        <MessageContent
                            className={`message-text whitespace-pre-wrap break-words text-sm leading-7 ${message.origin === 'user' ? 'rounded-lg bg-muted px-4 py-3' : message.origin === 'host' ? 'border-l-2 pl-3 text-muted-foreground' : ''}`}
                        >
                            {message.blocks
                                .filter(block => block.type === 'text')
                                .map(block => block.text)
                                .join('\n')}
                        </MessageContent>
                    </Message>
                ))}
                {running && (
                    <p
                        className="run-state my-4 flex items-center gap-2 text-xs text-muted-foreground"
                        role="status"
                    >
                        <span className="size-1.5 rounded-full bg-foreground motion-safe:animate-pulse" />
                        {t.thinking}
                    </p>
                )}
                {!running && page?.outcome === 'interrupted' && (
                    <p className="run-state my-4 flex items-center gap-2 text-xs text-muted-foreground">
                        {t.interrupted}
                    </p>
                )}
                {!running && page?.outcome === 'failed' && (
                    <p className="run-state my-4 flex items-center gap-2 text-xs text-muted-foreground">
                        {t.failed}
                    </p>
                )}
                {page?.usage.totalTokens !== undefined && (
                    <p className="text-muted-foreground text-xs">
                        {t.tokens}: {page.usage.totalTokens}
                    </p>
                )}
            </div>
        </ScrollArea>
    );
}
