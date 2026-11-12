import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

export type FeishuEmailBinding = {
    id: string
    email: string
    namespace: string
    createdAt: number
}

type DbBindingRow = {
    id: string
    email: string
    namespace: string
    created_at: number
}

function toBinding(row: DbBindingRow): FeishuEmailBinding {
    return {
        id: row.id,
        email: row.email,
        namespace: row.namespace,
        createdAt: row.created_at
    }
}

export function normalizeFeishuEmail(email: string): string {
    return email.trim().toLowerCase()
}

/**
 * Pre-binds a Feishu email to an existing namespace. On the first Feishu login
 * with that email, the user row is created with this namespace instead of a
 * freshly allocated one, so their existing sessions remain visible.
 */
export class FeishuBindingStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
        this.ensureSchema()
    }

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS feishu_email_bindings (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                namespace TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_bindings_namespace
                ON feishu_email_bindings(namespace);
        `)
    }

    list(): FeishuEmailBinding[] {
        const rows = this.db.prepare(
            'SELECT * FROM feishu_email_bindings ORDER BY created_at DESC'
        ).all() as DbBindingRow[]
        return rows.map(toBinding)
    }

    getByEmail(email: string): FeishuEmailBinding | null {
        const normalized = normalizeFeishuEmail(email)
        if (!normalized) {
            return null
        }
        const row = this.db.prepare(
            'SELECT * FROM feishu_email_bindings WHERE email = ? LIMIT 1'
        ).get(normalized) as DbBindingRow | undefined
        return row ? toBinding(row) : null
    }

    /** Upsert so re-binding an email to another namespace is a single action. */
    upsert(input: { email: string; namespace: string }): FeishuEmailBinding {
        const email = normalizeFeishuEmail(input.email)
        const namespace = input.namespace.trim()
        if (!email) {
            throw new Error('Invalid Feishu binding email')
        }
        if (!namespace || namespace.length > 64 || namespace.includes(':')) {
            throw new Error('Invalid Feishu binding namespace')
        }

        this.db.prepare(`
            INSERT INTO feishu_email_bindings (id, email, namespace, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET namespace = excluded.namespace
        `).run(randomUUID(), email, namespace, Date.now())

        const row = this.db.prepare(
            'SELECT * FROM feishu_email_bindings WHERE email = ? LIMIT 1'
        ).get(email) as DbBindingRow | undefined
        if (!row) {
            throw new Error('Failed to save Feishu binding')
        }
        return toBinding(row)
    }

    remove(email: string): boolean {
        const normalized = normalizeFeishuEmail(email)
        if (!normalized) {
            return false
        }
        const result = this.db.prepare(
            'DELETE FROM feishu_email_bindings WHERE email = ?'
        ).run(normalized)
        return result.changes > 0
    }
}
