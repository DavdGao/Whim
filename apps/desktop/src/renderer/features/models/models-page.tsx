import { KeyRoundIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { call, ClientError } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { pluginText } from '../../lib/messages';
import { modelChoices } from '../chat/model-choices';

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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

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
    const [saving, setSaving] = useState(false);
    const type = state.credentialTypes.find(item => item.id === typeId);
    const plugin = state.plugins.find(item => item.id === type?.pluginId);

    const save = async () => {
        setSaving(true);
        try {
            await call('credentials.save', {
                ...(editing ? { id: editing.id } : {}),
                typeId,
                label: label.trim() || typeName(state, typeId, locale),
                values,
            });
            onOpenChange(false);
        } catch (error) {
            if (error instanceof ClientError && error.error.issues)
                setIssues(
                    Object.fromEntries(error.error.issues.map(issue => [issue.path, issue.message]))
                );
            toast.error(error instanceof ClientError ? error.message : t('error.generic'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {editing ? t('models.editCredential') : t('models.addCredential')}
                    </DialogTitle>
                    <DialogDescription>
                        {typeId ? typeName(state, typeId, locale) : null}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-6"
                    onSubmit={event => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <FieldGroup>
                        {!editing && state.credentialTypes.length > 1 && (
                            <Field>
                                <FieldLabel htmlFor="credential-type">
                                    {t('models.credentialType')}
                                </FieldLabel>
                                <Select value={typeId} onValueChange={setTypeId}>
                                    <SelectTrigger id="credential-type">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {state.credentialTypes.map(item => (
                                            <SelectItem key={item.id} value={item.id}>
                                                {typeName(state, item.id, locale)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        )}
                        <Field>
                            <FieldLabel htmlFor="credential-label">{t('models.label')}</FieldLabel>
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
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={saving || !typeId}>
                            {t('common.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The Models page: credentials, the default chat model, and the card catalog.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The page.
 */
export function ModelsPage({ state }: { state: AppState }) {
    const { t, locale } = useT();
    const [dialog, setDialog] = useState<{ editing?: CredentialInfo } | undefined>();
    const choices = modelChoices(state, state.chatSlot?.credentialId);
    const defaultCard = state.chatSlot?.cardId ?? choices[0]?.card.id;
    const formatter = new Intl.NumberFormat(locale, { notation: 'compact' });

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight">{t('models.title')}</h1>
                <p className="text-muted-foreground mt-1 text-sm">{t('models.description')}</p>
            </header>

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
                            className="flex items-center gap-3 rounded-lg border px-3 py-2"
                        >
                            <KeyRoundIcon className="text-muted-foreground size-4" />
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
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('common.delete')}
                                onClick={() =>
                                    void call('credentials.remove', { id: credential.id }).catch(
                                        () => toast.error(t('error.generic'))
                                    )
                                }
                            >
                                <Trash2Icon />
                            </Button>
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
                    <Select
                        value={defaultCard ?? ''}
                        disabled={choices.length === 0}
                        onValueChange={cardId => {
                            const choice = choices.find(item => item.card.id === cardId);
                            if (choice)
                                void call('settings.chatSlot', {
                                    slot: { cardId, credentialId: choice.credentialId },
                                });
                        }}
                    >
                        <SelectTrigger className="w-72" aria-label={t('models.defaultChat')}>
                            <SelectValue placeholder={t('chat.model')} />
                        </SelectTrigger>
                        <SelectContent>
                            {choices.map(choice => (
                                <SelectItem key={choice.card.id} value={choice.card.id}>
                                    {choice.card.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t('models.catalog')}</CardTitle>
                    <CardDescription className="break-all">
                        {t('models.catalogDescription', { dir: state.userCardsDir })}
                    </CardDescription>
                    <CardAction>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void call('catalog.reload', {})}
                        >
                            <RefreshCwIcon /> {t('models.reload')}
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    {state.catalog.map(entry => (
                        <div key={entry.id} className="rounded-lg border px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-medium">
                                    {entry.card?.name ?? entry.id}
                                </p>
                                <code className="text-muted-foreground text-xs">
                                    {entry.card ? entry.id : ''}
                                </code>
                                <span className="flex-1" />
                                {entry.card && (
                                    <span className="text-muted-foreground text-xs">
                                        {t('models.context', {
                                            tokens: formatter.format(entry.card.contextWindow),
                                        })}
                                    </span>
                                )}
                                <Badge variant="secondary">
                                    {t(`models.layer.${entry.layer}`)}
                                </Badge>
                                {entry.hidden && (
                                    <Badge variant="outline">{t('models.hidden')}</Badge>
                                )}
                                {entry.issues.length > 0 && (
                                    <Badge variant="destructive">{t('models.invalid')}</Badge>
                                )}
                            </div>
                            {entry.issues.length > 0 && (
                                <ul className="text-destructive mt-1 list-disc pl-5 text-xs">
                                    {entry.issues.map(issue => (
                                        <li key={issue}>{issue}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
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
