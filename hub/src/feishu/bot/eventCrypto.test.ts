import { describe, expect, it } from 'bun:test'
import { createCipheriv, createHash } from 'node:crypto'
import { decryptFeishuPayload, verifyFeishuSignature } from './eventCrypto'

const ENCRYPT_KEY = 'test-encrypt-key'

function encrypt(plaintext: string): string {
    const key = createHash('sha256').update(ENCRYPT_KEY, 'utf8').digest()
    const iv = Buffer.from('0123456789abcdef', 'utf8')
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
}

function sign(timestamp: string, nonce: string, body: string): string {
    return createHash('sha256')
        .update(timestamp + nonce + ENCRYPT_KEY + body, 'utf8')
        .digest('hex')
}

describe('Feishu event crypto', () => {
    it('decrypts an AES-256-CBC payload with the derived key and IV', () => {
        const payload = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
        expect(decryptFeishuPayload(ENCRYPT_KEY, encrypt(payload))).toBe(payload)
    })

    it('accepts a fresh, correctly signed body', () => {
        const body = '{"encrypt":"..."}'
        const timestamp = '1700000000000'
        expect(verifyFeishuSignature({
            timestamp,
            nonce: 'nonce-1',
            signature: sign(timestamp, 'nonce-1', body),
            encryptKey: ENCRYPT_KEY,
            rawBody: body,
            now: Number(timestamp) + 1_000
        })).toBe(true)
    })

    it('rejects a wrong signature, a stale timestamp, and missing headers', () => {
        const body = '{"encrypt":"..."}'
        const timestamp = '1700000000000'
        expect(verifyFeishuSignature({
            timestamp,
            nonce: 'nonce-1',
            signature: sign(timestamp, 'nonce-1', `${body}x`),
            encryptKey: ENCRYPT_KEY,
            rawBody: body,
            now: Number(timestamp)
        })).toBe(false)

        expect(verifyFeishuSignature({
            timestamp,
            nonce: 'nonce-1',
            signature: sign(timestamp, 'nonce-1', body),
            encryptKey: ENCRYPT_KEY,
            rawBody: body,
            now: Number(timestamp) + 10 * 60 * 1000
        })).toBe(false)

        expect(verifyFeishuSignature({
            timestamp: null,
            nonce: 'nonce-1',
            signature: sign(timestamp, 'nonce-1', body),
            encryptKey: ENCRYPT_KEY,
            rawBody: body
        })).toBe(false)
    })
})
