import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { getOrCreateJsonFile } from './generators'

const accessTokenSecretFileSchema = z.object({
    secretBase64: z.string()
})

const ACCESS_TOKEN_DERIVATION_PREFIX = 'hapi-access-token-v1:'

/**
 * Access tokens are derived from the row id instead of being random so the
 * owner (or the user themselves) can copy the same token again later. Only the
 * token's SHA-256 digest is persisted, so a database leak alone still cannot
 * replay it.
 *
 * The `hapi_` prefix keeps the token opaque and lets it bypass the legacy
 * `base[:namespace]` grammar unambiguously.
 */
export function deriveAccessToken(secret: Uint8Array, tokenId: string): string {
    if (secret.length !== 32) {
        throw new Error(`Access token secret must be 32 bytes, got ${secret.length}`)
    }
    const digest = createHmac('sha256', secret)
        .update(`${ACCESS_TOKEN_DERIVATION_PREFIX}${tokenId}`, 'utf8')
        .digest('base64url')
    return `hapi_${digest}`
}

// Keyed by dataDir so parallel test files with different HAPI_HOME values do
// not share a secret. The in-flight promise is cached to keep concurrent
// first requests from racing getOrCreateJsonFile (which is check-then-write).
const secretCache = new Map<string, Promise<Uint8Array>>()

export async function getOrCreateAccessTokenSecret(dataDir: string): Promise<Uint8Array> {
    const cached = secretCache.get(dataDir)
    if (cached) {
        return cached
    }

    const secretFile = join(dataDir, 'access-token-secret.json')
    const promise = getOrCreateJsonFile({
        filePath: secretFile,
        readValue: (raw) => {
            const parsed = accessTokenSecretFileSchema.parse(JSON.parse(raw))
            const bytes = new Uint8Array(Buffer.from(parsed.secretBase64, 'base64'))
            if (bytes.length !== 32) {
                throw new Error(`Invalid access token secret length in ${secretFile}`)
            }
            return bytes
        },
        writeValue: (secretBytes) => {
            const payload = {
                secretBase64: Buffer.from(secretBytes).toString('base64')
            }
            return JSON.stringify(payload, null, 4)
        },
        generate: () => new Uint8Array(randomBytes(32)),
        fileMode: 0o600,
        dirMode: 0o700
    }).then((result) => result.value)

    secretCache.set(dataDir, promise)
    promise.catch(() => {
        if (secretCache.get(dataDir) === promise) {
            secretCache.delete(dataDir)
        }
    })
    return promise
}
