import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { z } from 'zod';

import { recordSchema } from '../../contracts/records.js';
import { applyRecord, foldSession } from '../../contracts/view.js';
import { decide, needsRestartNotice, StoreError } from '../commands.js';

import { migrations } from './migrations.js';
import { requestSchema } from './protocol.js';

import type { AgentRecord } from '../../contracts/records.js';
import type { SessionView } from '../../contracts/view.js';
import type { Command } from '../commands.js';
import type { Request } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('The database must run in a worker thread.');
const { path } = z.strictObject({ path: z.string().min(1) }).parse(workerData);

const existed = path !== ':memory:' && existsSync(path);
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
migrate();

/** Apply pending migrations after backing up an existing database. */
function migrate(): void {
    const current = z.number().int().parse(userVersion());
    if (current > migrations.length) {
        db.close();
        throw new Error(`Database schema ${current} is newer than this application supports.`);
    }
    if (current === migrations.length) return;
    if (existed && current > 0) {
        const backup = `${path}.v${current}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    for (let index = current; index < migrations.length; index++) {
        transaction(() => {
            db.exec(migrations[index]);
            db.exec(`PRAGMA user_version = ${index + 1}`);
        });
    }
}

/**
 * Read the schema version.
 * @returns The current `user_version`.
 */
function userVersion(): unknown {
    return z.object({ user_version: z.number() }).parse(db.prepare('PRAGMA user_version').get())
        .user_version;
}

/**
 * Run a function inside an immediate transaction.
 * @param work Synchronous work to commit atomically.
 * @returns The work's result.
 */
function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = work();
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

/**
 * Encode a value with keys sorted by code point, independent of locale.
 * @param value JSON-compatible input.
 * @returns A stable JSON encoding.
 */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).filter(([, item]) => item !== undefined);
        entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new StoreError('invalid', 'Command is not JSON.');
    return encoded;
}

/**
 * Decode one stored record, upcasting older versions to the current shape.
 * @param body The stored JSON text.
 * @returns The validated record.
 */
function decodeRecord(body: string): AgentRecord {
    return recordSchema.parse(JSON.parse(body));
}

const rowBody = z.object({ body: z.string() });

/**
 * Read records after a sequence.
 * @param sessionId The session.
 * @param afterSeq Exclusive lower bound.
 * @returns Decoded records in order.
 */
function readRecords(sessionId: string, afterSeq: number): AgentRecord[] {
    return db
        .prepare('SELECT body FROM journal WHERE session_id = ? AND seq > ? ORDER BY seq')
        .all(sessionId, afterSeq)
        .map(row => decodeRecord(rowBody.parse(row).body));
}

const views = new Map<string, SessionView>();
const viewLimit = 16;

/**
 * Return the up-to-date view of a session, folding only records not yet cached.
 * @param sessionId The session.
 * @returns The view, or null when the session does not exist.
 */
function sessionView(sessionId: string): SessionView | null {
    const cached = views.get(sessionId);
    let view: SessionView | null;
    try {
        if (cached) {
            view = cached;
            for (const record of readRecords(sessionId, cached.head))
                view = applyRecord(view, record);
        } else {
            const records = readRecords(sessionId, 0);
            view = records.length ? foldSession(records) : null;
        }
    } catch (cause) {
        views.delete(sessionId);
        throw new StoreError('unreadable', `Session ${sessionId} cannot be read.`, { cause });
    }
    views.delete(sessionId);
    if (view) {
        views.set(sessionId, view);
        if (views.size > viewLimit) {
            const oldest = views.keys().next().value;
            if (oldest !== undefined) views.delete(oldest);
        }
    }
    return view;
}

/**
 * Execute a command idempotently: append its facts, the receipt, and the session projection.
 * @param command The validated command.
 * @returns The records the command produced (original ones on replay).
 */
function execute(command: Command): AgentRecord[] {
    return transaction(() => {
        const hash = createHash('sha256').update(canonical(command)).digest('hex');
        const receipt = db
            .prepare('SELECT command_hash, record_ids FROM receipts WHERE operation_id = ?')
            .get(command.operationId);
        if (receipt) {
            const previous = z
                .object({ command_hash: z.string(), record_ids: z.string() })
                .parse(receipt);
            if (previous.command_hash !== hash)
                throw new StoreError('conflict', 'Operation ID was reused with different input.');
            return z
                .array(z.string())
                .parse(JSON.parse(previous.record_ids))
                .map(recordId =>
                    decodeRecord(
                        rowBody.parse(
                            db.prepare('SELECT body FROM journal WHERE id = ?').get(recordId)
                        ).body
                    )
                );
        }
        const before = sessionView(command.sessionId);
        const bodies = decide(before, command);
        let seq = before?.head ?? 0;
        const createdAt = new Date().toISOString();
        const records = bodies.map(body =>
            recordSchema.parse({
                id: randomUUID(),
                sessionId: command.sessionId,
                seq: ++seq,
                version: 1,
                createdAt,
                operationId: command.operationId,
                body,
            })
        );
        let after = before;
        for (const record of records) after = after ? applyRecord(after, record) : null;
        if (!after && records.length) after = foldSession(records);
        const append = db.prepare(
            'INSERT INTO journal (session_id, seq, id, type, version, body) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const record of records)
            append.run(
                record.sessionId,
                record.seq,
                record.id,
                record.body.type,
                record.version,
                JSON.stringify(record)
            );
        db.prepare(
            'INSERT INTO receipts (operation_id, session_id, command_hash, record_ids) VALUES (?, ?, ?, ?)'
        ).run(command.operationId, command.sessionId, hash, JSON.stringify(records.map(r => r.id)));
        if (after && records.length) {
            db.prepare(
                `INSERT INTO sessions (id, title, card_id, created_at, updated_at, head, running, needs_recovery)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET title = excluded.title, card_id = excluded.card_id,
                 updated_at = excluded.updated_at, head = excluded.head, running = excluded.running,
                 needs_recovery = excluded.needs_recovery`
            ).run(
                after.sessionId,
                after.title,
                after.epoch.card.id,
                after.createdAt,
                after.updatedAt,
                after.head,
                after.run ? 1 : 0,
                after.run || needsRestartNotice(after) ? 1 : 0
            );
            views.set(after.sessionId, after);
        }
        return records;
    });
}

const sessionRow = z.object({
    id: z.string(),
    title: z.string(),
    card_id: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    head: z.number(),
    running: z.number(),
});

/**
 * Handle one validated request.
 * @param request The request.
 * @returns The result value to post back.
 */
function handle(request: Request): unknown {
    switch (request.op) {
        case 'execute':
            return execute(request.command);
        case 'read':
            return readRecords(request.sessionId, request.afterSeq);
        case 'view': {
            const view = sessionView(request.sessionId);
            if (!view) throw new StoreError('not-found', 'Session not found.');
            return view;
        }
        case 'sessions':
        case 'recovery-sessions':
            return db
                .prepare(
                    request.op === 'sessions'
                        ? 'SELECT * FROM sessions ORDER BY updated_at DESC'
                        : 'SELECT * FROM sessions WHERE needs_recovery = 1'
                )
                .all()
                .map(row => {
                    const value = sessionRow.parse(row);
                    return {
                        sessionId: value.id,
                        title: value.title,
                        cardId: value.card_id,
                        createdAt: value.created_at,
                        updatedAt: value.updated_at,
                        head: value.head,
                        running: value.running === 1,
                    };
                });
        case 'setting.get': {
            const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(request.key);
            return row ? JSON.parse(z.object({ value: z.string() }).parse(row).value) : undefined;
        }
        case 'setting.set':
            db.prepare(
                'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
            ).run(request.key, JSON.stringify(request.value));
            return null;
        case 'credential.list':
            return db
                .prepare('SELECT * FROM credentials ORDER BY created_at')
                .all()
                .map(row => {
                    const value = z
                        .object({
                            id: z.string(),
                            type_id: z.string(),
                            label: z.string(),
                            plain_values: z.string(),
                            created_at: z.string(),
                        })
                        .parse(row);
                    const secrets = db
                        .prepare('SELECT property FROM secrets WHERE credential_id = ?')
                        .all(value.id)
                        .map(secret => z.object({ property: z.string() }).parse(secret).property);
                    return {
                        credential: {
                            id: value.id,
                            typeId: value.type_id,
                            label: value.label,
                            plainValues: JSON.parse(value.plain_values),
                            createdAt: value.created_at,
                        },
                        secretProperties: secrets,
                    };
                });
        case 'credential.put':
            return transaction(() => {
                const value = request.credential;
                db.prepare(
                    `INSERT INTO credentials (id, type_id, label, plain_values, created_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (id) DO UPDATE SET label = excluded.label, plain_values = excluded.plain_values`
                ).run(
                    value.id,
                    value.typeId,
                    value.label,
                    JSON.stringify(value.plainValues),
                    value.createdAt
                );
                for (const property of request.removeSecrets)
                    db.prepare('DELETE FROM secrets WHERE credential_id = ? AND property = ?').run(
                        value.id,
                        property
                    );
                for (const [property, ciphertext] of Object.entries(request.secrets))
                    db.prepare(
                        `INSERT INTO secrets (credential_id, property, ciphertext) VALUES (?, ?, ?)
                         ON CONFLICT (credential_id, property) DO UPDATE SET ciphertext = excluded.ciphertext`
                    ).run(value.id, property, ciphertext);
                return null;
            });
        case 'credential.delete':
            db.prepare('DELETE FROM credentials WHERE id = ?').run(request.credentialId);
            return null;
        case 'secret.get':
            return Object.fromEntries(
                db
                    .prepare('SELECT property, ciphertext FROM secrets WHERE credential_id = ?')
                    .all(request.credentialId)
                    .map(row => {
                        const value = z
                            .object({ property: z.string(), ciphertext: z.instanceof(Uint8Array) })
                            .parse(row);
                        return [value.property, value.ciphertext];
                    })
            );
        case 'plugin.list':
            return db
                .prepare('SELECT * FROM plugins')
                .all()
                .map(row => {
                    const value = z
                        .object({
                            id: z.string(),
                            version: z.string(),
                            source: z.enum(['bundled', 'local']),
                            installed_at: z.string(),
                            content_hash: z.string(),
                            enabled: z.number(),
                        })
                        .parse(row);
                    return {
                        id: value.id,
                        version: value.version,
                        source: value.source,
                        installedAt: value.installed_at,
                        contentHash: value.content_hash,
                        enabled: value.enabled === 1,
                    };
                });
        case 'plugin.put': {
            const value = request.plugin;
            db.prepare(
                `INSERT INTO plugins (id, version, source, installed_at, content_hash, enabled) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET version = excluded.version, source = excluded.source,
                 content_hash = excluded.content_hash, enabled = excluded.enabled`
            ).run(
                value.id,
                value.version,
                value.source,
                value.installedAt,
                value.contentHash,
                value.enabled ? 1 : 0
            );
            return null;
        }
        case 'close':
            db.close();
            return null;
    }
}

port.on('message', (input: unknown) => {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
        const id = z.object({ id: z.number() }).safeParse(input);
        port.postMessage({
            type: 'error',
            id: id.success ? id.data.id : -1,
            code: 'invalid',
            message: parsed.error.message,
        });
        return;
    }
    const request = parsed.data;
    try {
        port.postMessage({ type: 'result', id: request.id, value: handle(request) });
        if (request.op === 'close') port.close();
    } catch (error) {
        const known = error instanceof StoreError;
        port.postMessage({
            type: 'error',
            id: request.id,
            code: known ? error.code : error instanceof z.ZodError ? 'invalid' : 'internal',
            message: describe(error),
        });
    }
});
port.postMessage({ type: 'ready' });

/**
 * Describe an error with its cause chain for diagnostics.
 * @param error Any thrown value.
 * @returns A message including causes.
 */
function describe(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error && parts.length < 5) {
        parts.push(current.message);
        current = current.cause;
    }
    if (parts.length === 0) parts.push(String(error));
    return parts.join(' ← ');
}
