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
