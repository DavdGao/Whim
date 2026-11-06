import { Alert, AlertDescription, AlertTitle } from '@whimkit/ui/components/alert';
import { cn } from '@whimkit/ui/lib/utils';
import { AlertCircleIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';

import type { ReactNode } from 'react';

export type StatusTone = 'error' | 'warning' | 'info';

/** Border, surface, and text share one hue per tone, so the box reads as a single unit. */
const tones: Record<StatusTone, { className: string; icon: ReactNode }> = {
    error: {
        className:
            'border-destructive/30 bg-destructive/5 text-destructive *:data-[slot=alert-description]:text-destructive/85',
        icon: <AlertCircleIcon />,
    },
    warning: {
        className:
            'border-amber-500/35 bg-amber-500/8 text-amber-700 *:data-[slot=alert-description]:text-amber-700/85 dark:text-amber-400 dark:*:data-[slot=alert-description]:text-amber-400/85',
        icon: <TriangleAlertIcon />,
    },
    info: {
        className:
            'border-sky-500/30 bg-sky-500/5 text-sky-700 *:data-[slot=alert-description]:text-sky-700/85 dark:text-sky-400 dark:*:data-[slot=alert-description]:text-sky-400/85',
        icon: <InfoIcon />,
    },
};

/**
 * An error, warning, or informational box tinted as a whole: border, background, icon, and text.
 * @param props Alert props.
 * @param props.tone Error, warning, or info.
 * @param props.title Optional heading.
 * @param props.children The message.
 * @param props.className Extra layout classes.
 * @returns The alert.
 */
export function StatusAlert({
    tone,
    title,
    children,
    className,
}: {
    tone: StatusTone;
    title?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    const style = tones[tone];
    return (
        <Alert className={cn('rounded-2xl px-3.5 py-3', style.className, className)}>
            {style.icon}
            {title && <AlertTitle>{title}</AlertTitle>}
            {children && <AlertDescription>{children}</AlertDescription>}
        </Alert>
    );
}
