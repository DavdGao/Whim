import { useCallback, useEffect, useRef, useState } from 'react';

import type { Command, DesktopClient, Snapshot } from '../contracts.js';
import type { Failure } from '@whimkit/core';

declare global {
    interface Window {
        whim: DesktopClient;
    }
}

/**
 * Observe bounded transcript pages; backend owns execution after UI disposal.
 * @returns Current state and the typed command dispatcher.
 */
export function useChat() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [failure, setFailure] = useState<Failure>();
    const current = useRef<Snapshot | undefined>(undefined);
    const serial = useRef(0);
    const busy = useRef(false);
    const mounted = useRef(true);
    const invoke = useCallback(async (command: Command) => {
        const ticket = ++serial.current;
        busy.current = true;
        try {
            const result = await window.whim.invoke(command);
            if (!mounted.current || ticket !== serial.current) return result.ok;
            if (!result.ok) {
                setFailure(result.failure);
                return false;
            }
            const next = result.snapshot;
            const previous = current.current;
            if (
                next.page &&
                previous?.page &&
                next.selectedId === previous.selectedId &&
                !(command.type === 'snapshot' && command.sessionId && !command.refresh)
            ) {
                const older = command.type === 'history';
                const messages = older
                    ? [...next.page.messages, ...previous.page.messages]
                    : [...previous.page.messages, ...next.page.messages];
                next.page.messages = [
                    ...new Map(messages.map(message => [message.id, message])).values(),
                ];
                if (!older) next.page.beforeId = previous.page.beforeId;
            }
            current.current = next;
            setSnapshot(next);
            if (command.type !== 'snapshot' && command.type !== 'history') setFailure(undefined);
            return true;
        } catch {
            if (mounted.current)
                setFailure({ category: 'internal', retry: 'never', outcome: 'unknown' });
            return false;
        } finally {
            if (ticket === serial.current) busy.current = false;
        }
    }, []);
    useEffect(() => {
        mounted.current = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;
        const refresh = () => {
            if (timer || disposed) return;
            timer = setTimeout(() => {
                timer = undefined;
                if (busy.current) {
                    refresh();
                    return;
                }
                // No sessionId means refresh the selected view rather than navigate/reset it.
                void invoke({
                    type: 'snapshot',
                    sessionId: current.current?.selectedId,
                    refresh: true,
                });
            }, 50);
        };
        const dispose = window.whim.subscribe(refresh);
        refresh();
        return () => {
            disposed = true;
            mounted.current = false;
            dispose();
            clearTimeout(timer);
        };
    }, [invoke]);
    return { snapshot, failure, invoke };
}
