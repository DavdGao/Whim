import { cn } from 'cn';
import { Separator as SeparatorPrimitive } from 'radix-ui';
import * as React from 'react';

/**
 *
 * @param root0
 * @param root0.className
 * @param root0.orientation
 * @param root0.decorative
 */
function Separator({
    className,
    orientation = 'horizontal',
    decorative = true,
    ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
    return (
        <SeparatorPrimitive.Root
            data-slot="separator"
            decorative={decorative}
            orientation={orientation}
            className={cn(
                'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch',
                className
            )}
            {...props}
        />
    );
}

export { Separator };
