import { useCallback, useEffect, useRef, useState } from 'react';

import { call, ClientError } from '../../lib/client';

import type { CodingInventory } from '../../../shared/ipc';

/** tmux has no change notifications, so the list is read again on this interval. */
const pollMs = 5000;

export interface Inventory {
    /** The latest listing; undefined until the first one for this host arrives. */
    readonly inventory: CodingInventory | undefined;
    /** Why the listing request itself failed. */
    readonly error: string | undefined;
    /** List again now. */
    readonly refresh: () => void;
}

/**
 * The tmux sessions of a host, listed while the page is mounted, one request at a time.
 * @param hostId `local` or a saved host's id.
 * @returns The listing.
 */
export function useInventory(hostId: string): Inventory {
    const [result, setResult] = useState<{
        hostId: string;
        inventory?: CodingInventory;
        error?: string;
    }>({ hostId });
    const wake = useRef<() => void>(() => undefined);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let running = false;
        let again = false;
        const list = async () => {
            if (running) {
                again = true;
                return;
            }
            running = true;
            if (timer) clearTimeout(timer);
            try {
                const inventory = await call('coding.sessions', { hostId });
                if (!stopped) setResult({ hostId, inventory });
            } catch (error) {
                if (!stopped)
                    setResult({
                        hostId,
                        error: error instanceof ClientError ? error.message : String(error),
                    });
            } finally {
                running = false;
                if (!stopped) {
                    if (again) {
                        again = false;
                        void list();
                    } else timer = setTimeout(() => void list(), pollMs);
                }
            }
        };
        wake.current = () => void list();
        void list();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [hostId]);

    const refresh = useCallback(() => wake.current(), []);
    const current = result.hostId === hostId ? result : { hostId };
    return { inventory: current.inventory, error: current.error, refresh };
}
