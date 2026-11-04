import {
    BoxIcon,
    CheckIcon,
    ChevronRightIcon,
    KeyRoundIcon,
    PencilIcon,
    PlusIcon,
    RefreshCwIcon,
    Trash2Icon,
    XIcon,
} from 'lucide-react';
import { useState } from 'react';

import { ActionButton } from '../../components/action-button';
import { ChoiceMenu } from '../../components/choice-menu';
import { EntityIcon } from '../../components/entity-icon';
import { call, ClientError } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { modelIcon } from '../../lib/icons';
import { pluginText } from '../../lib/messages';
import { useAction } from '../../lib/use-action';
import { modelChoices } from '../chat/model-choices';

import { ModelDetail } from './model-detail';
import { SchemaForm } from './schema-form';

import type { FormValue } from './schema';
import type { AppState, CredentialInfo } from '../../../shared/ipc';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * Display name of a credential type from its plugin's catalog.
 * @param state Application state.
 * @param typeId The type.
 * @param locale The active locale.
 * @returns The name.
 */
function typeName(state: AppState, typeId: string, locale: 'en' | 'zh-CN'): string {
    const type = state.credentialTypes.find(item => item.id === typeId);
    const plugin = state.plugins.find(item => item.id === type?.pluginId);
    const title = typeof type?.schema.title === 'string' ? type.schema.title : typeId;
    return pluginText(plugin?.locales, locale, `credential.${typeId}`, title);
}

/**
 * Create or edit one credential.
 * @param props Dialog props.
 * @param props.state Application state.
 * @param props.editing The credential being edited, or undefined to create.
 * @param props.open Whether the dialog is open.
 * @param props.onOpenChange Open-state setter.
 * @returns The dialog.
 */
