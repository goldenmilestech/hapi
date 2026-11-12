import { getConfiguration } from '../configuration'
import type { Store } from '../store'
import {
    hashAccessToken,
    isAccessTokenActive,
    type AccessTokenRecord
} from '../store/accessTokens'
import { parseAccessToken } from './accessToken'
import { constantTimeEquals } from './crypto'

export type ResolvedAccess = {
    namespace: string
    /**
     * Null for the legacy shared token. JWTs issued from it carry no `tid`
     * claim, so they cannot be revoked before their normal expiry.
     */
    tokenId: string | null
    source: 'access-token' | 'legacy'
}

export type AccessTokenResolverDeps = {
    getByTokenHash: (tokenHash: string) => AccessTokenRecord | null
    touchLastUsed: (id: string, now: number) => void
    /**
     * The namespace's active token, if any. A namespace that has been claimed
     * by a token is closed to the legacy shared token, so guessing the
     * namespace name no longer grants access.
     */
    getActiveByNamespace: (namespace: string, now: number) => AccessTokenRecord | null
    /**
     * The legacy shared `CLI_API_TOKEN`, or null when the operator disabled
     * the legacy path with `HAPI_LEGACY_SHARED_TOKEN=off`.
     */
    legacyToken: string | null
}

/**
 * Resolves a bearer credential to a namespace.
 *
 * New tokens are opaque and matched by digest, so the namespace comes from the
 * hub's own record. Only when no row matches do we fall back to the legacy
 * `base[:namespace]` grammar — and only while the operator keeps that path on.
 */
export function resolveAccessToken(
    raw: string,
    deps: AccessTokenResolverDeps
): ResolvedAccess | null {
    const token = raw.trim()
    if (!token) {
        return null
    }

    const record = deps.getByTokenHash(hashAccessToken(token))
    if (record) {
        if (!isAccessTokenActive(record)) {
            return null
        }
        deps.touchLastUsed(record.id, Date.now())
        return { namespace: record.namespace, tokenId: record.id, source: 'access-token' }
    }

    if (deps.legacyToken) {
        const parsed = parseAccessToken(token)
        if (parsed && constantTimeEquals(parsed.baseToken, deps.legacyToken)) {
            // A namespace bound to a token is owned by it. The legacy suffix
            // must not be a back door into that namespace.
            if (deps.getActiveByNamespace(parsed.namespace, Date.now())) {
                return null
            }
            return { namespace: parsed.namespace, tokenId: null, source: 'legacy' }
        }
    }

    return null
}

export function resolveHubAccessToken(raw: string, store: Store): ResolvedAccess | null {
    const configuration = getConfiguration()
    return resolveAccessToken(raw, {
        getByTokenHash: (tokenHash) => store.accessTokens.getByTokenHash(tokenHash),
        touchLastUsed: (id, now) => store.accessTokens.touchLastUsed(id, now),
        getActiveByNamespace: (namespace, now) => store.accessTokens.getActiveByNamespace(namespace, now),
        legacyToken: configuration.legacySharedTokenEnabled ? configuration.cliApiToken : null
    })
}
