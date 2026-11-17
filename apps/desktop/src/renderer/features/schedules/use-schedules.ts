import { useCallback, useEffect, useRef, useState } from 'react';

import { scheduleListSchema } from '../../../shared/ipc';
import { call } from '../../lib/client';

import type { ScheduleList } from '../../../shared/ipc';

/**
 * Read current schedules while mounted, serializing refreshes and retaining stale data on errors.
 * @returns Current rows, query failure and an explicit refresh action.
 */
export function useSchedules() {
    const [schedules, setSchedules] = useState<ScheduleList>();
    const [error, setError] = useState<string>();
    const wake = useRef<() => Promise<void>>(async () => undefined);
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pending: Promise<void> | undefined;
        const refresh = (): Promise<void> => {
            if (pending) return pending;
            clearTimeout(timer);
            pending = call('schedule.list', {})
                .then(value => {
                    const rows = scheduleListSchema.parse(value);
                    if (!stopped) {
                        setSchedules(rows);
                        setError(undefined);
                    }
                })
                .catch((cause: unknown) => {
                    if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
                })
                .finally(() => {
                    pending = undefined;
                    if (!stopped) timer = setTimeout(() => void refresh(), 5000);
                });
            return pending;
        };
        wake.current = refresh;
        void refresh();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, []);
    const refresh = useCallback(() => wake.current(), []);
    return { schedules, error, refresh };
}
