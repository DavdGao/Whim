import { createContext, useContext } from 'react';

import type { AppState } from '../../shared/ipc';

export interface AppStateValue {
    readonly state: AppState | undefined;
    readonly status: 'connecting' | 'connected' | 'restarting' | 'failed';
    readonly error: string | undefined;
    readonly refresh: () => Promise<void>;
}

export const AppStateContext = createContext<AppStateValue | undefined>(undefined);

/**
 * Access application state.
 * @returns The context value.
 */
export function useAppState(): AppStateValue {
    const value = useContext(AppStateContext);
    if (!value) throw new Error('useAppState must be used inside AppStateProvider.');
    return value;
}
