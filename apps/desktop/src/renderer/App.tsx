import { Button, Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@whimkit/ui';
import { Circle, MessageSquare, Plus, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { en, zh } from './catalog.js';
import { Composer } from './Composer.js';
import { SettingsDialog } from './SettingsDialog.js';
import { Transcript } from './Transcript.js';
import { useChat } from './use-chat.js';

import type { ThinkingLevel } from '@whimkit/models';

/**
 * Minimal conversation workspace backed by typed desktop commands.
 * @returns The conversation workspace.
 */
export function App() {
    const { snapshot, failure, invoke } = useChat();
    const [settings, setSettings] = useState(false);
    const settingsButton = useRef<HTMLButtonElement>(null);
    const t = snapshot?.locale === 'zh-CN' ? zh : en;
    const running = Boolean(snapshot?.selectedId && snapshot.active.includes(snapshot.selectedId));
    const shownFailure = failure ?? (!running ? snapshot?.page?.failure : undefined);
    const errorText = shownFailure
        ? t[shownFailure.category === 'unavailable' ? 'unavailableModel' : shownFailure.category]
        : undefined;
    const model = snapshot?.page?.card ?? snapshot?.models[0];
    const thinking = snapshot?.page?.thinkingLevel ?? model?.defaultThinkingLevel;
    useEffect(() => {
        document.documentElement.lang = snapshot?.locale ?? 'en';
    }, [snapshot?.locale]);
    return (
        <div className="grid h-dvh grid-cols-[220px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col gap-2 border-r bg-muted/40 p-3">
                <div className="flex h-11 items-center px-2 text-base font-semibold tracking-tight">
                    Whim
                </div>
                <Button
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() =>
                        void invoke({
                            type: 'create',
                            modelId: model?.modelId,
                            thinkingLevel: thinking,
                        })
                    }
                >
                    <Plus />
                    {t.newChat}
                </Button>
                <h2 className="px-2 pt-5 pb-1 text-xs font-medium text-muted-foreground">
                    {t.conversations}
                </h2>
                <nav
                    aria-label={t.conversations}
                    className="min-h-0 flex-1 space-y-1 overflow-y-auto"
                >
                    {snapshot?.sessions.map((session, index) => (
                        <Button
                            key={session.id}
                            variant="ghost"
                            aria-current={snapshot.selectedId === session.id ? 'page' : undefined}
                            className={`conversation w-full justify-start text-sm font-normal ${snapshot.selectedId === session.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
                            onClick={() => void invoke({ type: 'snapshot', sessionId: session.id })}
                        >
                            <MessageSquare size={16} />
                            <span className="flex-1 truncate text-left">
                                {t.newChat} {snapshot.sessions.length - index}
                            </span>
                            {snapshot.active.includes(session.id) && (
                                <Circle size={8} fill="currentColor" />
                            )}
                        </Button>
                    ))}
                    {snapshot?.sessions.length === 0 && (
                        <p className="text-muted-foreground text-xs px-2 py-3">{t.emptyHistory}</p>
                    )}
                </nav>
                <div className="space-y-2 border-t pt-3">
                    <label className="sr-only" htmlFor="language">
                        {t.language}
                    </label>
                    <Select
                        value={snapshot?.locale ?? 'en'}
                        onValueChange={value =>
                            void invoke({
                                type: 'locale',
                                locale: value === 'zh-CN' ? 'zh-CN' : 'en',
                            })
                        }
                    >
                        <SelectTrigger
                            id="language"
                            aria-label={t.language}
                            className="w-full border-0 bg-transparent shadow-none"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="en">English</SelectItem>
                            <SelectItem value="zh-CN">简体中文</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button
                        ref={settingsButton}
                        variant="ghost"
                        className="justify-start w-full text-muted-foreground"
                        onClick={() => setSettings(true)}
                    >
                        <Settings />
                        {t.settings}
                    </Button>
                </div>
            </aside>
            <main className="flex min-h-0 min-w-0 flex-col">
                <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-5">
                    <div className="flex gap-2 items-center">
                        <Select
                            value={model?.modelId ?? 'qwen3.8-max'}
                            onValueChange={modelId => void invoke({ type: 'create', modelId })}
                        >
                            <SelectTrigger
                                aria-label={t.model}
                                title={t.newModelChat}
                                className="shadow-none border-0"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {snapshot?.models.map(item => (
                                    <SelectItem key={item.id} value={item.modelId}>
                                        {item.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {model?.thinkingLevelMap && (
                            <Select
                                value={thinking}
                                onValueChange={value =>
                                    void invoke({
                                        type: 'create',
                                        modelId: model.modelId,
                                        thinkingLevel: value as ThinkingLevel,
                                    })
                                }
                            >
                                <SelectTrigger
                                    aria-label={t.reasoning}
                                    title={t.newModelChat}
                                    className="shadow-none border-0"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Object.entries(model.thinkingLevelMap)
                                        .filter(([, value]) => value !== null)
                                        .map(([level]) => (
                                            <SelectItem key={level} value={level}>
                                                {t[level as ThinkingLevel]}
                                            </SelectItem>
                                        ))}
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Circle size={7} fill="currentColor" />
                        {snapshot?.configured ? t.configured : t.setup}
                    </span>
                </header>
                <Transcript
                    snapshot={snapshot}
                    running={running}
                    t={t}
                    onSettings={() => setSettings(true)}
                    onCreate={() => void invoke({ type: 'create' })}
                    invoke={invoke}
                />
                {errorText && (
                    <p role="alert" className="error-message px-8">
                        {errorText}
                    </p>
                )}
                {snapshot && (
                    <Composer
                        key={snapshot.selectedId ?? 'empty'}
                        snapshot={snapshot}
                        running={running}
                        t={t}
                        invoke={invoke}
                    />
                )}
            </main>
            <SettingsDialog
                open={settings}
                onOpenChange={setSettings}
                onCloseFocus={() => settingsButton.current?.focus()}
                t={t}
                errorText={errorText}
                onSave={key => invoke({ type: 'credential', key })}
            />
        </div>
    );
}
