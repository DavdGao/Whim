import { cn } from 'cn';

/**
 *
 * @param root0
 * @param root0.className
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="skeleton"
            className={cn('animate-pulse rounded-md bg-muted', className)}
            {...props}
        />
    );
}

export { Skeleton };
