import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarTrigger,
} from '@whimkit/ui/components/sidebar';
import { Skeleton } from '@whimkit/ui/components/skeleton';
import { Toaster } from '@whimkit/ui/components/sonner';
import { TooltipProvider } from '@whimkit/ui/components/tooltip';
import { MessageSquareIcon, SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AgentAvatar } from './components/agent-avatar';
import { ChatPage } from './features/chat/chat-page';
import { SettingsPage } from './features/settings/settings-page';
import { AppStateProvider } from './lib/app-state';
import { useAppState } from './lib/app-state-context';
import { onOpenSession } from './lib/client';
import { useT } from './lib/i18n';
import { LocaleProvider } from './lib/locale-provider';
import { pluginText } from './lib/messages';
import { useTheme } from './lib/use-theme';
import { PluginBoundary, PluginUiProvider } from './plugins/plugin-provider';
import { pluginPageId, usePluginRegistrations } from './plugins/plugin-ui';

import type { Location, PageEntry, PageParams } from './lib/navigation';
import type { StartupNotice } from '../shared/ipc';

/** The host's pages, registered like plugin pages will be (design.md §5.7). */
const pages: readonly PageEntry[] = [
    {
        id: 'chat',
        title: 'nav.chat',
        icon: MessageSquareIcon,
        placement: 'main',
        component: ChatPage,
    },
    {
        id: 'settings',
        title: 'nav.settings',
        icon: SettingsIcon,
        placement: 'footer',
        component: SettingsPage,
    },
];

/**
 * Show startup notices once per session of the Renderer.
 * @param props The notices.
 * @param props.notices Notices from application state.
 * @returns Nothing visible; notices appear as toasts.
 */
function StartupNotices({ notices }: { notices: readonly StartupNotice[] }) {
    const { t } = useT();
    const shown = useRef(new Set<string>());
    useEffect(() => {
        for (const notice of notices) {
            if (shown.current.has(notice.path)) continue;
            shown.current.add(notice.path);
            toast.info(t('notice.databaseMoved', { path: notice.path }), {
                duration: Infinity,
                closeButton: true,
            });
        }
    }, [notices, t]);
    return null;
}

/**
 * The rail's pages: the host's, then those plugin client entries registered.
 * @returns Page entries.
 */
function usePages(): readonly PageEntry[] {
    const { pages: pluginPages } = usePluginRegistrations();
    return useMemo(
        () => [
            ...pages.filter(page => page.placement === 'main'),
            ...pluginPages.map((page): PageEntry => {
                const own = new Set(
                    pluginPages.filter(item => item.pluginId === page.pluginId).map(item => item.id)
                );
                const Content = page.component;
                return {
                    id: pluginPageId(page.pluginId, page.id),
                    title: { pluginId: page.pluginId, key: page.title },
                    icon: page.icon,
                    placement: 'main',
                    component: ({ params, navigate }) => (
                        <PluginBoundary pluginId={page.pluginId}>
                            <Content
                                params={params}
                                // A plugin names its own pages by the ids it registered.
                                navigate={(target, targetParams) =>
                                    navigate(
                                        own.has(target)
                                            ? pluginPageId(page.pluginId, target)
                                            : target,
                                        targetParams
                                    )
                                }
                            />
                        </PluginBoundary>
                    ),
                };
            }),
            ...pages.filter(page => page.placement === 'footer'),
        ],
        [pluginPages]
    );
}

/**
 * One navigation entry.
 * @param props The entry.
 * @param props.item The page.
 * @param props.active Whether it is the current page.
 * @param props.onSelect Navigate to the page.
 * @returns The menu item.
 */
