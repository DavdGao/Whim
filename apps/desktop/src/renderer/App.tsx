import { BoxesIcon, MessageSquareIcon, PuzzleIcon, SettingsIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

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
    SidebarGroup,
    SidebarGroupContent,
    SidebarInset,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
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
 * The application shell: an immersive title bar, a navigation rail, and the active page.
 * @returns The shell.
 */
function Shell() {
    const { state, status } = useAppState();
    const { t } = useT();
    const [page, setPage] = useState<Page>('chat');
    const current = pages.find(item => item.id === page) ?? pages[0];
    const banner =
        status === 'restarting'
            ? t('backend.restarting')
            : status === 'failed'
              ? t('backend.failed')
              : undefined;
    return (
        <div className="bg-sidebar text-sidebar-foreground flex h-svh flex-col">
            {/* Draggable title bar; the left inset leaves room for the macOS traffic lights. */}
            <header className="flex h-11 shrink-0 items-center gap-2 pr-4 pl-21 select-none [-webkit-app-region:drag]">
                <span className="text-sm font-semibold tracking-tight">{t('app.name')}</span>
                <span className="text-muted-foreground text-sm">/</span>
                <span className="text-muted-foreground text-sm">{t(current.label)}</span>
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
            <SidebarProvider defaultOpen={false} className="min-h-0 flex-1">
                <Sidebar
                    collapsible="icon"
                    variant="inset"
                    className="top-11 h-[calc(100svh-2.75rem)] pt-0"
                >
                    <SidebarContent>
                        <SidebarGroup className="pt-0">
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {pages.map(item => (
                                        <SidebarMenuItem key={item.id}>
                                            <SidebarMenuButton
                                                isActive={page === item.id}
                                                tooltip={t(item.label)}
                                                onClick={() => setPage(item.id)}
                                            >
                                                <item.icon />
                                                <span>{t(item.label)}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                </Sidebar>
                <SidebarInset className="min-h-0 overflow-hidden md:peer-data-[variant=inset]:mt-0">
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
                        <main className="min-h-0 flex-1 overflow-auto">
                            <StartupNotices notices={state.notices} />
                            {page === 'chat' && (
                                <ChatPage state={state} onOpenModels={() => setPage('models')} />
                            )}
                            {page === 'models' && <ModelsPage state={state} />}
                            {page === 'plugins' && <PluginsPage state={state} />}
                            {page === 'settings' && <SettingsPage state={state} />}
                        </main>
                    )}
                </SidebarInset>
            </SidebarProvider>
        </div>
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
