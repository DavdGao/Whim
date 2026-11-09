import '@xterm/xterm/css/xterm.css';

import { Button } from '@whimkit/ui/components/button';
import { Spinner } from '@whimkit/ui/components/spinner';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { RotateCwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { call, ClientError, onStatus, subscribe } from '../../lib/client';
import { useT } from '../../lib/i18n';

// One attached terminal (design.md §11.4). Closing the view detaches; the tmux session keeps running.

/** Rendered characters are acknowledged in batches of at least this size, or after a pause. */
const ackBatchChars = 64_000;
const ackDelayMs = 100;

/**
 * Send a terminal call whose failure needs no action: the terminal may have closed meanwhile.
 * @param request The call.
 */
function background(request: Promise<unknown>): void {
    void request.catch((error: unknown) => {
        if (error instanceof ClientError && error.error.code === 'not-found') return;
        console.warn('Terminal call failed.', error);
    });
}

type Phase =
    | { readonly kind: 'connecting' }
    | { readonly kind: 'open' }
    | { readonly kind: 'ended'; readonly error?: string };

/**
 * A terminal attached to a tmux session.
 * @param props View props.
 * @param props.hostId `local` or a saved host's id.
 * @param props.sessionKey The session's key.
 * @param props.onEnded Called when the attachment ends, so the session list can refresh.
 * @returns The view.
 */
export function TerminalView({
    hostId,
    sessionKey,
    onEnded,
}: {
    hostId: string;
    sessionKey: string;
    onEnded: () => void;
}) {
    const { t } = useT();
    const container = useRef<HTMLDivElement>(null);
    const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
    // Changing it attaches again: Reconnect, or Backend coming back after a restart.
    const [attempt, setAttempt] = useState(0);
    const ended = useRef(onEnded);
    useEffect(() => {
        ended.current = onEnded;
    }, [onEnded]);

    useEffect(() => {
        let restarting = false;
        return onStatus(status => {
            if (status === 'restarting' || status === 'failed') {
                // Backend's terminals died with it and report no exit.
                restarting = true;
                setPhase({ kind: 'ended' });
            } else if (status === 'connected' && restarting) {
                restarting = false;
                setAttempt(value => value + 1);
            }
        });
    }, []);

    useEffect(() => {
        const element = container.current;
        if (!element) return;
        setPhase({ kind: 'connecting' });
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            fontSize: 13,
            scrollback: 5000,
            theme: { background: '#141416', foreground: '#e6e6e6' },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(element);
        fit.fit();

        let disposed = false;
        let terminalId: string | undefined;
        // Output arriving before `terminal.open` answers is kept for the id it turns out to have.
        const early: { terminalId: string; data: string }[] = [];
        let unacknowledged = 0;
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        const acknowledge = () => {
            ackTimer = undefined;
            if (!terminalId || unacknowledged === 0) return;
            const chars = unacknowledged;
            unacknowledged = 0;
            background(call('terminal.ack', { terminalId, chars }));
        };
        const show = (data: string) =>
            terminal.write(data, () => {
                unacknowledged += data.length;
                if (unacknowledged >= ackBatchChars) acknowledge();
                else ackTimer ??= setTimeout(acknowledge, ackDelayMs);
            });
        const finish = () => {
            if (disposed) return;
            terminalId = undefined;
            setPhase({ kind: 'ended' });
            ended.current();
        };

        const unsubscribe = subscribe(event => {
            if (event.type === 'terminal.output') {
                if (event.terminalId === terminalId) show(event.data);
                else if (!terminalId) early.push(event);
            } else if (event.type === 'terminal.exit' && event.terminalId === terminalId) finish();
        });
        const input = terminal.onData(data => {
            if (terminalId) background(call('terminal.input', { terminalId, data }));
        });
        const resized = terminal.onResize(({ cols, rows }) => {
            if (terminalId) background(call('terminal.resize', { terminalId, cols, rows }));
        });
        const observer = new ResizeObserver(() => fit.fit());
        observer.observe(element);

        call('terminal.open', {
            hostId,
            key: sessionKey,
            cols: terminal.cols,
            rows: terminal.rows,
        }).then(
            result => {
                if (disposed) {
                    background(call('terminal.close', { terminalId: result.terminalId }));
                    return;
                }
                terminalId = result.terminalId;
                for (const item of early.splice(0))
                    if (item.terminalId === terminalId) show(item.data);
                setPhase({ kind: 'open' });
                terminal.focus();
            },
            (error: unknown) => {
                if (disposed) return;
                setPhase({
                    kind: 'ended',
                    error: error instanceof ClientError ? error.message : String(error),
                });
                ended.current();
            }
        );

        return () => {
            disposed = true;
            if (ackTimer) clearTimeout(ackTimer);
            if (terminalId) background(call('terminal.close', { terminalId }));
            observer.disconnect();
            resized.dispose();
            input.dispose();
            unsubscribe();
            terminal.dispose();
        };
    }, [hostId, sessionKey, attempt]);

    return (
        // Edge to edge; the page panel's rounded corners clip it. The background matches the
        // terminal's so the columns the fit addon leaves over do not show as a border.
        <div className="relative flex min-h-0 flex-1 flex-col bg-[#141416]">
            <div
                ref={container}
                role="region"
                aria-label={t('coding.terminal')}
                className="min-h-0 flex-1 overflow-hidden"
            />
            {phase.kind !== 'open' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    {phase.kind === 'connecting' ? (
                        <span className="flex items-center gap-2 text-sm text-white/80">
                            <Spinner /> {t('coding.connecting')}
                        </span>
                    ) : (
                        <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                            <p className="text-sm text-white/90">
                                {phase.error ?? t('coding.ended')}
                            </p>
                            <Button
                                variant="secondary"
                                onClick={() => setAttempt(value => value + 1)}
                            >
                                <RotateCwIcon /> {t('coding.reconnect')}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
