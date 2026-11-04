import { ChevronDownIcon } from 'lucide-react';

import { useAction } from '../lib/use-action';

import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export interface Choice<Value extends string> {
    readonly value: Value;
    readonly label: string;
    readonly icon?: ReactNode;
}

export interface ChoiceMenuProps<Value extends string> {
    readonly value: Value | undefined;
    readonly choices: readonly Choice<Value>[];
    /** Applies the choice; the trigger shows a spinner until it settles. */
    readonly onChange: (value: Value) => Promise<unknown> | void;
    /** Icon used when the selected choice has none. */
    readonly icon: ReactNode;
    readonly placeholder: string;
    readonly id?: string;
    readonly 'aria-label'?: string;
    readonly title?: string;
    readonly disabled?: boolean;
    readonly variant?: ComponentProps<typeof Button>['variant'];
    readonly size?: ComponentProps<typeof Button>['size'];
    readonly className?: string;
    readonly align?: 'start' | 'end';
}

/**
 * A single-choice picker built from a dropdown radio menu behind a button trigger.
 * @param props Menu props.
 * @returns The picker.
 */
export function ChoiceMenu<Value extends string>(props: ChoiceMenuProps<Value>) {
    const { value, choices, onChange, icon, placeholder, disabled } = props;
    const { run, pending } = useAction(async (next: Value) => onChange(next));
    const current = choices.find(choice => choice.value === value);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled || pending}>
                <Button
                    type="button"
                    id={props.id}
                    variant={props.variant ?? 'outline'}
                    size={props.size ?? 'default'}
                    aria-label={props['aria-label']}
                    aria-busy={pending || undefined}
                    title={props.title}
                    className={cn('justify-between', props.className)}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        {pending ? <Spinner /> : (current?.icon ?? icon)}
                        <span className="truncate">{current?.label ?? placeholder}</span>
                    </span>
                    <ChevronDownIcon className="text-muted-foreground" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={props.align ?? 'start'} className="min-w-48">
                <DropdownMenuRadioGroup
                    value={value ?? ''}
                    onValueChange={next => {
                        const choice = choices.find(item => item.value === next);
                        if (choice && choice.value !== value) void run(choice.value);
                    }}
                >
                    {choices.map(choice => (
                        <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                            {choice.icon}
                            {choice.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
