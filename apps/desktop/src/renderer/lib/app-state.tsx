import { useCallback, useEffect, useState } from 'react';

import { AppStateContext } from './app-state-context';
import { call, ClientError, onStatus, subscribe } from './client';

import type { AppStateValue } from './app-state-context';
import type { AppState } from '../../shared/ipc';
import type { ReactNode } from 'react';

/**
 * Load application state and refresh it when Backend reports changes.
 * @param props Children.
 * @param props.children Descendants.
 * @returns The provider.
 */
export function AppStateProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AppState>();
    const [status, setStatus] = useState<AppStateValue['status']>('connecting');
    const [error, setError] = useState<string>();

    const refresh = useCallback(
        () =>
            call('app.state', {}).then(
                next => {
                    setState(next);
                    setError(undefined);
                },
                (failure: unknown) =>
                    setError(failure instanceof ClientError ? failure.message : String(failure))
            ),
        []
    );

    useEffect(() => {
        const unsubscribe = subscribe(event => {
            if (event.type === 'state') void refresh();
        });
        const unwatch = onStatus(next => {
            if (next === 'connected' || next === 'restarting' || next === 'failed') setStatus(next);
        });
        void refresh();
        return () => {
            unsubscribe();
            unwatch();
        };
    }, [refresh]);

    // Connected once state has loaded, unless Backend reported otherwise.
    const effective = status === 'connecting' && state ? 'connected' : status;
    return (
        <AppStateContext.Provider value={{ state, status: effective, error, refresh }}>
            {children}
        </AppStateContext.Provider>
    );
}
