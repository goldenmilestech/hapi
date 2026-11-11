import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'

export type SessionShareMode = 'chat' | 'chat_approve'

export type SessionShareRecord = {
    id: string
    sessionId: string
    namespace: string
    tokenHash: string
    mode: SessionShareMode
    createdAt: number
    expiresAt: number | null
    revokedAt: number | null
}

type DbSessionShareRow = {
    id: string
    session_id: string
    namespace: string
    token_hash: string
    mode: string
    created_at: number
    expires_at: number | null
    revoked_at: number | null
}

function toRecord(row: DbSessionShareRow): SessionShareRecord {
    return {
        id: row.id,
        sessionId: row.session_id,
        namespace: row.namespace,
        tokenHash: row.token_hash,
        mode: row.mode === 'chat_approve' ? 'chat_approve' : 'chat',
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
    }
}

/**
 * Share tokens are bearer credentials. Only their SHA-256 digest is persisted
 * so a database leak cannot be replayed against the hub.
 */
export function hashShareToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class SessionShareStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    /**
     * Idempotent so existing hub databases do not need a schema-version bump:
     * the share table is additive and every path creates it if missing.
     */
    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_shares (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                namespace TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                mode TEXT NOT NULL DEFAULT 'chat',
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                revoked_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_session_shares_session
                ON session_shares(session_id, namespace);
        `)
    }

    create(input: {
        /** Callers that derive the token pass the id they derived it from. */
        id?: string
        sessionId: string
        namespace: string
        tokenHash: string
        mode: SessionShareMode
        expiresAt: number | null
    }): SessionShareRecord {
        const id = input.id ?? randomUUID()
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO session_shares (
                id, session_id, namespace, token_hash, mode, created_at, expires_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
            id,
            input.sessionId,
            input.namespace,
            input.tokenHash,
            input.mode,
            now,
            input.expiresAt
        )
        const row = this.db.prepare(
            'SELECT * FROM session_shares WHERE id = ?'
        ).get(id) as DbSessionShareRow | undefined
        if (!row) {
            throw new Error('Failed to create session share')
        }
        return toRecord(row)
    }

    getByTokenHash(tokenHash: string): SessionShareRecord | null {
        const row = this.db.prepare(
            'SELECT * FROM session_shares WHERE token_hash = ? LIMIT 1'
        ).get(tokenHash) as DbSessionShareRow | undefined
        return row ? toRecord(row) : null
    }

    getById(id: string, sessionId: string, namespace: string): SessionShareRecord | null {
        const row = this.db.prepare(`
            SELECT * FROM session_shares
            WHERE id = ? AND session_id = ? AND namespace = ?
            LIMIT 1
        `).get(id, sessionId, namespace) as DbSessionShareRow | undefined
        return row ? toRecord(row) : null
    }

    /**
     * Extending an expiry is allowed for expired shares (that is the point of
     * renewal) but never for revoked ones, and only within the owning session
     * and namespace.
     */
    updateExpiresAt(
        id: string,
        sessionId: string,
        namespace: string,
        expiresAt: number
    ): SessionShareRecord | null {
        const result = this.db.prepare(`
            UPDATE session_shares SET expires_at = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(expiresAt, id, sessionId, namespace)
        return result.changes > 0 ? this.getById(id, sessionId, namespace) : null
    }

    /**
     * Replaces the token hash of an active share. Used to make a share created
     * before tokens were derivable retrievable again; the previous token stops
     * working immediately.
     */
    updateTokenHash(
        id: string,
        sessionId: string,
        namespace: string,
        tokenHash: string
    ): SessionShareRecord | null {
        const result = this.db.prepare(`
            UPDATE session_shares SET token_hash = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(tokenHash, id, sessionId, namespace)
        return result.changes > 0 ? this.getById(id, sessionId, namespace) : null
    }

    listBySession(sessionId: string, namespace: string): SessionShareRecord[] {
        const rows = this.db.prepare(
            'SELECT * FROM session_shares WHERE session_id = ? AND namespace = ? ORDER BY created_at DESC'
        ).all(sessionId, namespace) as DbSessionShareRow[]
        return rows.map(toRecord)
    }

    revoke(id: string, sessionId: string, namespace: string): boolean {
        const result = this.db.prepare(`
            UPDATE session_shares SET revoked_at = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(Date.now(), id, sessionId, namespace)
        return result.changes > 0
    }
}

export function isShareActive(share: SessionShareRecord, now: number = Date.now()): boolean {
    if (share.revokedAt !== null) {
        return false
    }
    return share.expiresAt === null || share.expiresAt > now
}
