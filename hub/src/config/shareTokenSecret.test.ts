import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    deriveSessionShareToken,
    getOrCreateShareTokenSecret
} from './shareTokenSecret'

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-share-secret-'))
}

describe('share token secret', () => {
    it('creates one stable 32-byte secret per data directory', async () => {
        const dir = tempDir()
        const first = await getOrCreateShareTokenSecret(dir)
        const second = await getOrCreateShareTokenSecret(dir)

        expect(first.length).toBe(32)
        expect(second).toEqual(first)
        expect(statSync(join(dir, 'share-token-secret.json')).mode & 0o777).toBe(0o600)
    })

    it('uses a different secret for a different data directory', async () => {
        const first = await getOrCreateShareTokenSecret(tempDir())
        const second = await getOrCreateShareTokenSecret(tempDir())
        expect(second).not.toEqual(first)
    })

    it('rejects a corrupted secret file instead of silently replacing it', async () => {
        const dir = tempDir()
        writeFileSync(join(dir, 'share-token-secret.json'), JSON.stringify({ secretBase64: 'abc' }))

        await expect(getOrCreateShareTokenSecret(dir)).rejects.toThrow('Invalid share token secret length')
        expect(JSON.parse(readFileSync(join(dir, 'share-token-secret.json'), 'utf8'))).toEqual({
            secretBase64: 'abc'
        })
    })

    it('derives a deterministic token per share id', () => {
        const secret = new Uint8Array(32).fill(3)
        const token = deriveSessionShareToken(secret, 'share-1')

        expect(token).toBe(deriveSessionShareToken(secret, 'share-1'))
        expect(token).not.toBe(deriveSessionShareToken(secret, 'share-2'))
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('rejects secrets that are not 32 bytes', () => {
        expect(() => deriveSessionShareToken(new Uint8Array(16), 'share-1')).toThrow('32 bytes')
    })
})
