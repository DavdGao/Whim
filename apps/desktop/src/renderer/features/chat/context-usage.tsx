import { useT } from '../../lib/i18n';

import type { Usage } from '@whimkit/core/contracts';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/** Compaction starts at this share of the context window (agent.md §5). */
const compactionShare = 0.8;

/**
 * The ring's tone as the conversation nears compaction.
 * @param fraction Used share of the compaction threshold, 0–1.
 * @returns A stroke class.
 */
function tone(fraction: number): string {
    if (fraction >= 0.9) return 'stroke-destructive';
    if (fraction >= 0.7) return 'stroke-amber-500';
    return 'stroke-foreground/70';
}

/**
 * How close the conversation is to compaction, as a ring that fills and changes colour near
 * the threshold. Hover shows the numbers; unknown fields stay unknown.
 * @param props Usage props.
 * @param props.usage The latest attempt's usage, if reported.
 * @param props.contextWindow The model's context window in tokens.
 * @returns The indicator, or nothing before the first reply.
 */
export function ContextUsage({
    usage,
    contextWindow,
}: {
    usage: Usage | undefined;
    contextWindow: number;
}) {
    const { t, locale } = useT();
    if (!usage || usage.inputTokens === undefined) return null;
    const used = usage.inputTokens + (usage.outputTokens ?? 0);
    const threshold = Math.floor(contextWindow * compactionShare);
    const fraction = Math.min(1, used / threshold);
    const percent = Math.round(fraction * 100);
    const format = new Intl.NumberFormat(locale, { notation: 'compact' });
    const radius = 7;
    const circumference = 2 * Math.PI * radius;
    const rows: [string, number | undefined][] = [
        [t('context.input'), usage.inputTokens],
        [t('context.cached'), usage.cachedInputTokens],
        [t('context.output'), usage.outputTokens],
        [t('context.reasoning'), usage.reasoningTokens],
    ];
    return (
        <HoverCard openDelay={10} closeDelay={100}>
            <HoverCardTrigger asChild>
                <button
                    type="button"
                    aria-label={t('context.label', { percent })}
                    className="hover:bg-accent focus-visible:ring-ring/50 flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-3"
                >
                    <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90" aria-hidden="true">
                        <circle
                            cx="9"
                            cy="9"
                            r={radius}
                            fill="none"
                            strokeWidth="3"
                            className="stroke-muted-foreground/30"
                        />
                        <circle
                            cx="9"
                            cy="9"
                            r={radius}
                            fill="none"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeDasharray={circumference}
                            strokeDashoffset={circumference * (1 - Math.max(fraction, 0.02))}
                            className={cn('transition-[stroke-dashoffset]', tone(fraction))}
                        />
                    </svg>
                </button>
            </HoverCardTrigger>
            <HoverCardContent align="end" className="flex w-72 flex-col gap-4 rounded-2xl p-5">
                <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{t('context.title')}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                        {format.format(used)} / {format.format(threshold)}
                    </span>
                </div>
                <Progress value={percent} aria-label={t('context.title')} />
                <dl className="flex flex-col gap-1.5 text-xs">
                    {rows.map(([label, value]) => (
                        <div key={label} className="flex justify-between">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="tabular-nums">
                                {value === undefined ? '—' : format.format(value)}
                            </dd>
                        </div>
                    ))}
                </dl>
                <p className="text-muted-foreground text-xs leading-relaxed">
                    {t('context.hint', { window: format.format(contextWindow) })}
                </p>
            </HoverCardContent>
        </HoverCard>
    );
}
