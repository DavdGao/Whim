import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A plugin-provided image, or a generic glyph when there is none.
 * @param props Icon props.
 * @param props.src The image as a data URL.
 * @param props.fallback Glyph used without an image.
 * @param props.className Size and placement.
 * @returns The icon.
 */
export function EntityIcon({
    src,
    fallback: Fallback,
    className,
}: {
    src: string | undefined;
    fallback: LucideIcon;
    className?: string;
}) {
    return src ? (
        <img src={src} alt="" className={cn('size-4 shrink-0', className)} />
    ) : (
        <Fallback className={cn('size-4 shrink-0', className)} />
    );
}
