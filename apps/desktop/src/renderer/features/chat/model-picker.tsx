import { selectableLevels } from '@whimkit/core/contracts';
import { BoxIcon, CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import { EntityIcon } from '../../components/entity-icon';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';
import { useAction } from '../../lib/use-action';

import type { ModelChoice } from './model-choices';
import type { AppState, ChatSlot } from '../../../shared/ipc';
import type { ThinkingLevel } from '@whimkit/core/contracts';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * A segmented track for thinking levels: click a label or drag the thumb; the change is sent
 * when the thumb is released.
 * @param props Track props.
 * @param props.levels Selectable levels in order.
 * @param props.value The current level.
 * @param props.onChange Apply a level.
 * @returns The track.
 */
function ThinkingTrack({
    levels,
    value,
    onChange,
}: {
    levels: readonly ThinkingLevel[];
    value: ThinkingLevel | undefined;
    onChange: (level: ThinkingLevel) => void;
}) {
    const { t } = useT();
    const committed = Math.max(0, value ? levels.indexOf(value) : 0);
    const [dragging, setDragging] = useState<number | undefined>();
    const index = dragging ?? committed;
    return (
        <div className="flex flex-col gap-3 px-1">
            <Slider
                min={0}
                max={levels.length - 1}
                step={1}
                value={[index]}
                aria-label={t('chat.thinking')}
                aria-valuetext={t(`level.${levels[index] ?? 'off'}`)}
                onValueChange={([next]) => setDragging(next)}
                onValueCommit={([next]) => {
                    setDragging(undefined);
                    const level = next === undefined ? undefined : levels[next];
                    if (level && level !== value) onChange(level);
                }}
            />
            <div className="flex justify-between">
                {levels.map((level, position) => (
                    <button
                        key={level}
                        type="button"
                        onClick={() => level !== value && onChange(level)}
                        className={cn(
                            'hover:text-foreground focus-visible:ring-ring rounded-full px-1.5 text-xs outline-none focus-visible:ring-2',
                            position === index ? 'text-foreground' : 'text-muted-foreground'
                        )}
                    >
                        {t(`level.${level}`)}
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * One button for the model and its thinking level: a popover with models grouped by provider
 * and a thinking track.
 * @param props Picker props.
 * @param props.state Application state.
 * @param props.choices Selectable models.
 * @param props.slot The current binding.
 * @param props.locked Whether the model cannot change now (a run is active).
 * @param props.onChange Apply a new binding.
 * @returns The picker.
 */
export function ModelPicker({
    state,
    choices,
    slot,
    locked,
    onChange,
}: {
    state: AppState;
    choices: readonly ModelChoice[];
    slot: ChatSlot | undefined;
    locked: boolean;
    onChange: (slot: ChatSlot) => Promise<void>;
}) {
    const { t } = useT();
    const current = choices.find(choice => choice.card.id === slot?.cardId);
    const thinking = current?.card.thinking;
    const levels = current ? selectableLevels(thinking) : [];
    const level =
        slot?.thinking && levels.includes(slot.thinking)
            ? slot.thinking
            : thinking && 'default' in thinking
              ? thinking.default
              : undefined;
    const apply = useAction(onChange);
    const providers = [...new Set(choices.map(choice => choice.provider))];
    const summary =
        thinking && 'fixed' in thinking
            ? t('chat.thinking.fixed')
            : level
              ? t(`level.${level}`)
              : undefined;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={t('chat.model')}
                    className="text-foreground/85 hover:text-foreground max-w-72 rounded-full font-normal"
                >
                    {apply.pending && <Spinner />}
                    <span className="truncate">{current?.card.name ?? t('chat.model')}</span>
                    {summary && <span className="text-muted-foreground/80">{summary}</span>}
                    <ChevronDownIcon className="text-muted-foreground" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 rounded-2xl p-2">
                <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                    {providers.map(provider => (
                        <div key={provider} className="flex flex-col gap-0.5">
                            <p className="text-muted-foreground px-2 pt-2 pb-1 text-xs">
                                {provider}
                            </p>
                            {choices
                                .filter(choice => choice.provider === provider)
                                .map(choice => {
                                    const selected = choice.card.id === current?.card.id;
                                    return (
                                        <button
                                            key={choice.card.id}
                                            type="button"
                                            disabled={locked || apply.pending}
                                            onClick={() =>
                                                !selected &&
                                                void apply.run({
                                                    cardId: choice.card.id,
                                                    credentialId: choice.credentialId,
                                                })
                                            }
                                            className={cn(
                                                'hover:bg-accent focus-visible:ring-ring flex items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
                                                selected && 'bg-accent'
                                            )}
                                        >
                                            <EntityIcon
                                                src={modelIcon(state, choice.card)}
                                                fallback={BoxIcon}
                                                className="size-5"
                                            />
                                            <span className="min-w-0 flex-1 truncate">
                                                {choice.card.name}
                                            </span>
                                            {selected && <CheckIcon className="size-4" />}
                                        </button>
                                    );
                                })}
                        </div>
                    ))}
                </div>
                {locked && (
                    <p className="text-muted-foreground px-2 pt-1 text-xs">
                        {t('chat.modelLocked')}
                    </p>
                )}
                <Separator className="my-2" />
                <div className="flex flex-col gap-3 px-2 pt-1 pb-2">
                    <p className="text-xs font-medium">{t('chat.thinking')}</p>
                    {thinking && 'fixed' in thinking ? (
                        <p className="text-muted-foreground text-xs">{t('chat.thinking.fixed')}</p>
                    ) : levels.length > 1 && slot ? (
                        <ThinkingTrack
                            levels={levels}
                            value={level}
                            onChange={next => void apply.run({ ...slot, thinking: next })}
                        />
                    ) : (
                        <p className="text-muted-foreground text-xs">
                            {levels.length === 1 && levels[0]
                                ? t(`level.${levels[0]}`)
                                : t('model.none')}
                        </p>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
