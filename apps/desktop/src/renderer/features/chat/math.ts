import { createMathPlugin } from '@streamdown/math';

/** KaTeX math for model output; `$…$` is common in model answers, so single dollars are math. */
export const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

const codeOrMath = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g;

/**
 * Rewrite LaTeX `\[…\]` and `\(…\)` delimiters, which remark-math does not parse, into `$$…$$`
 * and `$…$`, leaving code spans and fenced blocks untouched.
 * @param text Markdown from the model.
 * @returns Markdown with dollar math delimiters.
 */
export function normalizeMath(text: string): string {
    if (!text.includes('\\[') && !text.includes('\\(')) return text;
    return text.replace(
        codeOrMath,
        (match, code: string | undefined, block: string | undefined, inline: string | undefined) =>
            code !== undefined
                ? match
                : block !== undefined
                  ? `\n$$\n${block.trim()}\n$$\n`
                  : `$${(inline ?? '').trim()}$`
    );
}
