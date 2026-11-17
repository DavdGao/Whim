import { Button } from '@whimkit/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@whimkit/ui/components/dialog';
import { Field, FieldLabel } from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import { Spinner } from '@whimkit/ui/components/spinner';
import { CheckIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ActionButton } from '../../components/action-button';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { CredentialDialog } from '../models/models-page';

import type { AppState, SourceInfo } from '../../../shared/ipc';
import type { SourceLogin } from '@whimkit/core/plugin';

/**
 * Configure a source in Feed using its plugin's credential type or connection preset.
 * @param props Dialog inputs.
 * @param props.state Application state.
 * @param props.source Source being configured.
 * @param props.onClose Close and refresh source health.
 * @param props.onSignIn Continue to QR sign-in after connecting.
 * @returns The configuration dialog.
 */
export function SourceSettingsDialog({
    state,
    source,
    onClose,
    onSignIn,
}: {
    state: AppState;
    source: SourceInfo;
    onClose: () => void;
    onSignIn: (login?: SourceLogin) => void;
}) {
    const { t } = useT();
    const template = state.sourceTemplates.find(item => item.id === source.template);
    const server = state.mcpServers.find(item => item.id === template?.mcpServer);
    const [url, setUrl] = useState(
        server?.transport.kind === 'http' ? server.transport.url : (template?.mcpDefaultUrl ?? '')
    );
    const [failure, setFailure] = useState<string>();
    const [connecting, setConnecting] = useState(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        if (!connecting || !server || server.status.state === 'connecting') return;
        let active = true;
        void call('source.check', { id: source.id })
            .then(health => {
                if (!active) return;
                setConnecting(false);
                if (health.state === 'needs-login' && template?.login) onSignIn();
                else if (health.state === 'ready') onClose();
                else setFailure(t('feed.connectionFailed', { detail: health.detail }));
            })
            .catch(() => {
                if (active) {
                    setConnecting(false);
                    setFailure(t('feed.checkFailed'));
                }
            });
        return () => {
            active = false;
        };
    }, [connecting, server, source.id, template?.login, onClose, onSignIn, t]);
    if (template?.credentialType) {
        const typeId = template.credentialType;
        return (
            <CredentialDialog
                state={{
                    ...state,
                    credentialTypes: state.credentialTypes.filter(item => item.id === typeId),
                }}
                editing={state.credentials.findLast(
                    item => item.typeId === typeId && item.available
                )}
                open
                onOpenChange={open => !open && onClose()}
            />
        );
    }
    const existingStdio = server?.transport.kind === 'stdio';
    const validUrl = URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol);
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('feed.configure', { name: source.name })}</DialogTitle>
                    <DialogDescription>
                        {t(template?.managedMcp ? 'feed.managedHint' : 'feed.connectionHint')}
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 overflow-y-auto">
                    {template?.managedMcp ? (
                        <p className="text-muted-foreground text-sm">{t('feed.managedLogin')}</p>
                    ) : existingStdio ? (
                        <p className="text-muted-foreground text-sm">
                            {t('feed.existingConnection')}
                        </p>
                    ) : (
                        <Field>
                            <FieldLabel htmlFor="source-url">{t('feed.connectionUrl')}</FieldLabel>
                            <Input
                                id="source-url"
                                value={url}
                                onChange={event => setUrl(event.currentTarget.value)}
                                spellCheck={false}
                            />
                        </Field>
                    )}
                    {failure && (
                        <p role="alert" className="text-destructive mt-3 text-sm">
                            {failure}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon />
                        {t('common.cancel')}
                    </Button>
                    <ActionButton
                        icon={connecting ? <Spinner /> : <CheckIcon />}
                        disabled={
                            connecting ||
                            !template?.mcpServer ||
                            (!template.managedMcp && !existingStdio && !validUrl)
                        }
                        action={async () => {
                            if (!template?.mcpServer) return;
                            setFailure(undefined);
                            if (template.managedMcp) {
                                const health = await call('source.setup', { id: source.id });
                                if (!mounted.current) return;
                                if (health.state === 'ready') onClose();
                                else if (health.state === 'needs-login') {
                                    const login = await call('source.login', { id: source.id });
                                    if (!mounted.current) return;
                                    if (login.kind === 'done') onClose();
                                    else onSignIn(login);
                                } else setFailure(health.detail);
                                return;
                            }
                            await call('mcp.save', {
                                server: {
                                    id: template.mcpServer,
                                    label: server?.label ?? source.name,
                                    enabled: true,
                                    trusted: server?.trusted ?? false,
                                    transport:
                                        existingStdio && server
                                            ? server.transport
                                            : {
                                                  kind: 'http',
                                                  url: url.trim(),
                                                  headers:
                                                      server?.transport.kind === 'http'
                                                          ? server.transport.headers
                                                          : {},
                                              },
                                },
                                replace: server !== undefined,
                                secretValues: {},
                                removeSecrets: [],
                            });
                            setConnecting(true);
                        }}
                    >
                        {t(template?.managedMcp ? 'feed.prepareLogin' : 'feed.connect')}
                    </ActionButton>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
