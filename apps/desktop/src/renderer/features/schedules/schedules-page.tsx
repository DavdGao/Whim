import { Badge } from '@whimkit/ui/components/badge';
import { Button } from '@whimkit/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@whimkit/ui/components/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@whimkit/ui/components/empty';
import { Spinner } from '@whimkit/ui/components/spinner';
import { MessageSquareIcon, RefreshCwIcon } from 'lucide-react';

import { ActionButton } from '../../components/action-button';
import { StatusAlert } from '../../components/status-alert';
import { useT } from '../../lib/i18n';

import { useSchedules } from './use-schedules';

import type { PageProps } from '../../lib/navigation';

/**
 * Current schedules across conversations, with their persisted timing and delivery settings.
 * @param props Page inputs.
 * @param props.state Application state for conversation names.
 * @param props.navigate Open the owning conversation.
 * @returns The schedules page.
 */
export function SchedulesPage({ state, navigate }: PageProps) {
    const { t, locale } = useT();
    const { schedules, error, refresh } = useSchedules();
    return (
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold">{t('nav.schedules')}</h1>
                    <p className="text-muted-foreground text-sm">{t('schedules.description')}</p>
                </div>
                <ActionButton icon={<RefreshCwIcon />} action={refresh}>
                    {t('schedules.refresh')}
                </ActionButton>
            </div>
            {error && (
                <StatusAlert tone="error">
                    {t('schedules.error')} {error}
                </StatusAlert>
            )}
            {!schedules && !error && (
                <div
                    role="status"
                    className="text-muted-foreground flex items-center gap-2 text-sm"
                >
                    <Spinner /> {t('schedules.loading')}
                </div>
            )}
            {schedules && (
                <>
                    <div className="text-muted-foreground flex flex-wrap gap-3 text-sm">
                        <span>{t('schedules.count', { count: schedules.length })}</span>
                        <span>
                            {t('schedules.activeCount', {
                                count: schedules.filter(item => !item.paused).length,
                            })}
                        </span>
                        <span>
                            {t('schedules.pausedCount', {
                                count: schedules.filter(item => item.paused).length,
                            })}
                        </span>
                    </div>
                    {schedules.length === 0 ? (
                        <Empty>
                            <EmptyHeader>
                                <EmptyTitle>{t('schedules.empty')}</EmptyTitle>
                                <EmptyDescription>
                                    {t('schedules.emptyDescription')}
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : (
                        <ul className="flex flex-col gap-3">
                            {schedules.map(schedule => {
                                const session = state.sessions.find(
                                    item => item.sessionId === schedule.sessionId
                                );
                                const timezone =
                                    schedule.timing.kind === 'cron'
                                        ? schedule.timing.timezone
                                        : Intl.DateTimeFormat().resolvedOptions().timeZone;
                                const dates = new Intl.DateTimeFormat(locale, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                    timeZone: timezone,
                                });
                                const fields = [
                                    [
                                        t('schedules.timing'),
                                        schedule.timing.kind === 'cron'
                                            ? schedule.timing.cron
                                            : dates.format(new Date(schedule.timing.at)),
                                    ],
                                    [t('schedules.timezone'), timezone],
                                    [
                                        t('schedules.next'),
                                        schedule.nextFire
                                            ? dates.format(new Date(schedule.nextFire))
                                            : t('schedules.none'),
                                    ],
                                    [
                                        t('schedules.last'),
                                        schedule.lastFire
                                            ? dates.format(new Date(schedule.lastFire))
                                            : t('schedules.never'),
                                    ],
                                    [
                                        t('schedules.missed'),
                                        t(
                                            schedule.missed === 'skip'
                                                ? 'schedules.skip'
                                                : 'schedules.once'
                                        ),
                                    ],
                                    [
                                        t('schedules.created'),
                                        dates.format(new Date(schedule.createdAt)),
                                    ],
                                ];
                                return (
                                    <li key={schedule.id}>
                                        <Card>
                                            <CardHeader>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <CardTitle className="min-w-0 break-words">
                                                        {schedule.name}
                                                    </CardTitle>
                                                    <Badge
                                                        variant={
                                                            schedule.paused
                                                                ? 'outline'
                                                                : 'secondary'
                                                        }
                                                    >
                                                        {t(
                                                            schedule.paused
                                                                ? 'schedules.paused'
                                                                : 'schedules.active'
                                                        )}
                                                    </Badge>
                                                    <Badge variant="outline">
                                                        {t(
                                                            schedule.timing.kind === 'cron'
                                                                ? 'schedules.repeating'
                                                                : 'schedules.single'
                                                        )}
                                                    </Badge>
                                                </div>
                                            </CardHeader>
                                            <CardContent className="flex flex-col gap-4">
                                                <p className="text-sm whitespace-pre-wrap wrap-anywhere">
                                                    {schedule.message}
                                                </p>
                                                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
                                                    {fields.map(([label, value]) => (
                                                        <div key={label}>
                                                            <dt className="text-muted-foreground text-xs">
                                                                {label}
                                                            </dt>
                                                            <dd className="mt-1 text-sm tabular-nums wrap-anywhere">
                                                                {value}
                                                            </dd>
                                                        </div>
                                                    ))}
                                                </dl>
                                                <Button
                                                    variant="ghost"
                                                    className="max-w-full self-start"
                                                    onClick={() =>
                                                        navigate('chat', {
                                                            sessionId: schedule.sessionId,
                                                        })
                                                    }
                                                >
                                                    <MessageSquareIcon />
                                                    <span className="truncate">
                                                        {t('schedules.conversation', {
                                                            name:
                                                                session?.title ||
                                                                t('chat.untitled'),
                                                        })}
                                                    </span>
                                                </Button>
                                            </CardContent>
                                        </Card>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <p className="text-muted-foreground text-xs">{t('schedules.note')}</p>
                </>
            )}
        </div>
    );
}
