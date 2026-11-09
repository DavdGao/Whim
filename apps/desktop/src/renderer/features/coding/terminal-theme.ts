import type { ITheme } from '@xterm/xterm';

// The Coding terminal is always dark (design.md §11.4): coding CLIs draw most of their interface in
// true color tuned for a dark background, which a light terminal would make unreadable. The ANSI
// colors are Tailwind's 400 (normal) and 300 (bright) shades, matching the application's palette.

/** Colors of the Coding terminal. */
export const terminalTheme = {
    background: '#151517',
    foreground: '#e4e4e7',
    cursor: '#e4e4e7',
    cursorAccent: '#151517',
    selectionBackground: '#3f3f4699',
    black: '#27272a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d8',
    brightBlack: '#71717a',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde047',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
} as const satisfies ITheme;
