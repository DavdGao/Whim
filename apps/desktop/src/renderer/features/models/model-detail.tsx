import {
    ArrowLeftIcon,
    AudioLinesIcon,
    BoxIcon,
    CheckIcon,
    CopyIcon,
    FileSearchIcon,
    FileTextIcon,
    FilePenIcon,
    FilePlusIcon,
    FolderSearchIcon,
    GlobeIcon,
    ImageIcon,
    SearchIcon,
    TerminalIcon,
    TypeIcon,
    VideoIcon,
    WrenchIcon,
} from 'lucide-react';
import { useState } from 'react';

import { EntityIcon } from '../../components/entity-icon';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';
import { pluginText } from '../../lib/messages';

import type { AppState, CatalogEntryInfo } from '../../../shared/ipc';
import type { MessageKey } from '../../lib/messages';
import type { ChatCard } from '@whimkit/core/contracts';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { StatusAlert } from '@/components/status-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Modality {
    readonly label: MessageKey;
    readonly icon: LucideIcon;
    readonly matches: (type: string) => boolean;
}

const modalities: readonly Modality[] = [
    { label: 'media.text', icon: TypeIcon, matches: type => type.startsWith('text/') },
    { label: 'media.image', icon: ImageIcon, matches: type => type.startsWith('image/') },
    { label: 'media.pdf', icon: FileTextIcon, matches: type => type === 'application/pdf' },
    { label: 'media.audio', icon: AudioLinesIcon, matches: type => type.startsWith('audio/') },
    { label: 'media.video', icon: VideoIcon, matches: type => type.startsWith('video/') },
];

const baseToolIcons: Readonly<Record<string, LucideIcon>> = {
    Bash: TerminalIcon,
    Read: FileTextIcon,
    Write: FilePlusIcon,
    Edit: FilePenIcon,
    Glob: FolderSearchIcon,
    Grep: FileSearchIcon,
    WebFetch: GlobeIcon,
};

/**
 * One column of the summary strip.
 * @param props Column content.
 * @param props.label Column heading.
 * @param props.children Visual.
 * @param props.caption Text under the visual.
 * @returns The column.
 */
function Stat({
    label,
    children,
    caption,
}: {
    label: string;
    children: ReactNode;
    caption: string;
}) {
    return (
        <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {label}
            </span>
            <div className="flex h-7 items-center gap-1.5">{children}</div>
            <span className="text-sm">{caption}</span>
        </div>
    );
}

/**
 * A titled section with its label on the left, as in a spec sheet.
 * @param props Section content.
 * @param props.title Section label.
 * @param props.children Body.
 * @returns The section.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="grid gap-4 border-t py-6 md:grid-cols-[10rem_1fr]">
            <h4 className="text-sm font-medium">{title}</h4>
            <div className="min-w-0">{children}</div>
        </section>
    );
}

/**
 * A capability entry: an icon tile, a name, and whether it is supported.
 * @param props Entry content.
 * @param props.icon Icon.
 * @param props.name Name.
 * @param props.detail Support text.
 * @param props.enabled Whether the capability is available.
 * @returns The entry.
 */
function Capability({
    icon: Icon,
    name,
    detail,
    enabled,
}: {
    icon: LucideIcon;
    name: string;
    detail: string;
    enabled: boolean;
}) {
    return (
        <div className={cn('flex items-center gap-3', !enabled && 'opacity-45')}>
            <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-xl">
                <Icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="text-muted-foreground truncate text-xs">{detail}</span>
            </span>
        </div>
    );
}

/**
 * Copy the model id with feedback.
 * @param props Button props.
 * @param props.value The id.
 * @returns The button.
 */
function CopyId({ value }: { value: string }) {
    const { t } = useT();
    const [copied, setCopied] = useState(false);
    return (
        <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            aria-label={copied ? t('model.copied') : t('model.copyId')}
            onClick={() =>
                void navigator.clipboard.writeText(value).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                })
            }
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
    );
}

/**
 * The card's input and output support for one modality.
 * @param card The model card.
 * @param modality The modality.
 * @returns Whether input and output include it.
 */
