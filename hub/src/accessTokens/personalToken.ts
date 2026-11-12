import { deriveAccessToken, getOrCreateAccessTokenSecret } from '../config/accessTokenSecret'
import type { Store } from '../store'
import { hashAccessToken, type AccessTokenRecord } from '../store/accessTokens'

export type PersonalAccessTokenView = {
    /** Null when the row predates derived tokens and cannot be shown again. */
    token: string | null
    record: AccessTokenRecord
}

function deriveForExisting(record: AccessTokenRecord, secret: Uint8Array): string | null {
    const candidate = deriveAccessToken(secret, record.id)
    // A token created before derivation was introduced is random; deriving a
    // value for its id will not match the stored digest.
    return record.tokenHash === hashAccessToken(candidate) ? candidate : null
}

/** The namespace's active token, re-derived when possible. */
export async function readPersonalAccessToken(
    store: Store,
    dataDir: string,
    namespace: string
): Promise<PersonalAccessTokenView | null> {
    const record = store.accessTokens.getActiveByNamespace(namespace)
    if (!record) {
        return null
    }
    const secret = await getOrCreateAccessTokenSecret(dataDir)
    return { token: deriveForExisting(record, secret), record }
}

/**
 * Returns the namespace's active token, creating one if needed. A legacy
 * non-derivable token is rotated: the first Feishu login for that namespace
 * replaces it with a durable, re-viewable token.
 */
export async function ensurePersonalAccessToken(
    store: Store,
    dataDir: string,
    namespace: string,
    name: string
): Promise<{ token: string; record: AccessTokenRecord }> {
    const existing = await readPersonalAccessToken(store, dataDir, namespace)
    if (existing?.token) {
        return { token: existing.token, record: existing.record }
    }
    if (existing) {
        store.accessTokens.revoke(existing.record.id)
    }

    const secret = await getOrCreateAccessTokenSecret(dataDir)
    const created = store.accessTokens.create({
        name,
        namespace,
        tokenFactory: (id) => deriveAccessToken(secret, id)
    })
    return created
}

/** Replaces the namespace's active token with a fresh one. */
export async function regeneratePersonalAccessToken(
    store: Store,
    dataDir: string,
    namespace: string,
    name: string
): Promise<{ token: string; record: AccessTokenRecord }> {
    const existing = store.accessTokens.getActiveByNamespace(namespace)
    if (existing) {
        store.accessTokens.revoke(existing.id)
    }

    const secret = await getOrCreateAccessTokenSecret(dataDir)
    return store.accessTokens.create({
        name,
        namespace,
        tokenFactory: (id) => deriveAccessToken(secret, id)
    })
}
