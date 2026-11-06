import { useLayoutEffect } from 'react';

import type { AppState } from '../../shared/ipc';

/**
 * Apply the chosen plugin theme's tokens to the document (design.md §5.7), and remove them when
 * the theme changes. The application has a light appearance only, so the `light` set applies.
 * @param state Application state.
 * @returns The chosen theme's background image URL, if it has one.
 */
export function useTheme(state: AppState | undefined): string | undefined {
    const theme = state?.themes.find(item => item.id === state.theme);
    // State refreshes bring new objects; only a change of values reapplies them.
    const values = theme ? JSON.stringify(theme.light) : undefined;
    useLayoutEffect(() => {
        if (!values) return;
        const root = document.documentElement;
        const tokens = Object.entries(JSON.parse(values) as Record<string, string>);
        for (const [token, value] of tokens) root.style.setProperty(`--${token}`, value);
        return () => {
            for (const [token] of tokens) root.style.removeProperty(`--${token}`);
        };
    }, [values]);
    return theme?.image;
}
