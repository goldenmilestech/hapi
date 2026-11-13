import type { Database } from 'bun:sqlite'
import { randomInt, randomUUID } from 'node:crypto'

export type FeishuBotBinding = {
    id: string
    chatId: string
    chatType: string
    chatName: string | null
    namespace: string
    sessionId: string
    sessionTitle: string
    createdAt: number
}

export type FeishuBotBindCode = {
    namespace: string
    sessionId: string
}

type DbBindingRow = {
    id: string
    chat_id: string
    chat_type: string
    chat_name: string | null
    namespace: string
    session_id: string
    session_title: string
    created_at: number
}

type DbBindCodeRow = {
    code: string
    namespace: string
    session_id: string
    created_at: number
    expires_at: number
    used_at: number | null
}

const BIND_CODE_TTL_MS = 10 * 60 * 1000
const BIND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const BIND_CODE_LENGTH = 6
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function toBinding(row: DbBindingRow): FeishuBotBinding {
    return {
        id: row.id,
        chatId: row.chat_id,
        chatType: row.chat_type,
        chatName: row.chat_name,
        namespace: row.namespace,
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        createdAt: row.created_at
    }
}

function normalizeNamespace(namespace: string): string {
    const trimmed = namespace.trim()
    if (!trimmed || trimmed.length > 64 || trimmed.includes(':')) {
        throw new Error('Invalid Feishu bot binding namespace')
    }
    return trimmed
}

function normalizeChatId(chatId: string): string {
    const trimmed = chatId.trim()
    if (!trimmed || trimmed.length > 128) {
        throw new Error('Invalid Feishu chat id')
    }
    return trimmed
}

function normalizeSessionId(sessionId: string): string {
    const trimmed = sessionId.trim()
    if (!trimmed || trimmed.length > 128) {
        throw new Error('Invalid Feishu bot binding session id')
    }
    return trimmed
}

function normalizeTitle(title: string): string {
    return title.trim().slice(0, 512)
}

function makeBindCode(): string {
    let code = ''
    for (let i = 0; i < BIND_CODE_LENGTH; i += 1) {
        code += BIND_CODE_ALPHABET[randomInt(BIND_CODE_ALPHABET.length)]
    }
    return code
}

/**
 * Feishu bot → HAPI session bindings.
 *
 * A Feishu chat is the authorization boundary: once a chat is bound, every
 * member of that chat can drive the session. Binding is deliberately 1:1
 * (`chat_id` and `session_id` are both UNIQUE) so two conversations can never
 * interleave their output into one chat by accident.
 */
