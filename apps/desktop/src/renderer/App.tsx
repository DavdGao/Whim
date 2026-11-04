import { BoxesIcon, MessageSquareIcon, PuzzleIcon, SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import logo from './assets/whim.svg';
import { ChatPage } from './features/chat/chat-page';
import { ModelsPage } from './features/models/models-page';
import { PluginsPage } from './features/plugins/plugins-page';
import { SettingsPage } from './features/settings/settings-page';
import { AppStateProvider } from './lib/app-state';
import { useAppState } from './lib/app-state-context';
import { useT } from './lib/i18n';
import { LocaleProvider } from './lib/locale-provider';

import type { MessageKey } from './lib/messages';
import type { StartupNotice } from '../shared/ipc';

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
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

type Page = 'chat' | 'models' | 'plugins' | 'settings';

const pages: { id: Page; label: MessageKey; icon: typeof MessageSquareIcon }[] = [
    { id: 'chat', label: 'nav.chat', icon: MessageSquareIcon },
    { id: 'models', label: 'nav.models', icon: BoxesIcon },
    { id: 'plugins', label: 'nav.plugins', icon: PuzzleIcon },
    { id: 'settings', label: 'nav.settings', icon: SettingsIcon },
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
    item: (typeof pages)[number];
    active: boolean;
    onSelect: () => void;
}) {
    const { t } = useT();
    return (
        <SidebarMenuItem>
            <SidebarMenuButton isActive={active} tooltip={t(item.label)} onClick={onSelect}>
                <item.icon />
                <span>{t(item.label)}</span>
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
    const [page, setPage] = useState<Page>('chat');
    const banner =
        status === 'restarting'
            ? t('backend.restarting')
            : status === 'failed'
              ? t('backend.failed')
              : undefined;
    const main = pages.filter(item => item.id !== 'settings');
    const settings = pages.find(item => item.id === 'settings');
    return (
        <SidebarProvider className="bg-sidebar text-sidebar-foreground h-svh min-h-0 flex-col">
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
                                    tooltip={t('app.name')}
                                    onClick={() => setPage('chat')}
                                >
                                    <img src={logo} alt="" className="size-8 shrink-0 rounded-xl" />
                                    <span className="text-base font-semibold tracking-tight">
                                        {t('app.name')}
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
                                            active={page === item.id}
                                            onSelect={() => setPage(item.id)}
                                        />
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                    {settings && (
                        <SidebarFooter>
                            <SidebarMenu>
                                <NavItem
                                    item={settings}
                                    active={page === 'settings'}
                                    onSelect={() => setPage('settings')}
                                />
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
                            {page === 'chat' && (
                                <ChatPage state={state} onOpenModels={() => setPage('models')} />
                            )}
                            {page === 'models' && <ModelsPage state={state} />}
                            {page === 'plugins' && <PluginsPage state={state} />}
                            {page === 'settings' && <SettingsPage state={state} />}
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
            <TooltipProvider>
                <Shell />
                <Toaster />
            </TooltipProvider>
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
