import type { Database } from 'bun:sqlite'

export type FeishuProfile = {
    openId: string
    namespace: string | null
    name: string
    email: string | null
    enterpriseEmail: string | null
    avatarUrl: string | null
    updatedAt: number
}

type DbProfileRow = {
    open_id: string
    namespace: string | null
    name: string
    email: string | null
    enterprise_email: string | null
    avatar_url: string | null
    updated_at: number
}

function toProfile(row: DbProfileRow): FeishuProfile {
    return {
        openId: row.open_id,
        namespace: row.namespace,
        name: row.name,
        email: row.email,
        enterpriseEmail: row.enterprise_email,
        avatarUrl: row.avatar_url,
        updatedAt: row.updated_at
    }
}

function normalizeOpenId(openId: string): string {
    const trimmed = openId.trim()
    if (!trimmed || trimmed.length > 128) {
        throw new Error('Invalid Feishu open_id')
    }
    return trimmed
}

function normalizeName(name: string): string {
    return name.trim().slice(0, 256)
}

function normalizeEmail(email: string | null | undefined): string | null {
    const trimmed = email?.trim().toLowerCase()
    return trimmed ? trimmed : null
}

/**
 * Display-name and email cache for Feishu users the hub has already seen.
 *
 * `users` maps a Feishu open_id to a namespace; this table adds the profile
 * fields needed to address people by name and to render a sender label. Rows
 * are written on Feishu login and whenever the bot resolves a user through
 * the contact API.
 */
export class FeishuProfileStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
        this.ensureSchema()
    }

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS feishu_profiles (
                open_id TEXT PRIMARY KEY,
                namespace TEXT,
                name TEXT NOT NULL,
                email TEXT,
                enterprise_email TEXT,
                avatar_url TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_profiles_name
                ON feishu_profiles(name);
            CREATE INDEX IF NOT EXISTS idx_feishu_profiles_email
                ON feishu_profiles(email);
        `)
    }

    get(openId: string): FeishuProfile | null {
        const normalized = normalizeOpenId(openId)
        const row = this.db.prepare(
            'SELECT * FROM feishu_profiles WHERE open_id = ? LIMIT 1'
        ).get(normalized) as DbProfileRow | undefined
        return row ? toProfile(row) : null
    }

    /** Exact, case-insensitive display-name match; callers handle ambiguity. */
    findByName(name: string): FeishuProfile[] {
        const normalized = normalizeName(name).toLowerCase()
        if (!normalized) {
            return []
        }
        const rows = this.db.prepare(
            'SELECT * FROM feishu_profiles WHERE lower(name) = ? ORDER BY updated_at DESC'
        ).all(normalized) as DbProfileRow[]
        return rows.map(toProfile)
    }

    list(): FeishuProfile[] {
        const rows = this.db.prepare(
            'SELECT * FROM feishu_profiles ORDER BY updated_at DESC'
        ).all() as DbProfileRow[]
        return rows.map(toProfile)
    }

    upsert(input: {
        openId: string
        namespace?: string | null
        name: string
        email?: string | null
        enterpriseEmail?: string | null
        avatarUrl?: string | null
    }): FeishuProfile {
        const openId = normalizeOpenId(input.openId)
        const name = normalizeName(input.name) || openId
        const namespace = input.namespace?.trim() || null
        const email = normalizeEmail(input.email)
        const enterpriseEmail = normalizeEmail(input.enterpriseEmail)
        const avatarUrl = input.avatarUrl?.trim() || null

        // Keep a previously known namespace/email when a later resolver only
        // has the name: COALESCE avoids erasing useful profile fields.
        this.db.prepare(`
            INSERT INTO feishu_profiles (
                open_id, namespace, name, email, enterprise_email, avatar_url, updated_at
            ) VALUES (
                @open_id, @namespace, @name, @email, @enterprise_email, @avatar_url, @updated_at
            )
            ON CONFLICT(open_id) DO UPDATE SET
                namespace = COALESCE(excluded.namespace, feishu_profiles.namespace),
                name = excluded.name,
                email = COALESCE(excluded.email, feishu_profiles.email),
                enterprise_email = COALESCE(excluded.enterprise_email, feishu_profiles.enterprise_email),
                avatar_url = COALESCE(excluded.avatar_url, feishu_profiles.avatar_url),
                updated_at = excluded.updated_at
        `).run({
            open_id: openId,
            namespace,
            name,
            email,
            enterprise_email: enterpriseEmail,
            avatar_url: avatarUrl,
            updated_at: Date.now()
        })

        const stored = this.get(openId)
        if (!stored) {
            throw new Error('Failed to save Feishu profile')
        }
        return stored
    }
}
