import { MessageResponse } from '@whimkit/ui/components/ai-elements/message';
import { Button } from '@whimkit/ui/components/button';
import {
    CodeBlock,
    CodeBlockActions,
    CodeBlockContent,
    CodeBlockCopyButton,
    CodeBlockHeader,
    CodeBlockLine,
    CodeBlockTitle,
} from '@whimkit/ui/components/code-block';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@whimkit/ui/components/dialog';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@whimkit/ui/components/table';
import { cn } from '@whimkit/ui/lib/utils';
import { ExternalLinkIcon, XIcon } from 'lucide-react';
import { useIsCodeFenceIncomplete } from 'streamdown';

import { useT } from '../lib/i18n';

import type { ComponentProps } from 'react';
import type { ExtraProps, LinkSafetyModalProps } from 'streamdown';

import { useHighlightedCode } from '@/hooks/use-highlighted-code';

/**
 * A fenced code block as a shadcn CodeBlock with syntax highlighting.
 * @param props Block props.
 * @param props.code The code.
 * @param props.language The fence's language, if any.
 * @returns The block.
 */
function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
    // True while the closing fence has not streamed in yet.
    const incomplete = useIsCodeFenceIncomplete();
    const lines = useHighlightedCode(code, language);
    return (
        <CodeBlock size="sm" className="my-3">
            <CodeBlockHeader>
                <CodeBlockTitle>{language || 'text'}</CodeBlockTitle>
                <CodeBlockActions>
                    <CodeBlockCopyButton value={code} disabled={incomplete} />
                </CodeBlockActions>
            </CodeBlockHeader>
            <CodeBlockContent>
                {lines.map((line, index) => (
                    <CodeBlockLine key={index}>{line}</CodeBlockLine>
                ))}
            </CodeBlockContent>
        </CodeBlock>
    );
}

/**
 * Inline code stays inline; fenced code (marked `data-block` by Streamdown) becomes a block.
 * @param props.node
 * @param props Code element props from Streamdown.
 * @param props.className The fence's `language-*` class.
 * @param props.children The code text.
 * @returns Inline code or a code block.
 */
function MarkdownCode({
    node: _node,
    className,
    children,
    ...props
}: ComponentProps<'code'> & ExtraProps) {
    if (!('data-block' in props))
        return (
            <code
                className={cn('bg-muted rounded-sm px-1 py-0.5 font-mono text-[0.9em]', className)}
                {...props}
            >
                {children}
            </code>
        );
    return (
        <MarkdownCodeBlock
            code={typeof children === 'string' ? children : ''}
            language={/language-(\S+)/.exec(className ?? '')?.[1] ?? ''}
        />
    );
}

/**
 * Drop Streamdown's `node` prop before passing element props to a shadcn component.
 * @param Component The shadcn component.
 * @returns A Markdown element renderer.
 */
function element<P extends object>(Component: (props: P) => React.ReactNode) {
    const Element = ({ node: _node, ...props }: P & ExtraProps) => <Component {...(props as P)} />;
    Element.displayName = `Markdown(${Component.name})`;
    return Element;
}

// Streamdown memoizes on `components`, so the mapping stays one stable object.
const components = {
    code: MarkdownCode,
    table: element(({ className, ...props }: ComponentProps<'table'>) => (
        <div className="my-3 overflow-hidden rounded-2xl border">
            <Table className={className} {...props} />
        </div>
    )),
    thead: element(TableHeader),
    tbody: element(TableBody),
    tr: element(TableRow),
    th: element(TableHead),
    td: element(TableCell),
};

/**
 * Confirmation before a link from model output opens in the browser.
 * @param props Streamdown's modal props.
 * @param props.isOpen Whether the dialog is open.
 * @param props.onClose Dismiss.
 * @param props.onConfirm Open the link.
 * @param props.url The link.
 * @returns The dialog.
 */
function LinkConfirm({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
    const { t } = useT();
    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('link.title')}</DialogTitle>
                    <DialogDescription>{t('link.description')}</DialogDescription>
                </DialogHeader>
                <p className="bg-muted rounded-xl px-3 py-2 font-mono text-xs break-all">{url}</p>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        <XIcon />
                        {t('common.cancel')}
                    </Button>
                    <Button onClick={onConfirm}>
                        <ExternalLinkIcon />
                        {t('link.open')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const linkSafety = {
    enabled: true,
    renderModal: (props: LinkSafetyModalProps) => <LinkConfirm {...props} />,
};

/**
 * Model output as Markdown. Streamdown parses and lays out the text (headings, lists, emphasis,
 * links, math); everything with its own chrome is a shadcn component instead of Streamdown's:
 * code blocks, tables, and the link confirmation. Streamdown's controls are off.
 * @param props Streamdown props.
 * @param props.className Extra classes.
 * @returns The rendered Markdown.
 */
export function Markdown({ className, ...props }: ComponentProps<typeof MessageResponse>) {
    return (
        <MessageResponse
            components={components}
            controls={false}
            linkSafety={linkSafety}
            {...props}
            // Long unbroken strings (hashes, URLs) wrap instead of widening the message.
            className={cn('wrap-anywhere', className)}
        />
    );
}
