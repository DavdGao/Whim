import { Badge } from '@whimkit/ui/components/badge';
import { Button } from '@whimkit/ui/components/button';
import { Card, CardContent } from '@whimkit/ui/components/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@whimkit/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@whimkit/ui/components/dropdown-menu';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@whimkit/ui/components/field';
import { Input } from '@whimkit/ui/components/input';
import { ScrollArea } from '@whimkit/ui/components/scroll-area';
import { Spinner } from '@whimkit/ui/components/spinner';
import { Switch } from '@whimkit/ui/components/switch';
import { Textarea } from '@whimkit/ui/components/textarea';
import {
    CheckIcon,
    EllipsisIcon,
    GlobeIcon,
    PencilIcon,
    PlusIcon,
    ServerIcon,
    TerminalIcon,
    Trash2Icon,
    XIcon,
} from 'lucide-react';
import { useState } from 'react';

import { ChoiceMenu } from '../../components/choice-menu';
import { call } from '../../lib/client';
import { useT } from '../../lib/i18n';
import { useAction } from '../../lib/use-action';
import { ConfirmDialog } from '../coding/coding-dialogs';

import type { AppState, McpServerInfo } from '../../../shared/ipc';

/**
 * Parse `NAME=value` lines, ignoring blank ones.
 * @param text The lines.
 * @returns The pairs, or the first line that is not one.
 */
function pairs(text: string): Record<string, string> | { invalid: string } {
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const index = line.indexOf('=');
        if (index <= 0) return { invalid: line };
        result[line.slice(0, index).trim()] = line.slice(index + 1);
    }
    return result;
}

/**
 * Write pairs as `NAME=value` lines.
 * @param values The pairs.
 * @returns The lines.
 */
const lines = (values: Record<string, string>) =>
    Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

/**
 * An id for a new server from its name.
 * @param label The name.
 * @returns A short lowercase id.
 */
const slug = (label: string) =>
    label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20)
        .replace(/-+$/, '');

/**
 * The state line of a server.
 * @param props The server.
 * @param props.server The server.
 * @returns A badge and, when it failed, why.
 */
function ServerState({ server }: { server: McpServerInfo }) {
    const { t } = useT();
    const status = server.status;
    switch (status.state) {
        case 'disabled':
            return <Badge variant="outline">{t('mcp.state.disabled')}</Badge>;
        case 'connecting':
            return (
                <Badge variant="outline">
                    <Spinner /> {t('mcp.state.connecting')}
                </Badge>
            );
        case 'ready':
            return (
                <Badge variant="secondary">
                    {t('mcp.state.ready', { count: status.tools.length })}
                </Badge>
            );
        case 'failed':
            return <Badge variant="destructive">{t('mcp.state.failed')}</Badge>;
    }
}

/**
 * MCP servers: their connections, tools, and whether their calls ask first.
 * @param props Application state.
 * @param props.state Application state.
 * @returns The section.
 */
