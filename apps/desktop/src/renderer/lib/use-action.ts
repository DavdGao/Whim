import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ClientError } from './client';
import { useT } from './i18n';

export interface Action<Args extends unknown[]> {
    /** Start the action; ignored while one is already running. Never rejects. */
    readonly run: (...args: Args) => Promise<void>;
    readonly pending: boolean;
}

/**
 * Track one asynchronous business action: busy while it runs, errors reported as toasts.
 * @param action The command to run.
 * @returns The runner and its busy state.
 */
export function useAction<Args extends unknown[]>(
    action: (...args: Args) => Promise<unknown>
): Action<Args> {
    const { t } = useT();
    const [pending, setPending] = useState(false);
    const running = useRef(false);
    const run = useCallback(
        async (...args: Args) => {
            if (running.current) return;
            running.current = true;
            setPending(true);
            try {
                await action(...args);
            } catch (error) {
                toast.error(error instanceof ClientError ? error.message : t('error.generic'));
            } finally {
                running.current = false;
                setPending(false);
            }
        },
        [action, t]
    );
    return { run, pending };
}
