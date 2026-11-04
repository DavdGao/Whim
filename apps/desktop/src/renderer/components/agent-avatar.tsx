import logo from '../assets/whim.svg';

import { cn } from '@/lib/utils';

/**
 * The agent's icon: the user's image, or the Whim mark by default.
 * @param props Avatar props.
 * @param props.icon The custom icon as a data URL.
 * @param props.className Size and placement.
 * @returns The image.
 */
export function AgentAvatar({
    icon,
    className,
}: {
    icon?: string | undefined;
    className?: string;
}) {
    return (
        <img
            src={icon ?? logo}
            alt=""
            className={cn('size-8 shrink-0 rounded-xl object-cover', className)}
        />
    );
}