function CredentialDialog({
    state,
    editing,
    open,
    onOpenChange,
}: {
    state: AppState;
    editing: CredentialInfo | undefined;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { t, locale } = useT();
    const [typeId, setTypeId] = useState(editing?.typeId ?? state.credentialTypes[0]?.id ?? '');
    const [label, setLabel] = useState(editing?.label ?? '');
    const [values, setValues] = useState<Record<string, FormValue>>(() => {
        const initial: Record<string, FormValue> = {};
        for (const [key, value] of Object.entries(editing?.values ?? {}))
            if (
                typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean'
            )
                initial[key] = value;
        return initial;
    });
    const [issues, setIssues] = useState<Record<string, string>>({});
    const type = state.credentialTypes.find(item => item.id === typeId);
    const plugin = state.plugins.find(item => item.id === type?.pluginId);

    const save = useAction(async () => {
        try {
            await call('credentials.save', {
                ...(editing ? { id: editing.id } : {}),
                typeId,
                label: label.trim() || typeName(state, typeId, locale),
                values,
            });
        } catch (error) {
            if (error instanceof ClientError && error.error.issues)
                setIssues(
                    Object.fromEntries(error.error.issues.map(issue => [issue.path, issue.message]))
                );
            throw error;
        }
        onOpenChange(false);
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {editing ? t('models.editCredential') : t('models.addCredential')}
                    </DialogTitle>
                    <DialogDescription>
                        {typeId ? typeName(state, typeId, locale) : null}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex min-h-0 flex-1 flex-col gap-4"
                    onSubmit={event => {
                        event.preventDefault();
                        void save.run();
                    }}
                >
                    {/* Only the body scrolls; header and footer stay in place. */}
                    <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-1">
                        <FieldGroup>
                            {!editing && state.credentialTypes.length > 1 && (
                                <Field>
                                    <FieldLabel htmlFor="credential-type">
                                        {t('models.credentialType')}
                                    </FieldLabel>
                                    <ChoiceMenu
                                        id="credential-type"
                                        value={typeId}
                                        choices={state.credentialTypes.map(item => ({
                                            value: item.id,
                                            label: typeName(state, item.id, locale),
                                        }))}
                                        icon={<KeyRoundIcon />}
                                        placeholder={t('models.credentialType')}
                                        className="w-full"
                                        onChange={setTypeId}
                                    />
                                </Field>
                            )}
                            <Field>
                                <FieldLabel htmlFor="credential-label">
                                    {t('models.label')}
                                </FieldLabel>
                                <Input
                                    id="credential-label"
                                    value={label}
                                    placeholder={typeId ? typeName(state, typeId, locale) : ''}
                                    onChange={event => setLabel(event.currentTarget.value)}
                                />
                            </Field>
                        </FieldGroup>
                        {type && (
                            <SchemaForm
                                schemaId={type.id}
                                schema={type.schema}
                                locales={plugin?.locales}
                                values={values}
                                secretsSet={editing?.secretsSet ?? []}
                                issues={issues}
                                onChange={(name, value) =>
                                    setValues(current => ({ ...current, [name]: value }))
                                }
                            />
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            <XIcon /> {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={save.pending || !typeId}
                            aria-busy={save.pending || undefined}
                        >
                            {save.pending ? <Spinner /> : <CheckIcon />} {t('common.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Model settings: credentials, the default chat model, and available models.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
export function ModelSettings({ state }: { state: AppState }) {
    const { t, locale } = useT();
    const [dialog, setDialog] = useState<{ editing?: CredentialInfo } | undefined>();
    const choices = modelChoices(state, state.chatSlot?.credentialId);
    const defaultCard = state.chatSlot?.cardId ?? choices[0]?.card.id;
    const formatter = new Intl.NumberFormat(locale, { notation: 'compact' });
    const [detail, setDetail] = useState<string | undefined>();
    const detailEntry = state.catalog.find(entry => entry.id === detail);
    if (detailEntry)
        return (
            <ModelDetail state={state} entry={detailEntry} onBack={() => setDetail(undefined)} />
        );

    return (
        <div className="flex flex-col gap-6">
            <p className="text-muted-foreground text-sm">{t('models.description')}</p>

            <Card>
                <CardHeader>
                    <CardTitle>{t('models.credentials')}</CardTitle>
                    <CardAction>
                        <Button
                            size="sm"
                            onClick={() => setDialog({})}
                            disabled={state.credentialTypes.length === 0}
                        >
                            <PlusIcon /> {t('models.addCredential')}
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    {state.credentials.length === 0 && (
                        <p className="text-muted-foreground text-sm">{t('models.noCredentials')}</p>
                    )}
                    {state.credentials.map(credential => (
                        <div
                            key={credential.id}
                            className="flex items-center gap-3 rounded-2xl border px-4 py-3"
                        >
                            <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-full">
                                <KeyRoundIcon className="text-muted-foreground size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{credential.label}</p>
                                <p className="text-muted-foreground truncate text-xs">
                                    {credential.available
                                        ? typeName(state, credential.typeId, locale)
                                        : t('models.unavailableType')}
                                </p>
                            </div>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('common.edit')}
                                disabled={!credential.available}
                                onClick={() => setDialog({ editing: credential })}
                            >
                                <PencilIcon />
                            </Button>
                            <ActionButton
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('common.delete')}
                                icon={<Trash2Icon />}
                                action={() => call('credentials.remove', { id: credential.id })}
                            />
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('models.defaultChat')}</CardTitle>
                    <CardDescription>{t('models.defaultChatDescription')}</CardDescription>
                </CardHeader>
                <CardContent>
                    <ChoiceMenu
                        value={defaultCard}
                        disabled={choices.length === 0}
                        choices={choices.map(choice => ({
                            value: choice.card.id,
                            label: choice.card.name,
                            group: choice.provider,
                            icon: (
                                <EntityIcon
                                    src={modelIcon(state, choice.card)}
                                    fallback={BoxIcon}
                                />
                            ),
                        }))}
                        icon={<BoxIcon />}
                        placeholder={t('chat.model')}
                        aria-label={t('models.defaultChat')}
                        className="w-72"
                        onChange={cardId => {
                            const choice = choices.find(item => item.card.id === cardId);
                            return choice
                                ? call('settings.chatSlot', {
                                      slot: { cardId, credentialId: choice.credentialId },
                                  })
                                : undefined;
                        }}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('models.catalog')}</CardTitle>
                    <CardDescription className="break-all">
                        {t('models.catalogDescription', { dir: state.userCardsDir })}
                    </CardDescription>
                    <CardAction>
                        <ActionButton
                            size="sm"
                            variant="outline"
                            icon={<RefreshCwIcon />}
                            action={() => call('catalog.reload', {})}
                        >
                            {t('models.reload')}
                        </ActionButton>
                    </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    {state.catalog.map(entry => (
                        <button
                            key={entry.id}
                            type="button"
                            onClick={() => setDetail(entry.id)}
                            className="hover:bg-muted/60 focus-visible:ring-ring flex items-center gap-3 rounded-2xl border px-4 py-3 text-left outline-none focus-visible:ring-2"
                        >
                            <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
                                <EntityIcon
                                    src={entry.card ? modelIcon(state, entry.card) : undefined}
                                    fallback={BoxIcon}
                                    className="size-6"
                                />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">
                                        {entry.card?.name ?? entry.id}
                                    </span>
                                    {entry.issues.length > 0 && (
                                        <Badge variant="destructive">{t('models.invalid')}</Badge>
                                    )}
                                    {entry.hidden && (
                                        <Badge variant="outline">{t('models.hidden')}</Badge>
                                    )}
                                </span>
                                <span className="text-muted-foreground truncate text-xs">
                                    {[
                                        entry.card?.model,
                                        entry.card &&
                                            t('models.context', {
                                                tokens: formatter.format(entry.card.contextWindow),
                                            }),
                                        t(`models.layer.${entry.layer}`),
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </span>
                            </span>
                            <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                        </button>
                    ))}
                </CardContent>
            </Card>

            {dialog && (
                <CredentialDialog
                    key={dialog.editing?.id ?? 'new'}
                    state={state}
                    editing={dialog.editing}
                    open
                    onOpenChange={open => !open && setDialog(undefined)}
                />
            )}
        </div>
    );
}
