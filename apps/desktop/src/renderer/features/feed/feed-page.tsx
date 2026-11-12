import { Badge } from '@whimkit/ui/components/badge';
import { Button } from '@whimkit/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@whimkit/ui/components/dialog';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from '@whimkit/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import {
    CheckIcon,
    MessageSquareIcon,
    PlusIcon,
    QrCodeIcon,
    SettingsIcon,
    RefreshCwIcon,
    RssIcon,
    Trash2Icon,
    XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ActionButton } from '../../components/action-button';
import { ChoiceMenu } from '../../components/choice-menu';
import { call, ClientError } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { pluginText } from '../../lib/messages';
import { modelChoices } from '../chat/model-choices';
import { ModelPicker } from '../chat/model-picker';

import type {
    AppState,
    ChatSlot,
    Locale,
    SourceFix,
    SourceInfo,
    SourceTemplateInfo,
} from '../../../shared/ipc';
import type { PageProps } from '../../lib/navigation';
import type { SourceLogin } from '@whimkit/core/plugin';

/**
 * Report a failed command as a toast.
 * @param error The thrown value.
 * @param fallback Text when the error has no message.
 */
function notify(error: unknown, fallback: string): void {
    toast.error(error instanceof ClientError ? error.message : fallback);
}

/**
 * A template's name or description in the UI language, from its plugin's catalogs.
 * @param state Application state.
 * @param locale The UI language.
 * @param template The template.
 * @param key Which text.
 * @returns The text.
 */
function templateText(
    state: AppState,
    locale: Locale,
    template: SourceTemplateInfo,
    key: 'name' | 'description' | 'setup'
): string {
    // The setup text sits beside the name in the plugin's catalog: `source.<x>.setup`.
    const id = key === 'setup' ? template.name.replace(/\.name$/, '.setup') : template[key];
    return pluginText(
        state.plugins.find(plugin => plugin.id === template.pluginId)?.locales,
        locale,
        id,
        key === 'setup' ? '' : id
    );
}

/**
 * The Feed page: information sources with their state, and the actions on them.
 * @param props Application state and navigation.
 * @param props.state Application state.
 * @param props.navigate Navigate, here to a source's conversation.
 * @returns The page.
 */
export function FeedPage({ state, navigate }: PageProps) {
    const { t, locale } = useT();
    const [adding, setAdding] = useState(false);
    const [signingIn, setSigningIn] = useState<SourceInfo | undefined>();
    const [removing, setRemoving] = useState<SourceInfo | undefined>();
    // Coming back from Settings or a sign-in: check again instead of showing a stale result.
    const ids = state.sources.map(source => source.id).join(',');
    useEffect(() => {
        for (const id of ids ? ids.split(',') : [])
            void call('source.check', { id }).catch(() => undefined);
    }, [ids]);
    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold">{t('feed.title')}</h1>
                    <p className="text-muted-foreground text-sm">{t('feed.description')}</p>
                </div>
                <Button
                    className="rounded-full"
                    disabled={state.sourceTemplates.length === 0}
                    onClick={() => setAdding(true)}
                >
                    <PlusIcon /> {t('feed.add')}
                </Button>
            </div>
            {state.sources.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyTitle>{t('feed.empty.title')}</EmptyTitle>
                        <EmptyDescription>
                            {state.sourceTemplates.length === 0
                                ? t('feed.empty.noTemplates')
                                : t('feed.empty.description')}
                        </EmptyDescription>
                    </EmptyHeader>
                    {state.sourceTemplates.length > 0 && (
                        <EmptyContent>
                            <Button className="rounded-full" onClick={() => setAdding(true)}>
                                <PlusIcon /> {t('feed.add')}
                            </Button>
                        </EmptyContent>
                    )}
                </Empty>
            ) : (
                <ul className="flex flex-col gap-3">
                    {state.sources.map(source => {
                        const template = state.sourceTemplates.find(
                            item => item.id === source.template
                        );
                        return (
                            <SourceRow
                                key={source.id}
                                source={source}
                                template={template}
                                templateName={
                                    template && templateText(state, locale, template, 'name')
                                }
                                setupHint={
                                    template
                                        ? templateText(state, locale, template, 'setup')
                                        : undefined
                                }
                                onSetup={fix =>
                                    navigate('settings', {
                                        section: fix.kind === 'mcp' ? 'mcp' : 'models',
                                    })
                                }
                                onOpen={() => navigate('chat', { sessionId: source.sessionId })}
                                onSignIn={() => setSigningIn(source)}
                                onRemove={() => setRemoving(source)}
                            />
                        );
                    })}
                </ul>
            )}
            {adding && (
                <AddSourceDialog
                    state={state}
                    onCreated={sessionId => navigate('chat', { sessionId })}
                    onClose={() => setAdding(false)}
                />
            )}
            {signingIn && (
                <SignInDialog source={signingIn} onClose={() => setSigningIn(undefined)} />
            )}
            {removing && <RemoveDialog source={removing} onClose={() => setRemoving(undefined)} />}
        </div>
    );
}

