import { isAbsolute, relative, sep } from 'node:path';

import type { Access, PermissionRule } from '../contracts/records.js';

export interface PermissionEnv {
    /** The session's workspace, when it has one. */
    readonly workspace?: string;
    /** Core's offload directory; tool results point the model there. */
    readonly artifactsDir: string;
}

/**
 * Whether `path` is `root` or inside it.
 * @param root A directory.
 * @param path An absolute path.
 * @returns True when contained.
 */
export function isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * What session grants match a shell command on: its first word for a simple command, the whole
 * command when it chains, pipes, redirects, or substitutes, so a grant for `ls` never covers
 * `ls; rm -rf ~`.
 * @param command The command line.
 * @returns The match key.
 */
function commandKey(command: string): string {
    const trimmed = command.trim();
    return /[;&|`$<>()\n]/.test(trimmed) ? trimmed : (trimmed.split(/\s+/)[0] ?? '');
}

/**
 * The host of a URL, or the URL itself when it does not parse.
 * @param url The URL.
 * @returns The host.
 */
function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * Whether a rule covers one access.
 * @param rule The rule.
 * @param name The tool.
 * @param access The access.
 * @returns True when allowed by the rule.
 */
function matches(rule: PermissionRule, name: string, access: Access): boolean {
    if (rule.tool !== name || rule.kind !== access.kind) return false;
    switch (access.kind) {
        case 'read':
        case 'write':
            return isInside(rule.pattern, access.path);
        case 'execute':
            return commandKey(access.command) === rule.pattern;
        case 'network':
            return hostOf(access.url) === rule.pattern;
    }
}

/**
 * Decide a call in manual mode: reads inside the workspace or the artifacts directory are
 * allowed; everything else needs a session rule or the user's answer.
 * @param name The tool.
 * @param access What the call touches.
 * @param rules Session grants.
 * @param env Workspace and artifacts locations.
 * @returns Whether the call may run or must ask.
 */
export function evaluate(
    name: string,
    access: readonly Access[],
    rules: readonly PermissionRule[],
    env: PermissionEnv
): 'allow' | 'ask' {
    for (const item of access) {
        if (
            item.kind === 'read' &&
            ((env.workspace && isInside(env.workspace, item.path)) ||
                isInside(env.artifactsDir, item.path))
        )
            continue;
        if (!rules.some(rule => matches(rule, name, item))) return 'ask';
    }
    return 'allow';
}

/**
 * Rules granted by "Allow for this session": files inside the workspace (or the exact path
 * outside it), the command key, or the host.
 * @param name The tool.
 * @param access What the call touched.
 * @param workspace The session's workspace.
 * @returns Rules covering this access and similar later calls.
 */
export function rulesFor(
    name: string,
    access: readonly Access[],
    workspace: string | undefined
): PermissionRule[] {
    return access.map(item => {
        switch (item.kind) {
            case 'read':
            case 'write':
                return {
                    tool: name,
                    kind: item.kind,
                    pattern: workspace && isInside(workspace, item.path) ? workspace : item.path,
                };
            case 'execute':
                return { tool: name, kind: 'execute', pattern: commandKey(item.command) };
            case 'network':
                return { tool: name, kind: 'network', pattern: hostOf(item.url) };
        }
    });
}
