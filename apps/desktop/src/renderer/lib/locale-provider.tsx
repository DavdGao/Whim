import { LocaleContext } from './i18n';

import type { Locale } from '../../shared/ipc';
import type { ReactNode } from 'react';

/**
 * Provide the active locale.
 * @param props Locale and children.
 * @param props.locale The active locale.
 * @param props.children Descendants.
 * @returns The provider.
 */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
    return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
