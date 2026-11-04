import { createHash, randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { decide, StoreError } from './commands.js';
import { artifactSchema } from './presentation.js';
import { requestSchema } from './protocol.js';
import { recordSchema } from './records.js';
import { advanceRecords, foldRecords } from './view.js';

import type { AgentRecord, Command } from './records.js';

const port = parentPort;
if (!port) throw new Error('The database must run in a dedicated worker.');
const { path, nativeBinding } = z
    .strictObject({ path: z.string().min(1), nativeBinding: z.string().optional() })
    .parse(workerData);
const db = new Database(path, { nativeBinding });
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
const version = db.pragma('user_version', { simple: true });
if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
    db.close();
    throw new Error('Unsupported database schema version.');
}
if (version === 0) {
    db.transaction(() => {
        db.exec(`
            CREATE TABLE journal (
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                id TEXT NOT NULL UNIQUE,
                body TEXT NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            CREATE TABLE receipts (
                operation_id TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                record_ids TEXT NOT NULL
            );
            PRAGMA user_version = 1;
        `);
    }).immediate();
}

if (db.pragma('user_version', { simple: true }) === 1) {
    db.transaction(() => {
        db.exec(
            'CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 2;'
        );
    }).immediate();
}

if (db.pragma('user_version', { simple: true }) === 2) {
    db.transaction(() =>
        db.exec(
            'CREATE TABLE artifacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, bytes BLOB NOT NULL); PRAGMA user_version = 3;'
        )
    ).immediate();
}

