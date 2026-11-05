import { applyRecord } from '@whimkit/core/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { call, ClientError, subscribe } from '../../lib/client';

import type { SessionSnapshot } from '../../../shared/ipc';
import type { Failure, SessionView } from '@whimkit/core/contracts';

export interface Draft {
    readonly attemptId: string;
    readonly text: string;
    readonly reasoning: string;
}

export interface SessionState {
    readonly view: SessionView | undefined;
    readonly draft: Draft | undefined;
    /** Failure of an attempt whose text was discarded before a retry. */
    readonly discarded: Failure | undefined;
    readonly error: string | undefined;
    /** The session's own working folder, used while the user has chosen none. */
    readonly defaultWorkspace?: string;
}

/**
 * Rebuild a view from a snapshot.
 * @param snapshot The copyable snapshot.
 * @returns The view.
 */
function fromSnapshot(snapshot: SessionSnapshot): SessionView {
    const { pending, defaultWorkspace: _default, ...rest } = snapshot;
    return { ...rest, inbox: new Map(pending.map(item => [item.deliveryId, item])) };
}

/**
 * Observe one session: load a snapshot, then apply committed records incrementally by sequence
 * and render transient stream deltas as a draft.
 * @param sessionId The session, or undefined.
 * @returns The live session state.
 */
export function useSession(sessionId: string | undefined): SessionState {
    const [state, setState] = useState<SessionState>({
        view: undefined,
        draft: undefined,
        discarded: undefined,
        error: undefined,
    });
    const viewRef = useRef<SessionView | undefined>(undefined);
    const pendingDeltas = useRef<{ attemptId: string; part: 'text' | 'reasoning'; text: string }[]>(
        []
    );
    const frame = useRef<number | undefined>(undefined);

    const load = useCallback(async (id: string) => {
        try {
            const snapshot = await call('session.get', { sessionId: id });
            const view = fromSnapshot(snapshot);
            viewRef.current = view;
            setState(current => ({
                ...current,
                view,
                error: undefined,
                defaultWorkspace: snapshot.defaultWorkspace,
            }));
        } catch (error) {
            setState(current => ({
                ...current,
                error: error instanceof ClientError ? error.message : String(error),
            }));
        }
    }, []);

    useEffect(() => {
        viewRef.current = undefined;
        setState({ view: undefined, draft: undefined, discarded: undefined, error: undefined });
        if (!sessionId) return;
        void load(sessionId);
        const finishedAttempts = new Set<string>();
        // Coalesce stream deltas to one render per animation frame.
        const flush = () => {
            frame.current = undefined;
            const deltas = pendingDeltas.current.splice(0);
            if (!deltas.length) return;
            setState(current => {
                let draft = current.draft;
                for (const delta of deltas) {
                    if (draft?.attemptId !== delta.attemptId)
                        draft = { attemptId: delta.attemptId, text: '', reasoning: '' };
                    draft =
                        delta.part === 'text'
                            ? { ...draft, text: draft.text + delta.text }
                            : { ...draft, reasoning: draft.reasoning + delta.text };
                }
                return { ...current, draft, discarded: undefined };
            });
        };
        const unsubscribe = subscribe(event => {
            if (!('sessionId' in event) || event.sessionId !== sessionId) return;
            if (event.type === 'stream') {
                if (finishedAttempts.has(event.attemptId)) return;
                pendingDeltas.current.push(event);
                frame.current ??= requestAnimationFrame(flush);
            } else if (event.type === 'discarded') {
                pendingDeltas.current = pendingDeltas.current.filter(
                    delta => delta.attemptId !== event.attemptId
                );
                setState(current => ({
                    ...current,
                    draft: current.draft?.attemptId === event.attemptId ? undefined : current.draft,
                    discarded: event.failure,
                }));
            } else if (event.type === 'records') {
                let view = viewRef.current;
                if (!view) return;
                try {
                    for (const record of event.records) {
                        if (record.seq <= view.head) continue;
                        view = applyRecord(view, record);
                    }
                } catch {
                    // A gap or reordering: reload from the committed journal.
                    void load(sessionId);
                    return;
                }
                viewRef.current = view;
                let finished = false;
                for (const record of event.records)
                    if (record.body.type === 'attempt.finished') {
                        finished = true;
                        // Deltas still waiting for a frame belong to committed text now.
                        finishedAttempts.add(record.body.attemptId);
                    }
                if (finished)
                    pendingDeltas.current = pendingDeltas.current.filter(
                        delta => !finishedAttempts.has(delta.attemptId)
                    );
                setState(current => ({
                    ...current,
                    view,
                    ...(finished ? { draft: undefined } : {}),
                    ...(view.run ? {} : { discarded: undefined }),
                }));
            }
        });
        return () => {
            unsubscribe();
            if (frame.current !== undefined) cancelAnimationFrame(frame.current);
            frame.current = undefined;
            pendingDeltas.current = [];
        };
    }, [sessionId, load]);

    return state;
}
