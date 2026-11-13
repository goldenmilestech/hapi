import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

const MAX_SIGNATURE_SKEW_MS = 5 * 60 * 1000

export type FeishuSignatureInput = {
    timestamp: string | null
    nonce: string | null
    signature: string | null
    encryptKey: string
    rawBody: string
    now?: number
    maxSkewMs?: number
}

/**
 * Feishu signs the raw webhook body as
 * `sha256(timestamp + nonce + encrypt_key + body)`.
 *
 * The timestamp check is part of the signature contract: replaying an old
 * signed body must not extend its lifetime.
 */
export function verifyFeishuSignature(input: FeishuSignatureInput): boolean {
    const { timestamp, nonce, signature } = input
    if (!timestamp || !nonce || !signature) {
        return false
    }

    const parsedTimestamp = Number(timestamp)
    if (!Number.isFinite(parsedTimestamp)) {
        return false
    }
    const now = input.now ?? Date.now()
    const maxSkewMs = input.maxSkewMs ?? MAX_SIGNATURE_SKEW_MS
    if (Math.abs(now - parsedTimestamp) > maxSkewMs) {
        return false
    }

    const expected = createHash('sha256')
        .update(timestamp + nonce + input.encryptKey + input.rawBody, 'utf8')
        .digest('hex')

    const expectedBuffer = Buffer.from(expected, 'utf8')
    const actualBuffer = Buffer.from(signature.toLowerCase(), 'utf8')
    if (expectedBuffer.length !== actualBuffer.length) {
        return false
    }
    return timingSafeEqual(expectedBuffer, actualBuffer)
}

/**
 * Feishu event bodies are AES-256-CBC encrypted with a key derived from the
 * app's encrypt key. The first 16 bytes of the base64 payload are the IV.
 */
export function decryptFeishuPayload(encryptKey: string, encrypted: string): string {
    const key = createHash('sha256').update(encryptKey, 'utf8').digest()
    const raw = Buffer.from(encrypted, 'base64')
    if (raw.length <= 16) {
        throw new Error('Invalid encrypted Feishu payload')
    }

    const iv = raw.subarray(0, 16)
    const ciphertext = raw.subarray(16)
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
