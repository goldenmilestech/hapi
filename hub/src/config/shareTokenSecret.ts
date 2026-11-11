import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { getOrCreateJsonFile } from './generators'

const shareTokenSecretFileSchema = z.object({
    secretBase64: z.string()
})

const SHARE_TOKEN_DERIVATION_PREFIX = 'hapi-session-share-v1:'

/**
 * Share tokens are derived from the share id instead of being random so the
 * owner can be shown the same link again after the creating dialog closes.
 * Only the token's SHA-256 digest is persisted, so a database leak alone still
 * cannot replay a link.
 */
export function deriveSessionShareToken(secret: Uint8Array, shareId: string): string {
    if (secret.length !== 32) {
        throw new Error(`Share token secret must be 32 bytes, got ${secret.length}`)
    }
    return createHmac('sha256', secret)
        .update(`${SHARE_TOKEN_DERIVATION_PREFIX}${shareId}`, 'utf8')
        .digest('base64url')
}

// Keyed by dataDir so parallel test files with different HAPI_HOME values do
// not share a secret. The in-flight promise is cached to keep concurrent
// first requests from racing getOrCreateJsonFile (which is check-then-write).
const secretCache = new Map<string, Promise<Uint8Array>>()

export async function getOrCreateShareTokenSecret(dataDir: string): Promise<Uint8Array> {
    const cached = secretCache.get(dataDir)
    if (cached) {
        return cached
    }

    const secretFile = join(dataDir, 'share-token-secret.json')
    const promise = getOrCreateJsonFile({
        filePath: secretFile,
        readValue: (raw) => {
            const parsed = shareTokenSecretFileSchema.parse(JSON.parse(raw))
            const bytes = new Uint8Array(Buffer.from(parsed.secretBase64, 'base64'))
            if (bytes.length !== 32) {
                throw new Error(`Invalid share token secret length in ${secretFile}`)
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
