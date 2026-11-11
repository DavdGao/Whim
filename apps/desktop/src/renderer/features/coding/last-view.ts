import { z } from 'zod';

// The computer and, per computer, the session last opened on the Coding page, so the page opens
// where the user left it. A view preference of this window, not business state: it lives in
// localStorage, and losing it only means the user picks again.

const storageKey = 'whim.coding.lastView';

const lastViewSchema = z.object({
    hostId: z.string(),
    sessions: z.record(z.string(), z.string()),
});

export type LastView = z.infer<typeof lastViewSchema>;

/**
 * Read the last view.
 * @returns It, or this Mac with no session when nothing valid is stored.
 */
export function readLastView(): LastView {
    try {
        const raw = localStorage.getItem(storageKey);
        const parsed = raw ? lastViewSchema.safeParse(JSON.parse(raw)) : undefined;
        if (parsed?.success) return parsed.data;
    } catch {
        // Unreadable storage or JSON: start from the default.
    }
    return { hostId: 'local', sessions: {} };
}

/**
 * Store the last view; a failure to store is ignored, as the view is only a convenience.
 * @param view The view.
 */
export function writeLastView(view: LastView): void {
    try {
        localStorage.setItem(storageKey, JSON.stringify(view));
    } catch {
        // Storage unavailable or full: the page still works, it just will not remember.
    }
}