export function McpSettings({ state }: { state: AppState }) {
    const { t } = useT();
    const [editing, setEditing] = useState<McpServerInfo | 'new'>();
    const [removing, setRemoving] = useState<McpServerInfo>();
    const toggle = useAction((server: McpServerInfo, enabled: boolean) =>
        call('mcp.save', {
            server: {
                id: server.id,
                label: server.label,
                enabled,
                trusted: server.trusted,
                transport: server.transport,
            },
            replace: true,
            secretValues: {},
            removeSecrets: [],
        })
    );
    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
                <p className="text-muted-foreground text-sm">{t('mcp.description')}</p>
                <Button className="shrink-0" onClick={() => setEditing('new')}>
                    <PlusIcon /> {t('mcp.add')}
                </Button>
            </div>
            {state.mcpServers.length === 0 && (
                <Card>
                    <CardContent className="text-muted-foreground text-sm">
                        {t('mcp.empty')}
                    </CardContent>
                </Card>
            )}
            {state.mcpServers.map(server => (
                <Card key={server.id}>
                    <CardContent className="flex items-start gap-4">
                        <div className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-2xl">
                            {server.transport.kind === 'stdio' ? (
                                <TerminalIcon className="size-5" />
                            ) : (
                                <GlobeIcon className="size-5" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium">{server.label}</p>
                                <ServerState server={server} />
                                {server.trusted && (
                                    <Badge variant="outline">{t('mcp.trusted')}</Badge>
                                )}
                            </div>
                            <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                                {server.transport.kind === 'stdio'
                                    ? [server.transport.command, ...server.transport.args].join(' ')
                                    : server.transport.url}
                            </p>
                            {server.status.state === 'failed' && (
                                <p className="text-destructive mt-1 text-sm break-words">
                                    {server.status.detail}
                                </p>
                            )}
                            {server.status.state === 'ready' && server.status.tools.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {server.status.tools.map(tool => (
                                        <Badge key={tool} variant="outline" className="font-mono">
                                            {tool}
                                        </Badge>
                                    ))}
                                </div>
                            )}
                        </div>
                        <Switch
                            checked={server.enabled}
                            disabled={toggle.pending}
                            aria-label={t('mcp.enabled', { name: server.label })}
                            onCheckedChange={enabled => void toggle.run(server, enabled)}
                        />
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={t('mcp.actions', { name: server.label })}
                                >
                                    <EllipsisIcon />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setEditing(server)}>
                                    <PencilIcon /> {t('mcp.edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => setRemoving(server)}
                                >
                                    <Trash2Icon /> {t('mcp.remove')}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </CardContent>
                </Card>
            ))}
            {editing && (
                <ServerDialog
                    server={editing === 'new' ? undefined : editing}
                    taken={state.mcpServers.map(item => item.id)}
                    onClose={() => setEditing(undefined)}
                />
            )}
            {removing && (
                <ConfirmDialog
                    title={t('mcp.remove.title', { name: removing.label })}
                    description={t('mcp.remove.description')}
                    confirm={t('mcp.remove')}
                    action={() => call('mcp.remove', { id: removing.id })}
                    onClose={() => setRemoving(undefined)}
                />
            )}
        </div>
    );
}

/**
 * Add or edit an MCP server. Secret values are write-only: stored ones show by name and can be
 * replaced or removed, never read back.
 * @param props Dialog props.
 * @param props.server The server to edit, or undefined to add one.
 * @param props.taken Ids already in use.
 * @param props.onClose Close the dialog.
 * @returns The dialog.
 */
function ServerDialog({
    server,
    taken,
    onClose,
}: {
    server: McpServerInfo | undefined;
    taken: readonly string[];
    onClose: () => void;
}) {
    const { t } = useT();
    const transport = server?.transport;
    const [label, setLabel] = useState(server?.label ?? '');
    const [kind, setKind] = useState<'stdio' | 'http'>(transport?.kind ?? 'stdio');
    const [command, setCommand] = useState(transport?.kind === 'stdio' ? transport.command : '');
    const [args, setArgs] = useState(transport?.kind === 'stdio' ? transport.args.join('\n') : '');
    const [url, setUrl] = useState(transport?.kind === 'http' ? transport.url : '');
    const [plain, setPlain] = useState(
        transport ? lines(transport.kind === 'stdio' ? transport.env : transport.headers) : ''
    );
    const [secretText, setSecretText] = useState('');
    const [removed, setRemoved] = useState<readonly string[]>([]);
    const [trusted, setTrusted] = useState(server?.trusted ?? false);
    const id = server?.id ?? slug(label);
    const plainPairs = pairs(plain);
    const secretPairs = pairs(secretText);
    const invalid =
        'invalid' in plainPairs
            ? plainPairs.invalid
            : 'invalid' in secretPairs
              ? secretPairs.invalid
              : undefined;
    const idProblem = !id
        ? t('mcp.id.missing')
        : !server && taken.includes(id)
          ? t('mcp.id.taken')
          : undefined;
    const ready =
        !idProblem &&
        !invalid &&
        label.trim() !== '' &&
        (kind === 'stdio' ? command.trim() !== '' : URL.canParse(url.trim()));
    const save = useAction(async () => {
        if ('invalid' in plainPairs || 'invalid' in secretPairs) return;
        await call('mcp.save', {
            server: {
                id,
                label: label.trim(),
                enabled: server?.enabled ?? true,
                trusted,
                transport:
                    kind === 'stdio'
                        ? {
                              kind,
                              command: command.trim(),
                              args: args.split('\n').filter(arg => arg.trim() !== ''),
                              env: plainPairs,
                          }
                        : { kind, url: url.trim(), headers: plainPairs },
            },
            replace: server !== undefined,
            secretValues: secretPairs,
            removeSecrets: [...removed],
        });
        onClose();
    });
    const stored = (server?.secrets ?? []).filter(name => !removed.includes(name));
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
                <form
                    className="flex min-h-0 flex-col gap-4"
                    onSubmit={event => {
                        event.preventDefault();
                        if (ready) void save.run();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{server ? t('mcp.edit') : t('mcp.add')}</DialogTitle>
                        <DialogDescription>{t('mcp.dialog.description')}</DialogDescription>
                    </DialogHeader>
                    <ScrollArea className="min-h-0 flex-1">
                        <FieldGroup className="pr-3">
                            <Field>
                                <FieldLabel htmlFor="mcp-label">{t('mcp.label')}</FieldLabel>
                                <Input
                                    id="mcp-label"
                                    autoFocus
                                    value={label}
                                    maxLength={60}
                                    placeholder="GitHub"
                                    onChange={event => setLabel(event.currentTarget.value)}
                                />
                                <FieldDescription>
                                    {idProblem ?? t('mcp.id.hint', { id })}
                                </FieldDescription>
                            </Field>
                            <Field>
                                <FieldLabel>{t('mcp.kind')}</FieldLabel>
                                <ChoiceMenu
                                    value={kind}
                                    choices={[
                                        {
                                            value: 'stdio',
                                            label: t('mcp.kind.stdio'),
                                            icon: <TerminalIcon />,
                                        },
                                        {
                                            value: 'http',
                                            label: t('mcp.kind.http'),
                                            icon: <GlobeIcon />,
                                        },
                                    ]}
                                    onChange={value => setKind(value === 'http' ? 'http' : 'stdio')}
                                    icon={<ServerIcon />}
                                    placeholder={t('mcp.kind')}
                                    aria-label={t('mcp.kind')}
                                />
                            </Field>
                            {kind === 'stdio' ? (
                                <>
                                    <Field>
                                        <FieldLabel htmlFor="mcp-command">
                                            {t('mcp.command')}
                                        </FieldLabel>
                                        <Input
                                            id="mcp-command"
                                            value={command}
                                            placeholder="npx"
                                            spellCheck={false}
                                            className="font-mono"
                                            onChange={event =>
                                                setCommand(event.currentTarget.value)
                                            }
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="mcp-args">{t('mcp.args')}</FieldLabel>
                                        <Textarea
                                            id="mcp-args"
                                            value={args}
                                            rows={3}
                                            spellCheck={false}
                                            className="font-mono"
                                            placeholder={'-y\n@modelcontextprotocol/server-github'}
                                            onChange={event => setArgs(event.currentTarget.value)}
                                        />
                                        <FieldDescription>{t('mcp.args.hint')}</FieldDescription>
                                    </Field>
                                </>
                            ) : (
                                <Field>
                                    <FieldLabel htmlFor="mcp-url">{t('mcp.url')}</FieldLabel>
                                    <Input
                                        id="mcp-url"
                                        value={url}
                                        placeholder="https://example.com/mcp"
                                        spellCheck={false}
                                        className="font-mono"
                                        onChange={event => setUrl(event.currentTarget.value)}
                                    />
                                </Field>
                            )}
                            <Field>
                                <FieldLabel htmlFor="mcp-plain">
                                    {kind === 'stdio' ? t('mcp.env') : t('mcp.headers')}
                                </FieldLabel>
                                <Textarea
                                    id="mcp-plain"
                                    value={plain}
                                    rows={2}
                                    spellCheck={false}
                                    className="font-mono"
                                    placeholder="NAME=value"
                                    onChange={event => setPlain(event.currentTarget.value)}
                                />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="mcp-secrets">
                                    {kind === 'stdio' ? t('mcp.secretEnv') : t('mcp.secretHeaders')}
                                </FieldLabel>
                                {stored.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {stored.map(name => (
                                            <Badge
                                                key={name}
                                                variant="outline"
                                                className="font-mono"
                                            >
                                                {name}
                                                <button
                                                    type="button"
                                                    className="ml-1"
                                                    aria-label={t('mcp.secret.remove', { name })}
                                                    onClick={() =>
                                                        setRemoved(current => [...current, name])
                                                    }
                                                >
                                                    <XIcon className="size-3" />
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                <Textarea
                                    id="mcp-secrets"
                                    value={secretText}
                                    rows={2}
                                    spellCheck={false}
                                    autoComplete="off"
                                    className="font-mono"
                                    placeholder="API_KEY=…"
                                    onChange={event => setSecretText(event.currentTarget.value)}
                                />
                                <FieldDescription>{t('mcp.secrets.hint')}</FieldDescription>
                            </Field>
                            {invalid !== undefined && (
                                <p className="text-destructive text-sm">
                                    {t('mcp.pairs.invalid', { line: invalid })}
                                </p>
                            )}
                            <Field orientation="horizontal">
                                <FieldContent>
                                    <FieldLabel htmlFor="mcp-trusted">{t('mcp.trust')}</FieldLabel>
                                    <FieldDescription>{t('mcp.trust.hint')}</FieldDescription>
                                </FieldContent>
                                <Switch
                                    id="mcp-trusted"
                                    checked={trusted}
                                    onCheckedChange={setTrusted}
                                />
                            </Field>
                        </FieldGroup>
                    </ScrollArea>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            <XIcon /> {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!ready || save.pending}>
                            {save.pending ? <Spinner /> : <CheckIcon />} {t('common.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
