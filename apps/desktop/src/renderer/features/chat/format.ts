import type { useT } from '../../lib/i18n';

type Translate = ReturnType<typeof useT>['t'];

/**
 * A duration in at most two units: hours and minutes, minutes and seconds, or seconds.
 * A zero second unit is dropped ("2m", not "2m 0s"); anything under a second shows as 1s.
 * @param ms Duration in milliseconds.
 * @param t Translation function.
 * @returns The localized duration.
 */
export function formatDuration(ms: number, t: Translate): string {
    const total = Math.max(1, Math.round(ms / 1000));
    if (total < 60) return t('duration.seconds', { s: total });
    if (total < 3600) {
        const m = Math.floor(total / 60);
        const s = total % 60;
        return s === 0 ? t('duration.minutes', { m }) : t('duration.minutesSeconds', { m, s });
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m === 0 ? t('duration.hours', { h }) : t('duration.hoursMinutes', { h, m });
}

/**
 * When a message was sent: the time alone today, "Yesterday" with the time for yesterday, and
 * the date with the time before that (with the year when it is not the current one).
 * @param at ISO timestamp.
 * @param locale Interface locale.
 * @param t Translation function.
 * @param now The current time, for tests and re-renders.
 * @returns The localized timestamp.
 */
export function formatSentAt(at: string, locale: string, t: Translate, now = new Date()): string {
    const sent = new Date(at);
    const time = sent.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    const startOfDay = (date: Date) =>
        new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(sent)) / 86_400_000);
    if (days === 0) return time;
    if (days === 1) return t('time.yesterday', { time });
    return sent.toLocaleString(locale, {
        ...(sent.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}
