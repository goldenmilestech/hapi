import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ArchiveKind } from './release'

/** A compiled hapi binary is ~150 MB; anything this small is not a release. */
export const MIN_BINARY_BYTES = 50_000_000

export type InstallDecision = 'install' | 'up-to-date' | 'refuse-downgrade'

export function decideInstall(input: {
    installedTag: string | null
    latestTag: string
    binaryMtimeMs: number | null
    publishedAt: string | null
    force: boolean
}): InstallDecision {
    if (input.force) {
        return 'install'
    }
    if (input.installedTag === input.latestTag) {
        return 'up-to-date'
    }
    if (input.installedTag === null && input.binaryMtimeMs !== null && input.publishedAt) {
        const publishedAtMs = Date.parse(input.publishedAt)
        if (Number.isFinite(publishedAtMs) && input.binaryMtimeMs > publishedAtMs) {
            return 'refuse-downgrade'
        }
    }
    return 'install'
}

export function sha256(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex')
}

export function assertChecksum(
    archiveName: string,
    data: Uint8Array,
    checksums: Map<string, string>
): void {
    const expected = checksums.get(archiveName)
    if (!expected) {
        throw new Error(`checksums.txt has no entry for ${archiveName}`)
    }
    const actual = sha256(data)
    if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`)
    }
}

export function extractBinary(
    archivePath: string,
    archiveKind: ArchiveKind,
    binaryName: string,
    destinationDir: string
): string {
    mkdirSync(destinationDir, { recursive: true })
    const args = archiveKind === 'zip'
        ? ['-xf', archivePath, '-C', destinationDir, binaryName]
        : ['-xzf', archivePath, '-C', destinationDir, binaryName]
    const result = spawnSync('tar', args, { encoding: 'utf8' })

    if (result.error) {
        throw result.error
    }
    if (result.status !== 0) {
        throw new Error(`tar failed to extract ${archivePath}: ${result.stderr?.trim() || result.status}`)
    }

    const binaryPath = join(destinationDir, binaryName)
    if (!existsSync(binaryPath)) {
        throw new Error(`Archive ${basename(archivePath)} does not contain ${binaryName}`)
    }
    return binaryPath
}

export function assertBinarySize(path: string, minBytes: number = MIN_BINARY_BYTES): void {
    const size = statSync(path).size
    if (size < minBytes) {
        throw new Error(`Downloaded binary is too small (${size} bytes; expected at least ${minBytes})`)
    }
}

function formatTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('')
}

/**
 * Keeps the replaced binary next to the target so a failed rollout can be
 * reversed without downloading anything.
 */
export function replaceBinary(
    target: string,
    newBinary: string,
    tag: string,
    now: Date = new Date()
): string {
    const backup = `${target}.bak-${formatTimestamp(now)}-${tag}`
    copyFileSync(target, backup)
    chmodSync(backup, statSync(target).mode)

    const staged = `${target}.staged-${process.pid}`
    copyFileSync(newBinary, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, target)
    return backup
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Only removes backups created by this command (`hapi.bak-YYYYMMDD-HHMMSS-cli-*`),
 * never operator-made `hapi.bak-<timestamp>` files.
 */
export function pruneBackups(target: string, keep: number): string[] {
    if (keep <= 0) {
        return []
    }

    const directory = dirname(target)
    const pattern = new RegExp(
        `^${escapeRegExp(basename(target))}\\.bak-\\d{8}-\\d{6}-cli-`
    )
    const entries = readdirSync(directory)
        .filter((name) => pattern.test(name))
        .map((name) => {
            const path = join(directory, name)
            return { path, mtimeMs: statSync(path).mtimeMs }
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs)

    const removed: string[] = []
    for (const entry of entries.slice(keep)) {
        rmSync(entry.path, { force: true })
        removed.push(entry.path)
    }
    return removed
}