function support(card: ChatCard, modality: Modality): { input: boolean; output: boolean } {
    return {
        input: Object.keys(card.input).some(modality.matches),
        output: card.output.some(modality.matches),
    };
}

/**
 * The detail sheet of a model whose card is valid.
 * @param props Sheet props.
 * @param props.state Application state.
 * @param props.card The model card.
 * @returns The strip and sections.
 */
function Sheet({ state, card }: { state: AppState; card: ChatCard }) {
    const { t, locale } = useT();
    const exact = new Intl.NumberFormat(locale);
    const compact = new Intl.NumberFormat(locale, { notation: 'compact' });
    const thinking = card.thinking;
    const levels = thinking && 'levels' in thinking ? thinking.levels : [];
    const steps = levels.filter(level => level !== 'off');
    const thinkingCaption = !thinking
        ? t('model.none')
        : 'fixed' in thinking
          ? t('chat.thinking.fixed')
          : steps.length > 0
            ? steps.map(level => t(`level.${level}`)).join(' · ')
            : t('level.off');
    const supported = modalities.map(modality => ({ modality, ...support(card, modality) }));
    const names = (side: 'input' | 'output') =>
        supported
            .filter(entry => entry[side])
            .map(entry => t(entry.modality.label))
            .join(locale === 'zh-CN' ? '、' : ', ');
    const nativeFetch = card.nativeTools.includes('web_fetch');
    const limits: [string, string][] = [
        [t('model.contextWindow'), exact.format(card.contextWindow)],
        [t('model.maxOutput'), exact.format(card.maxOutputTokens)],
    ];
    for (const [type, limit] of Object.entries(card.input)) {
        const modality = modalities.find(item => item.matches(type));
        const name = modality ? t(modality.label) : type;
        if (limit.maxBytes !== undefined)
            limits.push([
                t('model.maxSize', { media: name }),
                `${compact.format(limit.maxBytes)}B`,
            ]);
        if (limit.maxPages !== undefined)
            limits.push([t('model.maxPages', { media: name }), exact.format(limit.maxPages)]);
    }
    return (
        <>
            <div className="grid grid-cols-2 divide-y rounded-3xl border sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                <Stat label={t('model.thinking')} caption={thinkingCaption}>
                    {thinking && 'levels' in thinking ? (
                        steps.map(level => (
                            <span key={level} className="bg-foreground size-2.5 rounded-full" />
                        ))
                    ) : (
                        <span className="bg-muted size-2.5 rounded-full" />
                    )}
                </Stat>
                <Stat label={t('model.input')} caption={names('input')}>
                    {supported.map(({ modality, input }) => (
                        <modality.icon
                            key={modality.label}
                            className={cn('size-4', !input && 'text-muted-foreground/40')}
                        />
                    ))}
                </Stat>
                <Stat label={t('model.output')} caption={names('output')}>
                    {supported.map(({ modality, output }) => (
                        <modality.icon
                            key={modality.label}
                            className={cn('size-4', !output && 'text-muted-foreground/40')}
                        />
                    ))}
                </Stat>
                <Stat
                    label={t('model.contextWindow')}
                    caption={t('model.maxOutputShort', {
                        tokens: compact.format(card.maxOutputTokens),
                    })}
                >
                    <span className="text-xl font-semibold tabular-nums">
                        {compact.format(card.contextWindow)}
                    </span>
                </Stat>
            </div>

            <div className="flex flex-col">
                <Section title={t('model.modalities')}>
                    <div className="grid gap-4 sm:grid-cols-2">
                        {supported.map(({ modality, input, output }) => (
                            <Capability
                                key={modality.label}
                                icon={modality.icon}
                                name={t(modality.label)}
                                enabled={input || output}
                                detail={t(
                                    input && output
                                        ? 'model.modality.both'
                                        : input
                                          ? 'model.modality.input'
                                          : output
                                            ? 'model.modality.output'
                                            : 'model.none'
                                )}
                            />
                        ))}
                    </div>
                </Section>

                <Section title={t('model.thinking')}>
                    {levels.length > 0 && thinking && 'levels' in thinking ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-wrap gap-2">
                                {levels.map(level => (
                                    <Badge
                                        key={level}
                                        variant={
                                            level === thinking.default ? 'default' : 'secondary'
                                        }
                                        className="rounded-full px-3"
                                    >
                                        {t(`level.${level}`)}
                                        {level === thinking.default
                                            ? ` · ${t('model.default')}`
                                            : ''}
                                    </Badge>
                                ))}
                            </div>
                            <p className="text-muted-foreground text-xs">
                                {t('model.thinking.hint')}
                            </p>
                        </div>
                    ) : (
                        <p className="text-muted-foreground text-sm">{thinkingCaption}</p>
                    )}
                </Section>

                <Section title={t('model.tools')}>
                    <div className="flex flex-col gap-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Capability
                                icon={SearchIcon}
                                name={t('tool.native.search')}
                                enabled={card.nativeTools.includes('web_search')}
                                detail={
                                    card.nativeTools.includes('web_search')
                                        ? t('model.tool.native')
                                        : t('model.none')
                                }
                            />
                            {state.baseTools
                                .filter(name => !(nativeFetch && name === 'WebFetch'))
                                .map(name => (
                                    <Capability
                                        key={name}
                                        icon={baseToolIcons[name] ?? WrenchIcon}
                                        name={name}
                                        enabled
                                        detail={t('model.tool.local')}
                                    />
                                ))}
                            {nativeFetch && (
                                <Capability
                                    icon={GlobeIcon}
                                    name={t('tool.native.fetch')}
                                    enabled
                                    detail={t('model.tool.native')}
                                />
                            )}
                        </div>
                        <p className="text-muted-foreground text-xs">{t('model.tools.hint')}</p>
                    </div>
                </Section>

                <Section title={t('model.limits')}>
                    <dl className="grid gap-x-8 sm:grid-cols-2">
                        {limits.map(([label, value]) => (
                            <div
                                key={label}
                                className="flex items-center justify-between gap-4 border-b py-2.5 text-sm"
                            >
                                <dt className="text-muted-foreground min-w-0 truncate">{label}</dt>
                                <dd className="tabular-nums">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </Section>
            </div>
        </>
    );
}

/**
 * Full details of one model, organized like a provider's model page: identity, a summary
 * strip, then modalities, thinking, tools, and limits.
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
    return (
        <div className="flex flex-col gap-6">
            <div>
                <Button variant="ghost" size="sm" className="-ml-2 rounded-full" onClick={onBack}>
                    <ArrowLeftIcon /> {t('model.back')}
                </Button>
            </div>
            <div className="flex items-center gap-4">
                <div className="bg-muted flex size-16 shrink-0 items-center justify-center rounded-3xl">
                    <EntityIcon
                        src={card ? modelIcon(state, card) : undefined}
                        fallback={BoxIcon}
                        className="size-9"
                    />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xl font-semibold tracking-tight">
                            {card?.name ?? entry.id}
                        </h3>
                        {card && (
                            <span className="bg-muted flex items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5">
                                <code className="text-xs">{card.model}</code>
                                <CopyId value={card.model} />
                            </span>
                        )}
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
                        {provider && <span>{provider}</span>}
                        <Badge variant="secondary" className="rounded-full">
                            {t(
                                card?.kind === 'decision'
                                    ? 'model.kind.decision'
                                    : 'model.kind.chat'
                            )}
                        </Badge>
                        {entry.hidden && (
                            <Badge variant="outline" className="rounded-full">
                                {t('models.hidden')}
                            </Badge>
                        )}
                    </div>
                </div>
            </div>

            {entry.issues.length > 0 && (
                <StatusAlert tone="error" title={t('models.invalid')}>
                    <ul className="list-disc pl-4">
                        {entry.issues.map(issue => (
                            <li key={issue}>{issue}</li>
                        ))}
                    </ul>
                </StatusAlert>
            )}

            {card?.kind === 'chat' && <Sheet state={state} card={card} />}
        </div>
    );
}
