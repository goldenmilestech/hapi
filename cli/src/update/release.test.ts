import { describe, expect, it } from 'vitest'
import { parseChecksums, resolveUpdateTarget, selectLatestCliRelease } from './release'

describe('resolveUpdateTarget', () => {
    it('maps darwin arm64', () => {
        expect(resolveUpdateTarget('darwin', 'arm64')).toMatchObject({
            asset: 'hapi-darwin-arm64.tar.gz',
            archiveKind: 'tar.gz',
            binaryName: 'hapi'
        })
    })

    it('maps darwin x64', () => {
        expect(resolveUpdateTarget('darwin', 'x64').asset).toBe('hapi-darwin-x64.tar.gz')
    })

    it('maps linux x64 to the baseline asset', () => {
        expect(resolveUpdateTarget('linux', 'x64')).toMatchObject({
            asset: 'hapi-linux-x64-baseline.tar.gz',
            archiveKind: 'tar.gz',
            binaryName: 'hapi'
        })
    })

    it('maps linux arm64', () => {
        expect(resolveUpdateTarget('linux', 'arm64').asset).toBe('hapi-linux-arm64.tar.gz')
    })

    it('maps windows x64 to the zip asset', () => {
        expect(resolveUpdateTarget('win32', 'x64')).toMatchObject({
            asset: 'hapi-win32-x64.zip',
            archiveKind: 'zip',
            binaryName: 'hapi.exe'
        })
    })

    it('rejects unsupported platforms', () => {
        expect(() => resolveUpdateTarget('freebsd', 'x64')).toThrow(/Unsupported platform/)
        expect(() => resolveUpdateTarget('linux', 'ia32')).toThrow(/Unsupported platform/)
    })
})

describe('selectLatestCliRelease', () => {
    it('sorts by publish time instead of trusting API order', () => {
        // The real API returned the older release first.
        const payload = [
            { tag_name: 'cli-20261111-a6cab5bb', draft: false, published_at: '2026-11-11T04:51:26Z' },
            { tag_name: 'cli-20261111-32ca84e5', draft: false, published_at: '2026-11-11T13:16:29Z' }
        ]

        expect(selectLatestCliRelease(payload)?.tag).toBe('cli-20261111-32ca84e5')
    })

    it('ignores drafts and non-cli tags', () => {
        const payload = [
            { tag_name: 'v0.99.0', draft: false, published_at: '2026-11-12T00:00:00Z' },
            { tag_name: 'cli-20261112-draft', draft: true, published_at: '2026-11-12T01:00:00Z' },
            { tag_name: 'cli-20261111-aaaa', draft: false, published_at: '2026-11-11T00:00:00Z' }
        ]

        expect(selectLatestCliRelease(payload)?.tag).toBe('cli-20261111-aaaa')
    })

    it('returns null when nothing matches', () => {
        expect(selectLatestCliRelease(null)).toBeNull()
        expect(selectLatestCliRelease({})).toBeNull()
        expect(selectLatestCliRelease([{ tag_name: 'v1.0.0' }])).toBeNull()
    })
})

describe('parseChecksums', () => {
    it('parses plain and star-prefixed sha256sum lines', () => {
        const a = 'a'.repeat(64)
        const b = 'b'.repeat(64)
        const checksums = parseChecksums(`${a}  hapi-darwin-arm64.tar.gz\n${b} *hapi-linux-x64-baseline.tar.gz\n`)

        expect(checksums.get('hapi-darwin-arm64.tar.gz')).toBe(a)
        expect(checksums.get('hapi-linux-x64-baseline.tar.gz')).toBe(b)
    })

    it('skips malformed lines', () => {
        expect(parseChecksums('not a checksum\n')).toEqual(new Map())
    })
})
