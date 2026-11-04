import { createHash, randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { decide, StoreError } from './commands.js';
import { requestSchema } from './protocol.js';
import { recordSchema } from './records.js';
import { foldRecords } from './view.js';

import type { AgentRecord, Command } from './records.js';

const port = parentPort;
if (!port) throw new Error('The database must run in a dedicated worker.');
const { path } = z.strictObject({ path: z.string().min(1) }).parse(workerData);
const db = new Database(path);
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
const version = db.pragma('user_version', { simple: true });
if (version !== 0 && version !== 1) {
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
 * @returns Validated journal records.
 */
function read(sessionId: string): AgentRecord[] {
    return db
        .prepare('SELECT body FROM journal WHERE session_id = ? ORDER BY seq')
        .all(sessionId)
        .map(row => recordSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)));
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
    const history = read(command.sessionId);
    const view = history.length ? foldRecords(history) : null;
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
        if (request.type === 'execute') records = execute.immediate(request.command);
        if (request.type === 'read') records = read(request.sessionId);
        if (request.type === 'close') db.close();
        port.postMessage({ type: 'result', id: request.id, records });
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
