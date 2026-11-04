import {
    ArrowLeftIcon,
    AudioLinesIcon,
    BoxIcon,
    BrainIcon,
    FileTextIcon,
    FileIcon,
    GlobeIcon,
    ImageIcon,
    SearchIcon,
    TypeIcon,
    VideoIcon,
    WrenchIcon,
} from 'lucide-react';

import { EntityIcon } from '../../components/entity-icon';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';
import { pluginText } from '../../lib/messages';

import type { AppState, CatalogEntryInfo } from '../../../shared/ipc';
import type { MessageKey } from '../../lib/messages';
import type { ChatCard } from '@whimkit/core/contracts';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Icon and label key for a media type.
 * @param type A media type.
 * @returns Display parts.
 */
function media(type: string): { icon: LucideIcon; label: MessageKey | undefined } {
    if (type === 'text/plain') return { icon: TypeIcon, label: 'media.text' };
    if (type.startsWith('image/')) return { icon: ImageIcon, label: 'media.image' };
    if (type === 'application/pdf') return { icon: FileTextIcon, label: 'media.pdf' };
    if (type.startsWith('audio/')) return { icon: AudioLinesIcon, label: 'media.audio' };
    if (type.startsWith('video/')) return { icon: VideoIcon, label: 'media.video' };
    return { icon: FileIcon, label: undefined };
}

/**
 * A rounded capability chip.
 * @param props Chip content.
 * @param props.icon Leading icon.
 * @param props.children Label.
 * @param props.title Tooltip with details.
 * @returns The chip.
 */
function Chip({
    icon: Icon,
    children,
    title,
}: {
    icon: LucideIcon;
    children: ReactNode;
    title?: string;
}) {
    return (
        <span
            title={title}
            className="bg-muted text-foreground inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
        >
            <Icon className="text-muted-foreground size-3.5" />
            {children}
        </span>
    );
}

/**
 * One capability block with a heading and chips.
 * @param props Block content.
 * @param props.icon Heading icon.
 * @param props.title Heading.
 * @param props.children Chips or text.
 * @returns The block.
 */
function Capability({
    icon: Icon,
    title,
    children,
}: {
    icon: LucideIcon;
    title: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 rounded-2xl border p-4">
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Icon className="size-4" />
                {title}
            </div>
            <div className="flex flex-wrap gap-2">{children}</div>
        </div>
    );
}

/**
 * The card's thinking support as chips.
 * @param props The card.
 * @param props.card The model card.
 * @returns Chips.
 */
function ThinkingChips({ card }: { card: ChatCard }) {
    const { t } = useT();
    const thinking = card.thinking;
    if (!thinking) return <span className="text-muted-foreground text-sm">{t('model.none')}</span>;
    if ('fixed' in thinking) return <Chip icon={BrainIcon}>{t('chat.thinking.fixed')}</Chip>;
    return (
        <>
            {thinking.levels.map(level => (
                <Chip key={level} icon={BrainIcon}>
                    {t(`level.${level}`)}
                    {level === thinking.default ? ` · ${t('model.default')}` : ''}
                </Chip>
            ))}
        </>
    );
}

/**
 * Full details of one model: identity, capabilities, and specifications.
 * @param props Detail props.
 * @param props.state Application state.
 * @param props.entry The catalog entry.
 * @param props.onBack Return to the list.
 * @returns The detail view.
 */
