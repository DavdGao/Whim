import { cn } from 'cn';
import { Label as LabelPrimitive } from 'radix-ui';
import * as React from 'react';

/**
 *
 * @param root0
 * @param root0.className
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
    return (
        <LabelPrimitive.Root
            data-slot="label"
            className={cn(
                'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
                className
            )}
            {...props}
        />
    );
}

export { Label };
