import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogClose,
    Input,
} from '@whimkit/ui';
import { Check, X } from 'lucide-react';
import { useState } from 'react';

import type { en } from './catalog.js';

/**
 * Compose credential settings from official shadcn dialog and input primitives.
 * @returns The rendered component.
 * @param root0
 * @param root0.open
 * @param root0.onOpenChange
 * @param root0.onCloseFocus
 * @param root0.t
 * @param root0.onSave
 * @param root0.errorText
 */
export function SettingsDialog({
    open,
    onOpenChange,
    onCloseFocus,
    t,
    onSave,
    errorText,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseFocus: () => void;
    t: typeof en;
    onSave: (key: string) => Promise<boolean>;
    errorText?: string;
}) {
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <Dialog
            open={open}
            onOpenChange={value => {
                if (!value) setKey('');
                onOpenChange(value);
            }}
        >
            <DialogContent
                showCloseButton={false}
                className="shadow-none"
                onCloseAutoFocus={event => {
                    event.preventDefault();
                    onCloseFocus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t.settings}</DialogTitle>
                    <DialogDescription>{t.keyHelp}</DialogDescription>
                </DialogHeader>
                <DialogClose asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t.close}
                        className="absolute right-3 top-3"
                    >
                        <X />
                    </Button>
                </DialogClose>
                <form
                    onSubmit={async event => {
                        event.preventDefault();
                        setBusy(true);
                        if (await onSave(key)) {
                            setKey('');
                            onOpenChange(false);
                        }
                        setBusy(false);
                    }}
                >
                    <label htmlFor="api-key" className="text-sm">
                        {t.key}
                    </label>
                    <Input
                        id="api-key"
                        type="password"
                        autoComplete="off"
                        value={key}
                        onChange={event => setKey(event.target.value)}
                        className="my-3 shadow-none"
                    />
                    <Button disabled={busy || !key.trim()}>
                        <Check />
                        {t.save}
                    </Button>
                </form>
                {errorText && (
                    <p role="alert" className="error-message">
                        {errorText}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}