export function ModelDetail({
    state,
    entry,
    onBack,
}: {
    state: AppState;
    entry: CatalogEntryInfo;
    onBack: () => void;
}) {
    const { t, locale } = useT();
    const card = entry.card;
    const plugin = state.plugins.find(item => item.id === entry.pluginId);
    const provider = plugin
        ? pluginText(plugin.locales, locale, 'plugin.name', plugin.id)
        : undefined;
    const exact = new Intl.NumberFormat(locale);
    const compact = new Intl.NumberFormat(locale, { notation: 'compact' });
    const specs: [MessageKey, ReactNode][] = card
        ? [
              [
                  'model.contextWindow',
                  `${compact.format(card.contextWindow)} (${exact.format(card.contextWindow)})`,
              ],
              [
                  'model.maxOutput',
                  `${compact.format(card.maxOutputTokens)} (${exact.format(card.maxOutputTokens)})`,
              ],
              ['model.modelId', <code key="model">{card.model}</code>],
              ['model.cardId', <code key="card">{card.id}</code>],
              ['model.revision', String(card.revision)],
              ['model.source', t(`models.layer.${entry.layer}`)],
          ]
        : [];
    return (
        <div className="flex flex-col gap-6">
            <div>
                <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
                    <ArrowLeftIcon /> {t('model.back')}
                </Button>
            </div>
            <div className="flex items-start gap-4">
                <div className="bg-muted flex size-16 shrink-0 items-center justify-center rounded-3xl">
                    <EntityIcon
                        src={card ? modelIcon(state, card) : undefined}
                        fallback={BoxIcon}
                        className="size-9"
                    />
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                    <h3 className="text-xl font-semibold tracking-tight">
                        {card?.name ?? entry.id}
                    </h3>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
                        {provider && <span>{provider}</span>}
                        {card && <code className="text-xs">{card.model}</code>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">{t('model.kind.chat')}</Badge>
                        {card && (
                            <Badge variant="outline">
                                {t('models.context', {
                                    tokens: compact.format(card.contextWindow),
                                })}
                            </Badge>
                        )}
                        {entry.hidden && <Badge variant="outline">{t('models.hidden')}</Badge>}
                    </div>
                </div>
            </div>

            {entry.issues.length > 0 && (
                <Alert variant="destructive" className="rounded-2xl">
                    <AlertTitle>{t('models.invalid')}</AlertTitle>
                    <AlertDescription>
                        <ul className="list-disc pl-4">
                            {entry.issues.map(issue => (
                                <li key={issue}>{issue}</li>
                            ))}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}

            {card && (
                <>
                    <section className="flex flex-col gap-3">
                        <h4 className="text-sm font-medium">{t('model.capabilities')}</h4>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Capability icon={TypeIcon} title={t('model.input')}>
                                {Object.entries(card.input).map(([type, limits]) => {
                                    const shown = media(type);
                                    const details = [
                                        limits.maxBytes !== undefined
                                            ? t('model.maxBytes', {
                                                  size: compact.format(limits.maxBytes),
                                              })
                                            : undefined,
                                        limits.maxPages !== undefined
                                            ? t('model.maxPages', { pages: limits.maxPages })
                                            : undefined,
                                    ].filter(Boolean);
                                    return (
                                        <Chip
                                            key={type}
                                            icon={shown.icon}
                                            title={[type, ...details].join(' · ')}
                                        >
                                            {shown.label ? t(shown.label) : type}
                                        </Chip>
                                    );
                                })}
                            </Capability>
                            <Capability icon={FileTextIcon} title={t('model.output')}>
                                {card.output.map(type => {
                                    const shown = media(type);
                                    return (
                                        <Chip key={type} icon={shown.icon} title={type}>
                                            {shown.label ? t(shown.label) : type}
                                        </Chip>
                                    );
                                })}
                            </Capability>
                            <Capability icon={BrainIcon} title={t('chat.thinking')}>
                                <ThinkingChips card={card} />
                            </Capability>
                            <Capability icon={WrenchIcon} title={t('model.tools')}>
                                {card.nativeTools.map(tool => (
                                    <Chip
                                        key={tool}
                                        icon={tool === 'web_search' ? SearchIcon : GlobeIcon}
                                        title={t('model.nativeHint')}
                                    >
                                        {tool === 'web_search'
                                            ? t('tool.native.search')
                                            : tool === 'web_fetch'
                                              ? t('tool.native.fetch')
                                              : tool}
                                    </Chip>
                                ))}
                                <Chip icon={WrenchIcon} title={t('model.localHint')}>
                                    {t('model.localTools')}
                                </Chip>
                            </Capability>
                        </div>
                    </section>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('model.specs')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <dl className="divide-y">
                                {specs.map(([label, value]) => (
                                    <div
                                        key={label}
                                        className="flex items-center justify-between gap-4 py-2.5 text-sm"
                                    >
                                        <dt className="text-muted-foreground">{t(label)}</dt>
                                        <dd className="min-w-0 truncate text-right">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </CardContent>
                    </Card>
                </>
            )}

            {entry.files.length > 0 && (
                <p className="text-muted-foreground text-xs break-all">
                    {t('model.files')}: {entry.files.join(', ')}
                </p>
            )}
        </div>
    );
}