/**
 * One source: name, state, and actions.
 * @param props The row.
 * @param props.source The source.
 * @param props.template Its template, absent when the plugin is not active.
 * @param props.templateName Its name in the UI language.
 * @param props.setupHint How to set it up, from its plugin; empty when the plugin has none.
 * @param props.onSetup Open the settings that fix it.
 * @param props.onOpen Open its conversation.
 * @param props.onSignIn Start its sign-in.
 * @param props.onRemove Ask to delete it.
 * @returns The row.
 */
function SourceRow({
    source,
    template,
    templateName,
    setupHint,
    onSetup,
    onOpen,
    onSignIn,
    onRemove,
}: {
    source: SourceInfo;
    template: SourceTemplateInfo | undefined;
    templateName: string | undefined;
    setupHint: string | undefined;
    onSetup: (fix: SourceFix) => void;
    onOpen: () => void;
    onSignIn: () => void;
    onRemove: () => void;
}) {
    const { t } = useT();
    const { health } = source;
    return (
        <li className="bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-4">
            <RssIcon className="text-muted-foreground size-5 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{source.name}</span>
                    <Badge variant={health.state === 'ready' ? 'secondary' : 'destructive'}>
                        {t(`feed.health.${health.state}`)}
                    </Badge>
                </div>
                <p className="text-muted-foreground truncate text-sm">
                    {templateName ?? source.template}
                    {health.state !== 'ready' &&
                        health.state !== 'needs-setup' &&
                        ` · ${health.detail}`}
                    {health.state === 'needs-setup' &&
                        ` · ${t(`feed.fix.${health.fix?.kind ?? 'other'}`)}`}
                </p>
                {health.state === 'needs-setup' && setupHint && (
                    <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">
                        {setupHint}
                    </p>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
                {health.state === 'needs-setup' && health.fix && (
                    <Button
                        size="sm"
                        className="rounded-full"
                        onClick={() => health.fix && onSetup(health.fix)}
                    >
                        <SettingsIcon /> {t('feed.openSettings')}
                    </Button>
                )}
                {health.state === 'needs-login' && template?.login && (
                    <Button size="sm" className="rounded-full" onClick={onSignIn}>
                        <QrCodeIcon /> {t('feed.signIn')}
                    </Button>
                )}
                <ActionButton
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    icon={<RefreshCwIcon />}
                    action={async () => {
                        try {
                            await call('source.check', { id: source.id });
                        } catch (error) {
                            notify(error, t('feed.checkFailed'));
                        }
                    }}
                >
                    {t('feed.check')}
                </ActionButton>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={onOpen}>
                    <MessageSquareIcon /> {t('feed.open')}
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={onRemove}>
                    <Trash2Icon /> {t('common.delete')}
                </Button>
            </div>
        </li>
    );
}

/**
 * Create a source from a template with a model.
 * @param props Dialog props.
 * @param props.state Application state.
 * @param props.onCreated Receives the new source's session.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
function AddSourceDialog({
    state,
    onCreated,
    onClose,
}: {
    state: AppState;
    onCreated: (sessionId: string) => void;
    onClose: () => void;
}) {
    const { t, locale } = useT();
    const choices = modelChoices(state);
    const first = choices[0];
    const [templateId, setTemplateId] = useState(state.sourceTemplates[0]?.id);
    const template = state.sourceTemplates.find(item => item.id === templateId);
    const [name, setName] = useState('');
    const [slot, setSlot] = useState<ChatSlot | undefined>(
        state.chatSlot ??
            (first ? { cardId: first.card.id, credentialId: first.credentialId } : undefined)
    );
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('feed.add')}</DialogTitle>
                    <DialogDescription>
                        {template && templateText(state, locale, template, 'description')}
                    </DialogDescription>
                </DialogHeader>
                <FieldGroup>
                    <Field>
                        <FieldLabel>{t('feed.template')}</FieldLabel>
                        <ChoiceMenu
                            value={templateId}
                            choices={state.sourceTemplates.map(item => ({
                                value: item.id,
                                label: templateText(state, locale, item, 'name'),
                            }))}
                            icon={<RssIcon />}
                            placeholder={t('feed.template')}
                            variant="outline"
                            onChange={value => setTemplateId(value)}
                        />
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="feed-name">{t('feed.name')}</FieldLabel>
                        <Input
                            id="feed-name"
                            value={name}
                            maxLength={60}
                            placeholder={template && templateText(state, locale, template, 'name')}
                            onChange={event => setName(event.currentTarget.value)}
                        />
                    </Field>
                    <Field>
                        <FieldLabel>{t('feed.model')}</FieldLabel>
                        <div>
                            <ModelPicker
                                state={state}
                                choices={choices}
                                slot={slot}
                                locked={false}
                                onChange={async next => setSlot(next)}
                            />
                        </div>
                    </Field>
                </FieldGroup>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon /> {t('common.cancel')}
                    </Button>
                    <ActionButton
                        icon={<CheckIcon />}
                        disabled={!template || !slot}
                        action={async () => {
                            if (!template || !slot) return;
                            try {
                                const { sessionId } = await call('source.create', {
                                    template: template.id,
                                    name:
                                        name.trim() ||
                                        templateText(state, locale, template, 'name'),
                                    slot,
                                });
                                onCreated(sessionId);
                                onClose();
                            } catch (error) {
                                notify(error, t('feed.createFailed'));
                            }
                        }}
                    >
                        {t('feed.create')}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Sign a source in: show the code to scan, then confirm.
 * @param props Dialog props.
 * @param props.source The source.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
function SignInDialog({ source, onClose }: { source: SourceInfo; onClose: () => void }) {
    const { t } = useT();
    const [login, setLogin] = useState<SourceLogin | undefined>();
    const [failure, setFailure] = useState<string | undefined>();
    const step = async () => {
        try {
            const next = await call('source.login', { id: source.id });
            setFailure(undefined);
            if (next.kind === 'done') onClose();
            else setLogin(next);
        } catch (error) {
            setFailure(error instanceof ClientError ? error.message : t('feed.signInFailed'));
        }
    };
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('feed.signInTitle', { name: source.name })}</DialogTitle>
                    <DialogDescription>
                        {login ? t('feed.signInScan') : t('feed.signInStart')}
                    </DialogDescription>
                </DialogHeader>
                {login?.kind === 'qr' && (
                    <img
                        src={login.image}
                        alt={t('feed.qrAlt')}
                        className="mx-auto size-56 rounded-2xl bg-white p-2"
                    />
                )}
                {failure && <p className="text-destructive text-sm">{failure}</p>}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon /> {t('common.cancel')}
                    </Button>
                    <ActionButton icon={login ? <CheckIcon /> : <QrCodeIcon />} action={step}>
                        {login ? t('feed.signInDone') : t('feed.signInShow')}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Confirm deleting a source and its data.
 * @param props Dialog props.
 * @param props.source The source.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
function RemoveDialog({ source, onClose }: { source: SourceInfo; onClose: () => void }) {
    const { t } = useT();
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('feed.removeTitle', { name: source.name })}</DialogTitle>
                    <DialogDescription>{t('feed.removeDetail')}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon /> {t('common.cancel')}
                    </Button>
                    <ActionButton
                        icon={<Trash2Icon />}
                        action={async () => {
                            try {
                                await call('source.remove', { id: source.id });
                                onClose();
                            } catch (error) {
                                notify(error, t('feed.removeFailed'));
                            }
                        }}
                    >
                        {t('common.delete')}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
