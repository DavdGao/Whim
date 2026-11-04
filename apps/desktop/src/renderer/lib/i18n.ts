import { createContext, useCallback, useContext } from 'react';

import { catalogs, en } from './messages';

import type { MessageKey } from './messages';
import type { Locale } from '../../shared/ipc';

export const LocaleContext = createContext<Locale>('en');

/**
 * Translation function for the active locale, with English fallback and `{name}` placeholders.
 * @returns `t(key, values)` and the locale.
 */
export function useT() {
    const locale = useContext(LocaleContext);
    const t = useCallback(
        (key: MessageKey, values?: Record<string, string | number>) => {
            const template = catalogs[locale][key] ?? en[key];
            return template.replace(/\{(\w+)\}/g, (match, name: string) =>
                String(values?.[name] ?? match)
            );
        },
        [locale]
    );
    return { t, locale };
}
