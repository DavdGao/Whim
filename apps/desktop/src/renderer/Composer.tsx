import { Button, InputGroup, InputGroupAddon, InputGroupTextarea } from '@whimkit/ui';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';

import type { Command, Snapshot } from '../contracts.js';
import type { en } from './catalog.js';

/**
 * One attachment path for the file picker and drag-and-drop.
 * @returns The rendered component.
 * @param root0
 * @param root0.snapshot
 * @param root0.running
 * @param root0.t
 * @param root0.invoke
 */
export function Composer({
    snapshot,
    running,
    t,
    invoke,
}: {
    snapshot: Snapshot;
    running: boolean;
    t: typeof en;
    invoke: (command: Command) => Promise<boolean>;
}) {
    const [draft, setDraft] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [dragging, setDragging] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const text = useRef<HTMLTextAreaElement>(null);
    const model = snapshot.page?.card;
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp'].filter(mime =>
        Boolean(model?.inputMedia[mime])
    );
    const accepted = [
        'text/plain',
        'text/markdown',
        'application/json',
        'application/pdf',
        ...imageTypes,
    ];
    const add = (incoming: File[]) => {
        const next = [...files, ...incoming];
        if (
            next.length > 4 ||
            next.reduce((sum, file) => sum + file.size, 0) > 10000000 ||
            next.some(
                file =>
                    !file.size ||
                    !accepted.includes(
                        file.type || (file.name.endsWith('.md') ? 'text/markdown' : '')
                    )
            )
        ) {
            setError(t.attachmentError);
            return;
        }
        setFiles(next);
        setError('');
    };
    const send = async () => {
        if (busy || running || !snapshot.selectedId || (!draft.trim() && !files.length)) return;
        setBusy(true);
        setError('');
        try {
            const uploads = [];
            for (const file of files) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                let binary = '';
                for (let offset = 0; offset < bytes.length; offset += 32768)
                    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                uploads.push({
                    name: file.name,
                    mediaType: file.type || 'text/markdown',
                    data: btoa(binary),
                });
            }
            if (
                await invoke({
                    type: 'send',
                    sessionId: snapshot.selectedId,
                    operationId: crypto.randomUUID(),
                    text: draft,
                    files: uploads,
                })
            ) {
                setDraft('');
                setFiles([]);
            }
        } catch {
            setError(t.attachmentError);
        } finally {
            setBusy(false);
            text.current?.focus();
        }
    };
    return (
        <div className="composer-area mx-auto w-full max-w-3xl shrink-0 px-8 pb-5 pt-3">
            {error && (
                <p role="alert" className="error-message">
                    {error}
                </p>
            )}
            <form
                onSubmit={event => {
                    event.preventDefault();
                    void send();
                }}
                onDragOver={event => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={event => {
                    event.preventDefault();
                    setDragging(false);
                    if (!busy && !running) add(Array.from(event.dataTransfer.files));
                }}
            >
                {files.length > 0 && (
                    <ul className="flex flex-wrap gap-2 mb-2" aria-label={t.attachments}>
                        {files.map((file, index) => (
                            <li
                                key={`${file.name}-${index}`}
                                className="flex items-center gap-1 text-xs border rounded px-2 py-1"
                            >
                                <Paperclip size={12} />
                                <span>{file.name}</span>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-6"
                                    aria-label={`${t.removeAttachment} ${file.name}`}
                                    disabled={busy}
                                    onClick={() => setFiles(files.filter((_, i) => i !== index))}
                                >
                                    <X size={12} />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <InputGroup className={`shadow-none ${dragging ? 'ring-2 ring-primary' : ''}`}>
                    <InputGroupTextarea
                        ref={text}
                        className="min-h-20 max-h-48"
                        aria-label={t.placeholder}
                        placeholder={dragging ? t.dropFiles : t.placeholder}
                        value={draft}
                        maxLength={20000}
                        disabled={busy || !snapshot.selectedId || !snapshot.configured}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => {
                            if (
                                event.key === 'Enter' &&
                                !event.shiftKey &&
                                !event.nativeEvent.isComposing
                            ) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                    <InputGroupAddon align="block-end">
                        <input
                            ref={input}
                            type="file"
                            multiple
                            className="hidden"
                            aria-label={t.attachments}
                            accept={accepted.join(',')}
                            onChange={event => {
                                add(Array.from(event.target.files ?? []));
                                event.target.value = '';
                            }}
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t.attachFiles}
                            disabled={busy || running || !snapshot.selectedId}
                            onClick={() => input.current?.click()}
                        >
                            <Paperclip />
                        </Button>
                        <span className="flex-1" />
                        {running ? (
                            <Button
                                type="button"
                                size="icon"
                                aria-label={t.stop}
                                onClick={() =>
                                    snapshot.selectedId &&
                                    void invoke({ type: 'stop', sessionId: snapshot.selectedId })
                                }
                            >
                                <Square />
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                size="icon"
                                aria-label={t.send}
                                disabled={
                                    busy ||
                                    (!draft.trim() && !files.length) ||
                                    !snapshot.configured ||
                                    !snapshot.selectedId
                                }
                            >
                                <ArrowUp />
                            </Button>
                        )}
                    </InputGroupAddon>
                </InputGroup>
            </form>
            <p className="mt-3 text-center text-[11px] text-muted-foreground">
                {t.hint} · {t.attachmentLimits}
            </p>
        </div>
    );
}
