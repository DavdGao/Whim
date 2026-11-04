import { useAction } from '../lib/use-action';

import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export type ActionButtonProps = Omit<ComponentProps<typeof Button>, 'onClick' | 'asChild'> & {
    /** Shown before the label; replaced by a spinner while the action runs. */
    readonly icon: ReactNode;
    readonly action: () => Promise<unknown>;
};

/**
 * A button that runs a business action, showing a spinner and staying disabled until it settles.
 * @param props Button props plus the icon and action.
 * @param props.icon The leading icon.
 * @param props.action The command to run.
 * @param props.disabled Extra disabled condition.
 * @param props.children The label.
 * @returns The button.
 */
export function ActionButton({ icon, action, disabled, children, ...props }: ActionButtonProps) {
    const { run, pending } = useAction(action);
    return (
        <Button
            {...props}
            disabled={disabled || pending}
            aria-busy={pending || undefined}
            onClick={() => void run()}
        >
            {pending ? <Spinner /> : icon}
            {children}
        </Button>
    );
}