function NavItem({
    item,
    active,
    onSelect,
}: {
    item: PageEntry;
    active: boolean;
    onSelect: () => void;
}) {
    const { t, locale } = useT();
    const { state } = useAppState();
    const { title: entryTitle } = item;
    const title =
        typeof entryTitle === 'string'
            ? t(entryTitle)
            : pluginText(
                  state?.plugins.find(plugin => plugin.id === entryTitle.pluginId)?.locales,
                  locale,
                  entryTitle.key,
                  entryTitle.key
              );
    return (
        <SidebarMenuItem>
            <SidebarMenuButton isActive={active} tooltip={title} onClick={onSelect}>
                <item.icon />
                <span>{title}</span>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

/**
 * The application shell: a draggable title strip, a navigation rail, and the active page.
 * @returns The shell.
 */
function Shell() {
    const { state, status } = useAppState();
    const { t } = useT();
    const [location, setLocation] = useState<Location>({ page: 'chat', params: {} });
    const navigate = useCallback((page: string, params: PageParams = {}) => {
        setLocation({ page, params: { ...params } });
    }, []);
    // The menu bar item and notifications ask to show a chat (design.md §4.1).
    useEffect(() => onOpenSession(sessionId => navigate('chat', { sessionId })), [navigate]);
    const allPages = usePages();
    const background = useTheme(state);
    const current = allPages.find(item => item.id === location.page) ?? allPages[0];
    const banner =
        status === 'restarting'
            ? t('backend.restarting')
            : status === 'failed'
              ? t('backend.failed')
              : undefined;
    const main = allPages.filter(item => item.placement === 'main');
    const footer = allPages.filter(item => item.placement === 'footer');
    return (
        <SidebarProvider
            defaultOpen={false}
            className="bg-sidebar text-sidebar-foreground h-svh min-h-0 flex-col bg-cover bg-center"
            // A theme's background image shows behind the chrome (design.md §5.7).
            style={background ? { backgroundImage: `url("${background}")` } : undefined}
        >
            {/* Draggable title strip; the left inset leaves room for the macOS traffic lights. */}
            <header className="flex h-11 shrink-0 items-center gap-2 pr-4 pl-21 select-none [-webkit-app-region:drag]">
                <SidebarTrigger
                    className="[-webkit-app-region:no-drag]"
                    aria-label={t('nav.toggle')}
                />
                <span className="flex-1" />
                {status !== 'connected' && (
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <span
                            className={
                                status === 'failed'
                                    ? 'bg-destructive size-1.5 rounded-full'
                                    : 'size-1.5 animate-pulse rounded-full bg-amber-500'
                            }
                        />
                        {status === 'connecting'
                            ? t('backend.connecting')
                            : status === 'failed'
                              ? t('backend.failed')
                              : t('backend.restarting')}
                    </span>
                )}
            </header>
            <div className="flex min-h-0 flex-1">
                <Sidebar
                    collapsible="icon"
                    variant="inset"
                    className="top-11 h-[calc(100svh-2.75rem)] pt-0"
                >
                    <SidebarHeader>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    size="lg"
                                    tooltip={state?.agent.name ?? t('app.name')}
                                    onClick={() => navigate('chat')}
                                >
                                    <AgentAvatar icon={state?.agent.icon} />
                                    <span className="truncate text-base font-semibold tracking-tight">
                                        {state?.agent.name ?? t('app.name')}
                                    </span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarHeader>
                    <SidebarContent>
                        <SidebarGroup>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {main.map(item => (
                                        <NavItem
                                            key={item.id}
                                            item={item}
                                            active={item === current}
                                            onSelect={() => navigate(item.id)}
                                        />
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                    {footer.length > 0 && (
                        <SidebarFooter>
                            <SidebarMenu>
                                {footer.map(item => (
                                    <NavItem
                                        key={item.id}
                                        item={item}
                                        active={item === current}
                                        onSelect={() => navigate(item.id)}
                                    />
                                ))}
                            </SidebarMenu>
                        </SidebarFooter>
                    )}
                </Sidebar>
                <SidebarInset className="min-h-0 overflow-hidden md:peer-data-[variant=inset]:mt-0 md:peer-data-[variant=inset]:rounded-2xl">
                    {banner && (
                        <div className="bg-destructive/10 text-destructive px-4 py-2 text-sm">
                            {banner}
                        </div>
                    )}
                    {!state ? (
                        <div className="flex flex-1 flex-col gap-3 p-8" aria-busy="true">
                            <Skeleton className="h-8 w-1/3" />
                            <Skeleton className="h-24 w-2/3" />
                        </div>
                    ) : (
                        <div className="min-h-0 flex-1 overflow-auto">
                            <StartupNotices notices={state.notices} />
                            {current && (
                                <current.component
                                    state={state}
                                    params={location.params}
                                    navigate={navigate}
                                />
                            )}
                        </div>
                    )}
                </SidebarInset>
            </div>
        </SidebarProvider>
    );
}

/**
 * Provide the locale from application state.
 * @returns The localized shell.
 */
function Localized() {
    const { state } = useAppState();
    return (
        <LocaleProvider locale={state?.locale ?? 'en'}>
            <PluginUiProvider>
                <TooltipProvider>
                    <Shell />
                    <Toaster />
                </TooltipProvider>
            </PluginUiProvider>
        </LocaleProvider>
    );
}

/**
 * The Renderer root.
 * @returns The application.
 */
export function App() {
    return (
        <AppStateProvider>
            <Localized />
        </AppStateProvider>
    );
}
