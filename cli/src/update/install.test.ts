import { spawnSync } from 'node:child_process'
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    assertBinarySize,
    assertChecksum,
    decideInstall,
    extractBinary,
    pruneBackups,
    replaceBinary,
    sha256
} from './install'
import { readUpdateMarker, writeUpdateMarker } from './marker'

const tempDirs: string[] = []

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-update-test-'))
    tempDirs.push(dir)
    return dir
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('decideInstall', () => {
    const base = {
        installedTag: null,
        latestTag: 'cli-20261112-deadbeef',
        binaryMtimeMs: null,
        publishedAt: '2026-11-12T00:00:00Z',
        force: false
    }

    it('installs when no marker exists', () => {
        expect(decideInstall(base)).toBe('install')
    })

    it('is a no-op when the marker matches', () => {
        expect(decideInstall({ ...base, installedTag: base.latestTag })).toBe('up-to-date')
    })

    it('refuses to downgrade a local build newer than the release', () => {
        expect(decideInstall({
            ...base,
            binaryMtimeMs: Date.parse('2026-11-12T12:00:00Z')
        })).toBe('refuse-downgrade')
    })

    it('lets --force override every guard', () => {
        expect(decideInstall({
            ...base,
            installedTag: base.latestTag,
            binaryMtimeMs: Date.parse('2026-11-13T00:00:00Z'),
            force: true
        })).toBe('install')
    })
})

describe('checksums', () => {
    it('hashes empty input', () => {
        expect(sha256(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })

    it('accepts a matching checksum', () => {
        const data = new TextEncoder().encode('archive')
        expect(() => assertChecksum('a.tar.gz', data, new Map([['a.tar.gz', sha256(data)]]))).not.toThrow()
    })

    it('rejects a mismatch and a missing entry', () => {
        const data = new TextEncoder().encode('archive')
        expect(() => assertChecksum('a.tar.gz', data, new Map([['a.tar.gz', '0'.repeat(64)]])))
            .toThrow(/Checksum mismatch/)
        expect(() => assertChecksum('a.tar.gz', data, new Map()))
            .toThrow(/no entry/)
    })
})

describe('update marker', () => {
    it('round-trips and tolerates broken files', () => {
        const dir = makeTempDir()
        const markerPath = join(dir, 'cli-build.json')
        const marker = {
            tag: 'cli-20261112-deadbeef',
            sha256: 'a'.repeat(64),
            binary: '/tmp/hapi',
            installedAt: '2026-11-12T00:00:00.000Z'
        }

        writeUpdateMarker(markerPath, marker)
        expect(readUpdateMarker(markerPath)).toEqual(marker)

        writeFileSync(markerPath, '{not json')
        expect(readUpdateMarker(markerPath)).toBeNull()
    })
})

describe('extractBinary', () => {
    it('extracts the binary from a tar.gz archive', () => {
        const dir = makeTempDir()
        const sourceDir = join(dir, 'source')
        mkdirSync(sourceDir)
        writeFileSync(join(sourceDir, 'hapi'), 'binary-content')
        const archive = join(dir, 'hapi-darwin-arm64.tar.gz')
        const result = spawnSync('tar', ['-czf', archive, '-C', sourceDir, 'hapi'])
        expect(result.status).toBe(0)

        const extracted = extractBinary(archive, 'tar.gz', 'hapi', join(dir, 'out'))
        expect(readFileSync(extracted, 'utf8')).toBe('binary-content')
    })

    it('fails when the archive does not contain the binary', () => {
        const dir = makeTempDir()
        const sourceDir = join(dir, 'source')
        mkdirSync(sourceDir)
        writeFileSync(join(sourceDir, 'other'), 'x')
        const archive = join(dir, 'a.tar.gz')
        spawnSync('tar', ['-czf', archive, '-C', sourceDir, 'other'])

        expect(() => extractBinary(archive, 'tar.gz', 'hapi', join(dir, 'out')))
            .toThrow(/tar failed|does not contain/)
    })
})

describe('replaceBinary', () => {
    it('keeps a backup, replaces the target, and makes it executable', () => {
        const dir = makeTempDir()
        const target = join(dir, 'hapi')
        const next = join(dir, 'hapi.new')
        writeFileSync(target, 'old-binary')
        writeFileSync(next, 'new-binary')
        chmodSync(target, 0o755)

        const backup = replaceBinary(target, next, 'cli-20261112-deadbeef', new Date('2026-11-12T15:30:00'))

        expect(readFileSync(target, 'utf8')).toBe('new-binary')
        expect(readFileSync(backup, 'utf8')).toBe('old-binary')
        expect(statSync(target).mode & 0o777).toBe(0o755)
        expect(backup.endsWith('/hapi.bak-20261112-153000-cli-20261112-deadbeef')).toBe(true)
    })
})

describe('pruneBackups', () => {
    it('keeps N recent backups and never touches operator backups', () => {
        const dir = makeTempDir()
        const target = join(dir, 'hapi')
        writeFileSync(target, 'current')
        const names = [
            'hapi.bak-20260101-000000-cli-a',
            'hapi.bak-20260102-000000-cli-b',
            'hapi.bak-20260103-000000-cli-c'
        ]
        for (const [index, name] of names.entries()) {
            const path = join(dir, name)
            writeFileSync(path, name)
            const time = new Date(2026, 0, index + 1)
            utimesSync(path, time, time)
        }
        writeFileSync(join(dir, 'hapi.bak-20200101-000000'), 'manual')
        writeFileSync(join(dir, 'hapi.bad'), 'bad')

        const removed = pruneBackups(target, 2)

        expect(removed).toEqual([join(dir, names[0])])
        expect(() => statSync(join(dir, names[0]))).toThrow()
        expect(readFileSync(join(dir, 'hapi.bak-20200101-000000'), 'utf8')).toBe('manual')
        expect(readFileSync(join(dir, 'hapi.bad'), 'utf8')).toBe('bad')
    })
})

describe('assertBinarySize', () => {
    it('rejects files below the minimum and accepts larger ones', () => {
        const dir = makeTempDir()
        const path = join(dir, 'hapi')
        writeFileSync(path, 'small')

        expect(() => assertBinarySize(path, 100)).toThrow(/too small/)
        expect(() => assertBinarySize(path, 1)).not.toThrow()
    })
})