export class FeishuBotBindingStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
        this.ensureSchema()
    }

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS feishu_bot_bindings (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL UNIQUE,
                chat_type TEXT NOT NULL,
                chat_name TEXT,
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL UNIQUE,
                session_title TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_bot_bindings_namespace
                ON feishu_bot_bindings(namespace);

            CREATE TABLE IF NOT EXISTS feishu_bot_bind_codes (
                code TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_bot_bind_codes_session
                ON feishu_bot_bind_codes(session_id);

            CREATE TABLE IF NOT EXISTS feishu_bot_events (
                event_id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
        `)
    }

    listByNamespace(namespace: string): FeishuBotBinding[] {
        const rows = this.db.prepare(`
            SELECT * FROM feishu_bot_bindings
            WHERE namespace = ?
            ORDER BY created_at DESC
        `).all(normalizeNamespace(namespace)) as DbBindingRow[]
        return rows.map(toBinding)
    }

    getByChatId(chatId: string): FeishuBotBinding | null {
        const normalized = normalizeChatId(chatId)
        const row = this.db.prepare(
            'SELECT * FROM feishu_bot_bindings WHERE chat_id = ? LIMIT 1'
        ).get(normalized) as DbBindingRow | undefined
        return row ? toBinding(row) : null
    }

    getBySessionId(sessionId: string): FeishuBotBinding | null {
        const normalized = normalizeSessionId(sessionId)
        const row = this.db.prepare(
            'SELECT * FROM feishu_bot_bindings WHERE session_id = ? LIMIT 1'
        ).get(normalized) as DbBindingRow | undefined
        return row ? toBinding(row) : null
    }

    getSessionIdsByNamespace(namespace: string): Set<string> {
        const rows = this.db.prepare(
            'SELECT session_id FROM feishu_bot_bindings WHERE namespace = ?'
        ).all(normalizeNamespace(namespace)) as Array<{ session_id: string }>
        return new Set(rows.map((row) => row.session_id))
    }

    /**
     * Bind a chat to a session. Either side already being bound moves it:
     * unbinding the old pair is the only way to keep one chat per session
     * without a second, stale binding.
     */
    bind(input: {
        chatId: string
        chatType: string
        chatName: string | null
        namespace: string
        sessionId: string
        sessionTitle: string
    }): FeishuBotBinding {
        const chatId = normalizeChatId(input.chatId)
        const chatType = input.chatType.trim().slice(0, 32) || 'unknown'
        const chatName = input.chatName?.trim().slice(0, 256) || null
        const namespace = normalizeNamespace(input.namespace)
        const sessionId = normalizeSessionId(input.sessionId)
        const sessionTitle = normalizeTitle(input.sessionTitle) || sessionId.slice(0, 8)
        const now = Date.now()

        return this.db.transaction(() => {
            this.db.prepare(
                'DELETE FROM feishu_bot_bindings WHERE chat_id = ? OR session_id = ?'
            ).run(chatId, sessionId)

            this.db.prepare(`
                INSERT INTO feishu_bot_bindings (
                    id, chat_id, chat_type, chat_name, namespace,
                    session_id, session_title, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                randomUUID(),
                chatId,
                chatType,
                chatName,
                namespace,
                sessionId,
                sessionTitle,
                now
            )

            const row = this.db.prepare(
                'SELECT * FROM feishu_bot_bindings WHERE chat_id = ? LIMIT 1'
            ).get(chatId) as DbBindingRow | undefined
            if (!row) {
                throw new Error('Failed to save Feishu bot binding')
            }
            return toBinding(row)
        })()
    }

    removeById(id: string, namespace: string): boolean {
        const result = this.db.prepare(
            'DELETE FROM feishu_bot_bindings WHERE id = ? AND namespace = ?'
        ).run(id, normalizeNamespace(namespace))
        return result.changes > 0
    }

    removeByChatId(chatId: string): boolean {
        const result = this.db.prepare(
            'DELETE FROM feishu_bot_bindings WHERE chat_id = ?'
        ).run(normalizeChatId(chatId))
        return result.changes > 0
    }

    /**
     * Create a short-lived, single-use code. Any earlier unused code for the
     * same session is invalidated so the settings page only ever shows one
     * live code.
     */
    createBindCode(input: { namespace: string; sessionId: string }, now = Date.now()): {
        code: string
        expiresAt: number
    } {
        const namespace = normalizeNamespace(input.namespace)
        const sessionId = normalizeSessionId(input.sessionId)
        const expiresAt = now + BIND_CODE_TTL_MS

        return this.db.transaction(() => {
            this.db.prepare(
                'DELETE FROM feishu_bot_bind_codes WHERE session_id = ? AND used_at IS NULL'
            ).run(sessionId)
            this.db.prepare(
                'DELETE FROM feishu_bot_bind_codes WHERE expires_at <= ?'
            ).run(now)

            // Collision probability is tiny, but the primary key makes a retry
            // cheap and deterministic.
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const code = makeBindCode()
                try {
                    this.db.prepare(`
                        INSERT INTO feishu_bot_bind_codes (
                            code, namespace, session_id, created_at, expires_at, used_at
                        ) VALUES (?, ?, ?, ?, ?, NULL)
                    `).run(code, namespace, sessionId, now, expiresAt)
                    return { code, expiresAt }
                } catch {
                    // Collision with a live code; try another.
                }
            }
            throw new Error('Failed to allocate Feishu bot bind code')
        })()
    }

    /** Consume a code exactly once, even if Feishu retries the same event. */
    consumeBindCode(code: string, now = Date.now()): FeishuBotBindCode | null {
        const normalized = code.trim().toUpperCase()
        if (!normalized || normalized.length > 32) {
            return null
        }

        return this.db.transaction(() => {
            const row = this.db.prepare(`
                SELECT * FROM feishu_bot_bind_codes
                WHERE code = ? AND used_at IS NULL AND expires_at > ?
                LIMIT 1
            `).get(normalized, now) as DbBindCodeRow | undefined
            if (!row) {
                return null
            }
            const update = this.db.prepare(
                'UPDATE feishu_bot_bind_codes SET used_at = ? WHERE code = ? AND used_at IS NULL'
            ).run(now, normalized)
            if (update.changes === 0) {
                return null
            }
            return { namespace: row.namespace, sessionId: row.session_id }
        })()
    }

    hasEvent(eventId: string): boolean {
        const normalized = eventId.trim()
        if (!normalized) {
            return true
        }
        const row = this.db.prepare(
            'SELECT 1 AS present FROM feishu_bot_events WHERE event_id = ? LIMIT 1'
        ).get(normalized) as { present: number } | null
        return row !== null
    }

    /** Record after successful handling so a failed delivery can be retried. */
    recordEvent(eventId: string, now = Date.now()): void {
        const normalized = eventId.trim()
        if (!normalized) {
            return
        }
        this.db.transaction(() => {
            this.db.prepare(
                'INSERT OR IGNORE INTO feishu_bot_events (event_id, created_at) VALUES (?, ?)'
            ).run(normalized, now)
            this.db.prepare(
                'DELETE FROM feishu_bot_events WHERE created_at < ?'
            ).run(now - EVENT_RETENTION_MS)
        })()
    }
}
