import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AccessTokenSummary } from '@hapi/protocol/apiTypes'

/**
 * Access tokens are long-lived bearer credentials. Unlike the legacy shared
 * `CLI_API_TOKEN` plus `:namespace` suffix, a token is bound to its namespace
 * server-side, so a client cannot switch namespaces by editing the credential.
 *
 * A namespace can have at most one *active* token. That makes the namespace an
 * owned resource: binding it cuts the legacy shared token off from that
 * namespace, so nobody else can enter it by guessing the name.
 *
 * Only the SHA-256 digest is persisted; the plaintext exists in the hub's
 * response to the creation request and nowhere else.
 */
export const ACCESS_TOKEN_PREFIX = 'hapi_'

const TOKEN_PREFIX_LENGTH = 12
const LAST_USED_THROTTLE_MS = 60_000
const MAX_NAME_LENGTH = 64
const MAX_NAMESPACE_LENGTH = 64

type DbAccessTokenRow = {
    id: string
    name: string
    namespace: string
    token_hash: string
    token_prefix: string
    created_at: number
    last_used_at: number | null
    expires_at: number | null
    revoked_at: number | null
}

export type AccessTokenRecord = {
    id: string
    name: string
    namespace: string
    tokenHash: string
    tokenPrefix: string
    createdAt: number
    lastUsedAt: number | null
    expiresAt: number | null
    revokedAt: number | null
}

export function hashAccessToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateAccessToken(): string {
    return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isAccessTokenActive(record: AccessTokenRecord, now = Date.now()): boolean {
    if (record.revokedAt !== null) {
        return false
    }
    return record.expiresAt === null || record.expiresAt > now
}

/**
 * A namespace may have at most one active token. Revoke the existing token
 * first to free the namespace (for example, when a device is replaced).
 */
export class NamespaceAlreadyBoundError extends Error {
    constructor(public readonly namespace: string) {
        super(`Namespace already bound: ${namespace}`)
        this.name = 'NamespaceAlreadyBoundError'
    }
}

function toRecord(row: DbAccessTokenRow): AccessTokenRecord {
    return {
        id: row.id,
        name: row.name,
        namespace: row.namespace,
        tokenHash: row.token_hash,
        tokenPrefix: row.token_prefix,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
    }
}

export function toAccessTokenSummary(record: AccessTokenRecord): AccessTokenSummary {
    return {
        id: record.id,
        name: record.name,
        namespace: record.namespace,
        tokenPrefix: record.tokenPrefix,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt
    }
}

export class AccessTokenStore {
    private readonly db: Database
    /** Token lookups happen on every CLI REST call, so both maps stay in memory. */
    private readonly byHash = new Map<string, AccessTokenRecord>()
    private readonly byId = new Map<string, AccessTokenRecord>()
    private readonly revokeListeners = new Set<(tokenId: string) => void>()

    constructor(db: Database) {
        this.db = db
        this.ensureSchema()
        this.reload()
    }

    /**
     * Additive table, same convention as `session_shares`: created on every
     * boot so existing databases do not need a schema-version bump.
     */
    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS access_tokens (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                namespace TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                token_prefix TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER,
                expires_at INTEGER,
                revoked_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_access_tokens_namespace
                ON access_tokens(namespace);
        `)
    }

    private reload(): void {
        const rows = this.db.prepare('SELECT * FROM access_tokens').all() as DbAccessTokenRow[]
        this.byHash.clear()
        this.byId.clear()
        for (const row of rows) {
            const record = toRecord(row)
            this.byHash.set(record.tokenHash, record)
            this.byId.set(record.id, record)
        }
    }

    getByTokenHash(tokenHash: string): AccessTokenRecord | null {
        return this.byHash.get(tokenHash) ?? null
    }

    getById(id: string): AccessTokenRecord | null {
        return this.byId.get(id) ?? null
    }

    /** The namespace's active token, if any. Expired tokens do not count. */
    getActiveByNamespace(namespace: string, now = Date.now()): AccessTokenRecord | null {
        for (const record of this.byId.values()) {
            if (record.namespace === namespace && isAccessTokenActive(record, now)) {
                return record
            }
        }
        return null
    }

    list(): AccessTokenSummary[] {
        return [...this.byId.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(toAccessTokenSummary)
    }

    create(input: {
        name: string
        namespace: string
        expiresAt?: number | null
        /**
         * Callers that derive the token from the row id pass a factory so the
         * hub can derive the same plaintext again later. Without one the token
         * is random and can only be shown once.
         */
        tokenFactory?: (id: string) => string
    }): { token: string; record: AccessTokenRecord } {
        const name = input.name.trim()
        const namespace = input.namespace.trim()
        if (!name || name.length > MAX_NAME_LENGTH) {
            throw new Error('Invalid access token name')
        }
        if (!namespace || namespace.length > MAX_NAMESPACE_LENGTH || namespace.includes(':')) {
            throw new Error('Invalid access token namespace')
        }
        // One active token per namespace is an application-level invariant:
        // expiry is time-based, so a SQLite partial unique index could not
        // express it. The hub is single-process and this write is synchronous,
        // so there is no interleaving window.
        if (this.getActiveByNamespace(namespace)) {
            throw new NamespaceAlreadyBoundError(namespace)
        }

        const id = randomUUID()
        const token = input.tokenFactory ? input.tokenFactory(id) : generateAccessToken()
        const record: AccessTokenRecord = {
            id,
            name,
            namespace,
            tokenHash: hashAccessToken(token),
            tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
            createdAt: Date.now(),
            lastUsedAt: null,
            expiresAt: input.expiresAt ?? null,
            revokedAt: null
        }

        this.db.prepare(`
            INSERT INTO access_tokens (
                id, name, namespace, token_hash, token_prefix,
                created_at, last_used_at, expires_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
        `).run(
            record.id,
            record.name,
            record.namespace,
            record.tokenHash,
            record.tokenPrefix,
            record.createdAt,
            record.expiresAt
        )

        this.byHash.set(record.tokenHash, record)
        this.byId.set(record.id, record)
        return { token, record }
    }

    revoke(id: string): boolean {
        const record = this.byId.get(id)
        if (!record) {
            return false
        }
        if (record.revokedAt !== null) {
            return true
        }

        const now = Date.now()
        const result = this.db.prepare(
            'UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
        ).run(now, id)
        if (result.changes === 0) {
            return false
        }

        record.revokedAt = now
        for (const listener of this.revokeListeners) {
            listener(id)
        }
        return true
    }

    /**
     * Fail closed: a JWT whose token row disappeared is treated as revoked.
     */
    isTokenIdRevoked(id: string): boolean {
        const record = this.byId.get(id)
        return !record || record.revokedAt !== null
    }

    touchLastUsed(id: string, now: number): void {
        const record = this.byId.get(id)
        if (!record) {
            return
        }
        if (record.lastUsedAt !== null && now - record.lastUsedAt < LAST_USED_THROTTLE_MS) {
            return
        }
        record.lastUsedAt = now
        this.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(now, id)
    }

    /**
     * Fires after a token is revoked so live CLI sockets and SSE streams can be
     * dropped immediately instead of waiting for the JWT to expire.
     */
    onRevoke(listener: (tokenId: string) => void): () => void {
        this.revokeListeners.add(listener)
        return () => {
            this.revokeListeners.delete(listener)
        }
    }
}
