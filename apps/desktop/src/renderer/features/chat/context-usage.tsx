import { useT } from '../../lib/i18n';

import type { Usage } from '@whimkit/core/contracts';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Progress } from '@/components/ui/progress';

/**
 * A small ring showing a fraction.
 * @param props Ring props.
 * @param props.percent 0–100.
 * @returns The SVG ring.
 */
function Ring({ percent }: { percent: number }) {
    const radius = 7;
    const circumference = 2 * Math.PI * radius;
    return (
        <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden="true">
            <circle
                cx="9"
                cy="9"
                r={radius}
                fill="none"
                strokeWidth="2.5"
                className="stroke-muted"
            />
            <circle
                cx="9"
                cy="9"
                r={radius}
                fill="none"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - percent / 100)}
                className={percent >= 80 ? 'stroke-destructive' : 'stroke-primary'}
            />
        </svg>
    );
}

/**
 * How much of the model's context window the conversation uses, from the latest reported
 * usage. Hover shows the breakdown; unknown fields stay unknown.
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
    const percent = Math.min(100, Math.round((used / contextWindow) * 100));
    const format = new Intl.NumberFormat(locale, { notation: 'compact' });
    const rows: [string, number | undefined][] = [
        [t('context.input'), usage.inputTokens],
        [t('context.cached'), usage.cachedInputTokens],
        [t('context.output'), usage.outputTokens],
        [t('context.reasoning'), usage.reasoningTokens],
    ];
    return (
        <HoverCard openDelay={10} closeDelay={100}>
            <HoverCardTrigger asChild>
                <Button type="button" variant="ghost" size="sm" aria-label={t('context.title')}>
                    <Ring percent={percent} />
                    <span className="text-muted-foreground tabular-nums">
                        {used > 0 && percent === 0 ? '<1' : percent}%
                    </span>
                </Button>
            </HoverCardTrigger>
            <HoverCardContent align="end" className="flex w-64 flex-col gap-3 rounded-2xl">
                <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{t('context.title')}</span>
                    <span className="text-muted-foreground tabular-nums">
                        {format.format(used)} / {format.format(contextWindow)}
                    </span>
                </div>
                <Progress value={percent} aria-label={t('context.title')} />
                <dl className="flex flex-col gap-1 text-xs">
                    {rows.map(([label, value]) => (
                        <div key={label} className="flex justify-between">
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className="tabular-nums">
                                {value === undefined ? '—' : format.format(value)}
                            </dd>
                        </div>
                    ))}
                </dl>
                <p className="text-muted-foreground text-xs">{t('context.hint')}</p>
            </HoverCardContent>
        </HoverCard>
    );
}
