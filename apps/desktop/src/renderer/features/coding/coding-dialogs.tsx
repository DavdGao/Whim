import { Button } from '@whimkit/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@whimkit/ui/components/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import { Spinner } from '@whimkit/ui/components/spinner';
import { BotIcon, CheckIcon, FolderOpenIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';

import { ActionButton } from '../../components/action-button';
import { ChoiceMenu } from '../../components/choice-menu';
import { call, chooseDirectory } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';

import { agentName } from './agent-name';

import type { AppState, CodingHost } from '../../../shared/ipc';

/**
 * Add or edit an SSH host.
 * @param props Dialog props.
 * @param props.host The host to edit, or undefined to add one.
 * @param props.onSaved Receives the saved host's id.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
export function HostDialog({
    host,
    onSaved,
    onClose,
}: {
    host: CodingHost | undefined;
    onSaved: (id: string) => void;
    onClose: () => void;
}) {
    const { t } = useT();
    const [label, setLabel] = useState(host?.label ?? '');
    const [destination, setDestination] = useState(host?.destination ?? '');
    const save = useAction(async () => {
        const { id } = await call('coding.saveHost', {
            ...(host ? { id: host.id } : {}),
            label: label.trim() || destination.trim(),
            destination: destination.trim(),
        });
        onSaved(id);
        onClose();
    });
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="flex flex-col gap-4"
                    onSubmit={event => {
                        event.preventDefault();
                        void save.run();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {host ? t('coding.host.edit') : t('coding.host.add')}
                        </DialogTitle>
                    </DialogHeader>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="coding-host-destination">
                                {t('coding.host.destination')}
                            </FieldLabel>
                            <Input
                                id="coding-host-destination"
                                autoFocus
                                value={destination}
                                maxLength={255}
                                placeholder="me@dev-box"
                                spellCheck={false}
                                autoCapitalize="off"
                                onChange={event => setDestination(event.currentTarget.value)}
                            />
                            <FieldDescription>{t('coding.host.destinationHint')}</FieldDescription>
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="coding-host-label">
                                {t('coding.host.label')}
                            </FieldLabel>
                            <Input
                                id="coding-host-label"
                                value={label}
                                maxLength={100}
                                placeholder={destination.trim() || undefined}
                                onChange={event => setLabel(event.currentTarget.value)}
                            />
                        </Field>
                    </FieldGroup>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            <XIcon /> {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!destination.trim() || save.pending}>
                            {save.pending ? <Spinner /> : <CheckIcon />} {t('common.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Start a coding agent in a new session.
 * @param props Dialog props.
 * @param props.state Application state, for the agents.
 * @param props.hostId Where the session runs.
 * @param props.onStarted Receives the new session's key.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
export function NewSessionDialog({
    state,
    hostId,
    onStarted,
    onClose,
}: {
    state: AppState;
    hostId: string;
    onStarted: (key: string) => void;
    onClose: () => void;
}) {
    const { t } = useT();
    const [agentId, setAgentId] = useState(state.codingAgents[0]?.id);
    const [folder, setFolder] = useState('');
    const start = useAction(async () => {
        if (!agentId) return;
        const { key } = await call('coding.create', { hostId, agentId, folder: folder.trim() });
        onStarted(key);
        onClose();
    });
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="flex flex-col gap-4"
                    onSubmit={event => {
                        event.preventDefault();
                        void start.run();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{t('coding.new')}</DialogTitle>
                        {state.codingAgents.length === 0 && (
                            <DialogDescription>{t('coding.new.noAgents')}</DialogDescription>
                        )}
                    </DialogHeader>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="coding-agent">{t('coding.new.agent')}</FieldLabel>
                            <ChoiceMenu
                                id="coding-agent"
                                value={agentId}
                                choices={state.codingAgents.map(agent => ({
                                    value: agent.id,
                                    label: agentName(state, agent),
                                }))}
                                onChange={setAgentId}
                                icon={<BotIcon />}
                                placeholder={t('coding.new.agent')}
                                disabled={state.codingAgents.length === 0}
                            />
                        </Field>
                        <Field>
                            <FieldLabel htmlFor="coding-folder">
                                {t('coding.new.folder')}
                            </FieldLabel>
                            <div className="flex gap-2">
                                <Input
                                    id="coding-folder"
                                    value={folder}
                                    maxLength={4096}
                                    placeholder="~"
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    onChange={event => setFolder(event.currentTarget.value)}
                                />
                                {hostId === 'local' && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() =>
                                            void chooseDirectory().then(path => {
                                                if (path) setFolder(path);
                                            })
                                        }
                                    >
                                        <FolderOpenIcon /> {t('coding.new.browse')}
                                    </Button>
                                )}
                            </div>
                            <FieldDescription>{t('coding.new.folderHint')}</FieldDescription>
                        </Field>
                    </FieldGroup>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            <XIcon /> {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!agentId || start.pending}>
                            {start.pending ? <Spinner /> : <PlayIcon />} {t('coding.new.start')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Confirm a destructive action.
 * @param props Dialog props.
 * @param props.title The question.
 * @param props.description What happens.
 * @param props.confirm The confirming button's label.
 * @param props.action Runs on confirmation; the dialog closes when it succeeds.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
export function ConfirmDialog({
    title,
    description,
    confirm,
    action,
    onClose,
}: {
    title: string;
    description: string;
    confirm: string;
    action: () => Promise<unknown>;
    onClose: () => void;
}) {
    const { t } = useT();
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon /> {t('common.cancel')}
                    </Button>
                    <ActionButton
                        variant="destructive"
                        icon={<Trash2Icon />}
                        action={async () => {
                            await action();
                            onClose();
                        }}
                    >
                        {confirm}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
