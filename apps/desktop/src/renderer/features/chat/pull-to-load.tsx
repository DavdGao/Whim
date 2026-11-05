import { ArrowDownIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';

import { useT } from '../../lib/i18n';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** How far the content follows the pull before earlier messages load, in pixels. */
const threshold = 72;
const maxPull = 110;
/** The pull springs back after this long without wheel input. */
const idleMs = 160;

/**
 * Pull past the top of the conversation to load earlier messages: the content follows the
 * wheel with resistance, loads once pulled far enough, keeps the reading position when the
 * earlier page arrives, and springs back with a small bounce. No button is involved.
 * @param props Pull props.
 * @param props.enabled Whether earlier messages exist.
 * @param props.onLoad Load the previous page.
 * @param props.loaded How many earlier entries are loaded; a change means a page arrived.
 * @returns The pull indicator.
 */
export function PullToLoad({
    enabled,
    onLoad,
    loaded,
}: {
    enabled: boolean;
    onLoad: () => Promise<void>;
    loaded: number;
}) {
    const { t } = useT();
    const { scrollRef, contentRef } = useStickToBottomContext();
    const [pull, setPull] = useState(0);
    const [loading, setLoading] = useState(false);
    const state = useRef({ pull: 0, loading: false, height: 0 });

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller || !enabled) return;
        const move = (distance: number, spring: boolean) => {
            state.current.pull = distance;
            setPull(distance);
            const content = contentRef.current;
            if (!content) return;
            // An overshooting curve gives the release its bounce.
            content.style.transition = spring
                ? 'transform 360ms cubic-bezier(0.34, 1.56, 0.64, 1)'
                : 'none';
            content.style.transform = distance ? `translateY(${distance}px)` : '';
        };
        let idle: ReturnType<typeof setTimeout> | undefined;
        const release = () => {
            if (!state.current.loading) move(0, true);
        };
        const onWheel = (event: WheelEvent) => {
            if (state.current.loading) return;
            if (scroller.scrollTop > 0 || event.deltaY >= 0) {
                if (state.current.pull > 0) release();
                return;
            }
            event.preventDefault();
            // Resistance grows as the pull lengthens.
            const resistance = 1 - state.current.pull / maxPull;
            move(Math.min(maxPull, state.current.pull - event.deltaY * 0.35 * resistance), false);
            clearTimeout(idle);
            if (state.current.pull >= threshold) {
                state.current.loading = true;
                state.current.height = scroller.scrollHeight;
                setLoading(true);
                move(threshold * 0.6, true);
                onLoad().finally(() => {
                    state.current.loading = false;
                    setLoading(false);
                    move(0, true);
                });
                return;
            }
            idle = setTimeout(release, idleMs);
        };
        scroller.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            clearTimeout(idle);
            scroller.removeEventListener('wheel', onWheel);
        };
    }, [enabled, onLoad, scrollRef, contentRef]);

    // Earlier entries grow the content above the reading position; keep that position in view.
    useLayoutEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller || !state.current.height) return;
        scroller.scrollTop += scroller.scrollHeight - state.current.height;
        state.current.height = 0;
    }, [loaded, scrollRef]);

    if (!enabled && !loading) return null;
    const progress = Math.min(1, pull / threshold);
    return (
        <div
            aria-live="polite"
            className={cn(
                'text-muted-foreground pointer-events-none absolute inset-x-0 top-2 z-10 flex items-center justify-center gap-2 text-xs transition-opacity',
                pull === 0 && !loading && 'opacity-0'
            )}
            style={pull || loading ? { opacity: loading ? 1 : progress } : undefined}
        >
            {loading ? (
                <Spinner className="size-3.5" />
            ) : (
                <ArrowDownIcon
                    className="size-3.5 transition-transform"
                    style={{ transform: `rotate(${progress >= 1 ? 180 : 0}deg)` }}
                />
            )}
            {loading ? t('chat.loadingEarlier') : t('chat.pullEarlier')}
        </div>
    );
}
