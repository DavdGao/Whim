import { AlertCircleIcon } from 'lucide-react';

import { useT } from '../../lib/i18n';

import type { Failure } from '@whimkit/core/contracts';
import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Show a failure: translated category first, provider detail beneath.
 * @param props The failure, a title, and optional actions.
 * @param props.failure The failure.
 * @param props.title Heading text.
 * @param props.action Optional action buttons.
 * @returns The alert.
 */
export function FailureNotice({
    failure,
    title,
    action,
}: {
    failure: Failure;
    title: string;
    action?: ReactNode;
}) {
    const { t } = useT();
    const detail = failure.detail;
    const parts = detail
        ? [detail.status ? `HTTP ${detail.status}` : undefined, detail.code, detail.message].filter(
              Boolean
          )
        : [];
    return (
        <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
                <p>{t(`failure.${failure.category}`)}</p>
                {parts.length > 0 && (
                    <p className="font-mono text-xs break-all opacity-80">
                        {t('failure.detail')}: {parts.join(' · ')}
                        {detail?.requestId ? ` · ${detail.requestId}` : ''}
                    </p>
                )}
                {action && <div className="mt-2 flex gap-2">{action}</div>}
            </AlertDescription>
        </Alert>
    );
}
