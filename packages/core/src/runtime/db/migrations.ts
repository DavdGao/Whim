/** Append-only schema migrations; index + 1 is the resulting `user_version`. Never edit a released entry. */
export const migrations: readonly string[] = [
    `
    CREATE TABLE journal (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        card_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        head INTEGER NOT NULL,
        running INTEGER NOT NULL,
        needs_recovery INTEGER NOT NULL
    );
    CREATE INDEX sessions_updated ON sessions (updated_at DESC);
    CREATE TABLE receipts (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        record_ids TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL,
        label TEXT NOT NULL,
        plain_values TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE secrets (
        credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
        property TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        PRIMARY KEY (credential_id, property)
    );
    CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        source TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL
    );
    `,
    `
    CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        at TEXT,
        cron TEXT,
        timezone TEXT,
        missed TEXT NOT NULL,
        paused INTEGER NOT NULL,
        next_fire TEXT,
        last_fire TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX schedules_session ON schedules (session_id);
    CREATE INDEX schedules_next_fire ON schedules (next_fire);
    `,
];
