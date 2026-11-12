import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from './install'
import { runUpdate, type UpdateDeps, type UpdateOptions } from './runUpdate'

const ASSET = 'hapi-linux-x64-baseline.tar.gz'
const TAG = 'cli-20261112-deadbeef'
const tempDirs: string[] = []

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-run-update-test-'))
    tempDirs.push(dir)
    return dir
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function buildArchive(dir: string, content: string): Uint8Array {
    const sourceDir = join(dir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'hapi'), content)
    const archive = join(dir, ASSET)
    const result = spawnSync('tar', ['-czf', archive, '-C', sourceDir, 'hapi'])
    if (result.status !== 0) {
        throw new Error('failed to build test archive')
    }
    return new Uint8Array(readFileSync(archive))
}

function jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    })
}

function makeFetch(
    archive: Uint8Array,
    options: { checksum?: string; publishedAt?: string } = {}
): { fetchImpl: typeof fetch; calls: string[] } {
    const checksum = options.checksum ?? sha256(archive)
    const publishedAt = options.publishedAt ?? '2099-01-01T00:00:00Z'
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: unknown) => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : (input as Request).url
        calls.push(url)

        if (url.includes('/releases?per_page=30')) {
            return jsonResponse([{ tag_name: TAG, draft: false, published_at: publishedAt }])
        }
        if (url.includes('/releases/tags/')) {
            return jsonResponse({
                assets: [
                    { id: 1, name: 'checksums.txt', size: 100 },
                    { id: 2, name: ASSET, size: archive.length }
                ]
            })
        }
        if (url.endsWith('/assets/1')) {
            return new Response(`${checksum}  ${ASSET}\n`, { status: 200 })
        }
        if (url.endsWith('/assets/2')) {
            return new Response(archive, { status: 200 })
        }
        throw new Error(`unexpected request: ${url}`)
    })

    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

function baseOptions(overrides: Partial<UpdateOptions> = {}): UpdateOptions {
    return {
        check: false,
        force: false,
        tag: null,
        keep: 1,
        wait: false,
        bin: null,
        ...overrides
    }
}

function baseDeps(dir: string, overrides: Partial<UpdateDeps> = {}): Partial<UpdateDeps> {
    return {
        platform: 'linux',
        arch: 'x64',
        homeDir: join(dir, 'home'),
        minBinaryBytes: 1,
        log: () => {},
        readRunnerState: async () => null,
        isProcessAlive: () => false,
        waitForHandoff: async () => false,
        now: () => new Date('2026-11-12T15:30:00Z'),
        ...overrides
    }
}

describe('runUpdate', () => {
    it('downloads, verifies, replaces, and records the marker', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl } = makeFetch(archive)

        const exitCode = await runUpdate(
            baseOptions({ bin: binary }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(readFileSync(binary, 'utf8')).toBe('new-binary')
        const marker = JSON.parse(readFileSync(join(dir, 'home', 'cli-build.json'), 'utf8'))
        expect(marker.tag).toBe(TAG)
        expect(marker.sha256).toBe(sha256(archive))
        expect(marker.binary).toBe(binary)
    })

    it('--check reads only the release list and changes nothing', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl, calls } = makeFetch(archive)

        const exitCode = await runUpdate(
            baseOptions({ check: true, bin: binary }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(readFileSync(binary, 'utf8')).toBe('old-binary')
        expect(calls).toHaveLength(1)
        expect(() => readFileSync(join(dir, 'home', 'cli-build.json'))).toThrow()
    })

    it('does nothing when the marker already matches', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        mkdirSync(join(dir, 'home'), { recursive: true })
        writeFileSync(join(dir, 'home', 'cli-build.json'), JSON.stringify({
            tag: TAG,
            sha256: 'a'.repeat(64),
            binary,
            installedAt: '2026-11-12T00:00:00.000Z'
        }))
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl, calls } = makeFetch(archive)

        const exitCode = await runUpdate(
            baseOptions({ bin: binary }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(readFileSync(binary, 'utf8')).toBe('old-binary')
        expect(calls).toHaveLength(1)
    })

    it('ignores a marker that points at a different binary', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        mkdirSync(join(dir, 'home'), { recursive: true })
        writeFileSync(join(dir, 'home', 'cli-build.json'), JSON.stringify({
            tag: TAG,
            sha256: 'a'.repeat(64),
            binary: join(dir, 'other-hapi'),
            installedAt: '2026-11-12T00:00:00.000Z'
        }))
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl } = makeFetch(archive)

        const exitCode = await runUpdate(
            baseOptions({ bin: binary }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(readFileSync(binary, 'utf8')).toBe('new-binary')
    })

    it('refuses to downgrade a local build newer than the release', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        utimesSync(binary, new Date('2026-11-13T00:00:00Z'), new Date('2026-11-13T00:00:00Z'))
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl, calls } = makeFetch(archive, { publishedAt: '2026-11-11T00:00:00Z' })

        const exitCode = await runUpdate(
            baseOptions({ bin: binary }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(readFileSync(binary, 'utf8')).toBe('old-binary')
        expect(calls).toHaveLength(1)
    })

    it('leaves the binary untouched when the checksum does not match', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl } = makeFetch(archive, { checksum: '0'.repeat(64) })

        await expect(runUpdate(
            baseOptions({ bin: binary }),
            baseDeps(dir, { fetchImpl })
        )).rejects.toThrow(/Checksum mismatch/)

        expect(readFileSync(binary, 'utf8')).toBe('old-binary')
    })

    it('waits for the runner handoff when asked', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl } = makeFetch(archive)
        const waitForHandoff = vi.fn(async () => true)
        const logs: string[] = []

        const exitCode = await runUpdate(
            baseOptions({ bin: binary, wait: true }),
            baseDeps(dir, {
                fetchImpl,
                readRunnerState: async () => ({ pid: 4242 }),
                isProcessAlive: () => true,
                waitForHandoff,
                log: (message) => logs.push(message)
            })
        )

        expect(exitCode).toBe(0)
        expect(waitForHandoff).toHaveBeenCalledWith(4242, 120_000)
        expect(logs.join('\n')).toContain('handoff confirmed')
    })

    it('uses --tag without listing releases', async () => {
        const dir = makeTempDir()
        const binary = join(dir, 'hapi')
        writeFileSync(binary, 'old-binary')
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl, calls } = makeFetch(archive)

        const exitCode = await runUpdate(
            baseOptions({ bin: binary, tag: TAG }),
            baseDeps(dir, { fetchImpl })
        )

        expect(exitCode).toBe(0)
        expect(calls.some((url) => url.includes('/releases?'))).toBe(false)
        expect(readFileSync(binary, 'utf8')).toBe('new-binary')
    })

    it('requires the compiled binary when --bin is omitted', async () => {
        const dir = makeTempDir()
        const archive = buildArchive(dir, 'new-binary')
        const { fetchImpl } = makeFetch(archive)

        await expect(runUpdate(baseOptions(), baseDeps(dir, {
            fetchImpl,
            isCompiled: false,
            execPath: join(dir, 'hapi')
        }))).rejects.toThrow(/--bin/)
    })
})
