import type { BackendEvent, IpcError, Method, Params, Results } from '../../shared/ipc';

interface Bridge {
    invoke(method: string, params: unknown): Promise<unknown>;
    onEvent(listener: (event: unknown) => void): () => void;
    onStatus(listener: (status: string) => void): () => void;
}

declare global {
    interface Window {
        readonly whim: Bridge;
    }
}

const eventTypes = new Set(['state', 'records', 'stream', 'discarded']);

/** An IPC failure surfaced to components. */
export class ClientError extends Error {
    readonly error: IpcError;

    /**
     * Wrap a Backend error.
     * @param error The serialized error.
     */
    constructor(error: IpcError) {
        super(error.message);
        this.name = 'ClientError';
        this.error = error;
    }
}

/**
 * Normalize a rejected bridge value into an IPC error.
 * @param value The rejection reason.
 * @returns The error.
 */
function asIpcError(value: unknown): IpcError {
    if (typeof value === 'object' && value !== null && 'code' in value && 'message' in value)
        return value as IpcError;
    return { code: 'internal', message: String(value) };
}

/**
 * Call a Backend method.
 * @param method The method.
 * @param params Its parameters.
 * @returns The typed result.
 */
export async function call<M extends Method>(method: M, params: Params<M>): Promise<Results[M]> {
    try {
        return (await window.whim.invoke(method, params)) as Results[M];
    } catch (error) {
        throw new ClientError(asIpcError(error));
    }
}

/**
 * Subscribe to Backend events.
 * @param listener Receives validated events.
 * @returns An unsubscribe function.
 */
export function subscribe(listener: (event: BackendEvent) => void): () => void {
    return window.whim.onEvent(event => {
        if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            eventTypes.has(String(event.type))
        )
            listener(event as BackendEvent);
    });
}

/**
 * Subscribe to Backend connection status.
 * @param listener Receives `connected`, `restarting`, or `failed`.
 * @returns An unsubscribe function.
 */
export function onStatus(listener: (status: string) => void): () => void {
    return window.whim.onStatus(listener);
}