/**
 * Canonicalize command objects for semantic idempotency, preserving array order.
 * @param value Untrusted input to validate or encode.
 * @returns A stable JSON encoding.
 */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`;
    }
    const result = JSON.stringify(value);
    if (result === undefined) throw new StoreError('invalid', 'Command is not JSON.');
    return result;
}

/**
 * Decode authoritative JSON without trusting database rows as application types.
 * @param sessionId The target session identity.
 * @param afterSeq
 * @returns Validated journal records.
 */
function read(sessionId: string, afterSeq = '0'): AgentRecord[] {
    return db
        .prepare('SELECT body FROM journal WHERE session_id = ? AND seq > ? ORDER BY seq')
        .all(sessionId, BigInt(afterSeq))
        .map(row => recordSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)));
}

const views = new Map<string, ReturnType<typeof foldRecords>>();

/** Reconcile cached projections from committed journal facts only.
 * @param sessionId The target session.
 * @returns A rebuildable projection, or null for an absent session.
 */
function refreshView(sessionId: string) {
    const cached = views.get(sessionId);
    const history = read(sessionId, cached?.head);
    let view;
    try {
        view = cached
            ? advanceRecords(cached, history)
            : history.length
              ? foldRecords(history)
              : null;
    } catch (error) {
        views.delete(sessionId);
        throw error;
    }
    if (view) {
        views.delete(sessionId);
        views.set(sessionId, view);
        if (views.size > 4) {
            const oldest = views.keys().next().value;
            if (oldest) views.delete(oldest);
        }
    }
    return view;
}

const execute = db.transaction((command: Command): AgentRecord[] => {
    const encoded = createHash('sha256').update(canonical(command)).digest('hex');
    const receipt = db
        .prepare('SELECT command, record_ids FROM receipts WHERE operation_id = ?')
        .get(command.operationId);
    if (receipt) {
        const previous = z.object({ command: z.string(), record_ids: z.string() }).parse(receipt);
        if (previous.command !== encoded)
            throw new StoreError('conflict', 'Operation ID was reused with different input.');
        const ids = z.array(z.string()).parse(JSON.parse(previous.record_ids));
        return ids.map(id => {
            const row = z
                .object({ body: z.string() })
                .parse(db.prepare('SELECT body FROM journal WHERE id = ?').get(id));
            return recordSchema.parse(JSON.parse(row.body));
        });
    }
    const view = refreshView(command.sessionId);
    const facts = decide(view, command);
    let seq = BigInt(view?.head ?? '0');
    const records = facts.map(fact =>
        recordSchema.parse({
            id: randomUUID(),
            sessionId: command.sessionId,
            seq: String(++seq),
            schemaVersion: 1,
            operationId: command.operationId,
            createdAt: new Date().toISOString(),
            fact,
        })
    );
    const append = db.prepare(
        'INSERT INTO journal (session_id, seq, id, body) VALUES (?, ?, ?, ?)'
    );
    for (const record of records) {
        append.run(record.sessionId, BigInt(record.seq), record.id, JSON.stringify(record));
    }
    db.prepare('INSERT INTO receipts (operation_id, command, record_ids) VALUES (?, ?, ?)').run(
        command.operationId,
        encoded,
        JSON.stringify(records.map(record => record.id))
    );
    return records;
});

port.on('message', (input: unknown) => {
    const request = requestSchema.parse(input);
    try {
        let records: AgentRecord[] = [];
        let locale: 'en' | 'zh-CN' | undefined;
        let transcript;
        let artifact;
        if (request.type === 'application') {
            if (request.locale)
                db.prepare(
                    "INSERT INTO preferences VALUES ('locale', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                ).run(request.locale);
            const row = db.prepare("SELECT value FROM preferences WHERE key='locale'").get();
            locale = row ? z.object({ value: z.enum(['en', 'zh-CN']) }).parse(row).value : 'en';
            records = db
                .prepare('SELECT body FROM journal WHERE seq=1 ORDER BY rowid DESC')
                .all()
                .map(row =>
                    recordSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body))
                );
        }
        if (request.type === 'artifact.put') {
            const value = request.artifact;
            const bytes = Buffer.from(value.data, 'base64');
            if (bytes.length > 10000000 || bytes.toString('base64') !== value.data)
                throw new StoreError('invalid', 'Invalid artifact encoding.');
            const existing = db
                .prepare('SELECT name, media_type, bytes FROM artifacts WHERE id=?')
                .get(value.id);
            if (existing) {
                const row = z
                    .object({
                        name: z.string(),
                        media_type: z.string(),
                        bytes: z.instanceof(Buffer),
                    })
                    .parse(existing);
                if (
                    row.name !== value.name ||
                    row.media_type !== value.mediaType ||
                    !row.bytes.equals(bytes)
                )
                    throw new StoreError('conflict', 'Artifact identity conflict.');
            } else
                db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?)').run(
                    value.id,
                    value.name,
                    value.mediaType,
                    bytes
                );
        }
        if (request.type === 'artifact.get') {
            const row = z
                .object({
                    id: z.string(),
                    name: z.string(),
                    media_type: z.string(),
                    bytes: z.instanceof(Buffer),
                })
                .parse(db.prepare('SELECT * FROM artifacts WHERE id=?').get(request.artifactId));
            artifact = artifactSchema.parse({
                id: row.id,
                name: row.name,
                mediaType: row.media_type,
                data: row.bytes.toString('base64'),
            });
        }
        if (request.type === 'transcript') {
            const view = refreshView(request.sessionId);
            if (!view) throw new StoreError('not-found', 'Session not found.');
            const end = request.beforeId
                ? view.history.findIndex(entry => entry.id === request.beforeId)
                : view.history.length;
            if (end < 0) throw new StoreError('invalid', 'Invalid history cursor.');
            const start = Math.max(0, end - 30);
            const attempt = [...view.attempts.values()].at(-1);
            transcript = {
                sessionId: request.sessionId,
                head: view.head,
                card: view.epoch.card,
                ...(view.epoch.thinkingLevel ? { thinkingLevel: view.epoch.thinkingLevel } : {}),
                messages: view.history.slice(start, end),
                ...(start > 0 ? { beforeId: view.history[start].id } : {}),
                pending: [...view.inbox.values()]
                    .filter(item => !item.consumedBy)
                    .map(item => item.delivery.entry),
                ...(attempt?.outcome === 'running' && attempt.outputCount
                    ? {
                          draft: {
                              id: attempt.messageId,
                              role: 'assistant',
                              origin: 'assistant',
                              blocks: [
                                  ...(attempt.reasoning.length
                                      ? [{ type: 'reasoning', text: attempt.reasoning.join('') }]
                                      : []),
                                  { type: 'text', text: attempt.chunks.join('') },
                              ],
                          },
                      }
                    : {}),
                ...(attempt ? { outcome: attempt.outcome } : {}),
                usage: attempt?.usage ?? {},
                ...(view.failure ? { failure: view.failure } : {}),
            };
        }
        if (request.type === 'execute') records = execute.immediate(request.command);
        if (request.type === 'read') records = read(request.sessionId, request.afterSeq);
        if (request.type === 'close') db.close();
        port.postMessage({
            type: 'result',
            id: request.id,
            records,
            ...(locale ? { locale } : {}),
            ...(transcript ? { transcript } : {}),
            ...(artifact ? { artifact } : {}),
        });
        if (request.type === 'close') port.close();
    } catch (error) {
        port.postMessage({
            type: 'error',
            id: request.id,
            code: error instanceof StoreError ? error.code : 'invalid',
            message: error instanceof StoreError ? error.message : 'Database operation failed.',
        });
    }
});
port.postMessage({ type: 'ready' });
