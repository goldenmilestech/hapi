import chalk from 'chalk'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { readRunnerState } from '@/persistence'
import { isBunCompiled } from '@/projectPath'
import { waitForRunnerHandoff } from '@/runner/controlClient'
import { isProcessAlive } from '@/utils/process'
import {
    downloadAsset,
    fetchLatestRelease,
    fetchReleaseAsset,
    type FetchImpl
} from './github'
import {
    assertBinarySize,
    assertChecksum,
    decideInstall,
    extractBinary,
    pruneBackups,
    replaceBinary,
    MIN_BINARY_BYTES,
    type InstallDecision
} from './install'
import { readUpdateMarker, writeUpdateMarker } from './marker'
import {
    parseChecksums,
    resolveUpdateTarget,
    type ReleaseSummary,
    type UpdateTarget
} from './release'

const HANDOFF_TIMEOUT_MS = 120_000
const DEFAULT_REPO = 'qlqj-frederick-dong/hapi'

export type UpdateOptions = {
    check: boolean
    force: boolean
    tag: string | null
    keep: number
    wait: boolean
    bin: string | null
}

export type RunnerStateLike = {
    pid: number
    startedWithCliMtimeMs?: number
    startedWithVersionHandoffDisabled?: boolean
}

export type UpdateDeps = {
    fetchImpl: FetchImpl
    platform: string
    arch: string
    execPath: string
    isCompiled: boolean
    homeDir: string
    repo: string
    now: () => Date
    log: (message: string) => void
    readRunnerState: () => Promise<RunnerStateLike | null>
    isProcessAlive: (pid: number) => boolean
    waitForHandoff: (pid: number, timeoutMs: number) => Promise<boolean>
    handoffDisabled: boolean
    minBinaryBytes: number
    extract: typeof extractBinary
}

export function defaultUpdateDeps(): UpdateDeps {
    return {
        fetchImpl: fetch,
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
        isCompiled: isBunCompiled(),
        homeDir: configuration.happyHomeDir,
        repo: process.env.HAPI_UPDATE_REPO?.trim() || DEFAULT_REPO,
        now: () => new Date(),
        log: (message) => console.log(message),
        readRunnerState: async () => await readRunnerState() as RunnerStateLike | null,
        isProcessAlive,
        waitForHandoff: (pid, timeoutMs) => waitForRunnerHandoff(pid, { timeoutMs }),
        handoffDisabled: process.env.HAPI_DISABLE_VERSION_HANDOFF === '1',
        minBinaryBytes: MIN_BINARY_BYTES,
        extract: extractBinary
    }
}

function resolveBinaryPath(explicit: string | null, deps: UpdateDeps): string {
    if (explicit) {
        return resolve(explicit)
    }
    if (!deps.isCompiled) {
        throw new Error(
            '`hapi update` must run from the installed binary. Pass --bin <path> when running from source.'
        )
    }
    return deps.execPath
}

function statusLabel(decision: InstallDecision): string {
    if (decision === 'up-to-date') {
        return 'up to date'
    }
    if (decision === 'refuse-downgrade') {
        return 'local build is newer than the latest release'
    }
    return 'update available'
}

function printStatus(
    deps: UpdateDeps,
    binaryPath: string,
    installedTag: string | null,
    latest: ReleaseSummary,
    decision: InstallDecision
): void {
    deps.log('')
    deps.log(chalk.bold('HAPI update'))
    deps.log(chalk.gray(`  binary:    ${binaryPath}`))
    deps.log(chalk.gray(`  installed: ${installedTag ?? 'unknown'}`))
    deps.log(chalk.gray(`  latest:    ${latest.tag}`))
    deps.log(chalk.gray(`  status:    ${statusLabel(decision)}`))
}

async function downloadAndExtract(
    deps: UpdateDeps,
    target: UpdateTarget,
    tag: string
): Promise<{ binaryPath: string; checksum: string; cleanup: () => void }> {
    const checksumsAsset = await fetchReleaseAsset(deps.repo, tag, 'checksums.txt', deps.fetchImpl)
    const checksumsBytes = await downloadAsset(deps.repo, checksumsAsset.id, deps.fetchImpl)
    const checksums = parseChecksums(new TextDecoder().decode(checksumsBytes))

    const archiveAsset = await fetchReleaseAsset(deps.repo, tag, target.asset, deps.fetchImpl)
    const archiveBytes = await downloadAsset(deps.repo, archiveAsset.id, deps.fetchImpl)
    assertChecksum(target.asset, archiveBytes, checksums)

    const tempDir = mkdtempSync(join(tmpdir(), 'hapi-update-'))
    const cleanup = () => rmSync(tempDir, { recursive: true, force: true })
    try {
        const archivePath = join(tempDir, target.asset)
        writeFileSync(archivePath, archiveBytes)
        const binaryPath = deps.extract(archivePath, target.archiveKind, target.binaryName, tempDir)
        assertBinarySize(binaryPath, deps.minBinaryBytes)
        return {
            binaryPath,
            checksum: checksums.get(target.asset) as string,
            cleanup
        }
    } catch (error) {
        cleanup()
        throw error
    }
}

function warnOnBinaryDrift(
    deps: UpdateDeps,
    state: RunnerStateLike | null,
    binaryMtimeMs: number | null
): void {
    if (
        !state
        || typeof state.startedWithCliMtimeMs !== 'number'
        || binaryMtimeMs === null
    ) {
        return
    }
    if (Math.abs(state.startedWithCliMtimeMs - binaryMtimeMs) > 2_000) {
        deps.log(chalk.yellow(
            'Warning: the running runner started from a different binary; replacing this file may not restart it.'
        ))
    }
}

async function waitForHandoffIfNeeded(
    deps: UpdateDeps,
    options: UpdateOptions,
    state: RunnerStateLike | null,
    oldPid: number | null
): Promise<void> {
    if (!options.wait || oldPid === null) {
        return
    }
    if (deps.handoffDisabled || state?.startedWithVersionHandoffDisabled) {
        deps.log(chalk.yellow(
            'Version handoff is disabled. Restart the runner manually: hapi runner stop && hapi runner start'
        ))
        return
    }

    deps.log(chalk.gray('Waiting for the runner to pick up the new binary (up to 120s)...'))
    const handedOff = await deps.waitForHandoff(oldPid, HANDOFF_TIMEOUT_MS)
    if (handedOff) {
        deps.log(chalk.green('Runner handoff confirmed.'))
    } else {
        deps.log(chalk.yellow('Runner handoff not observed. Check: hapi runner status'))
    }
}

export async function runUpdate(
    options: UpdateOptions,
    overrides: Partial<UpdateDeps> = {}
): Promise<number> {
    const deps = { ...defaultUpdateDeps(), ...overrides }
    const target = resolveUpdateTarget(deps.platform, deps.arch)
    const binaryPath = resolveBinaryPath(options.bin, deps)
    const markerPath = join(deps.homeDir, 'cli-build.json')
    const marker = readUpdateMarker(markerPath)

    const latest = options.tag
        ? { tag: options.tag, publishedAt: null }
        : await fetchLatestRelease(deps.repo, deps.fetchImpl)
    const binaryMtimeMs = existsSync(binaryPath) ? statSync(binaryPath).mtimeMs : null
    // A marker copied from another install must not make this binary look current.
    const installedTag = marker && marker.binary === binaryPath ? marker.tag : null
    const decision = decideInstall({
        installedTag,
        latestTag: latest.tag,
        binaryMtimeMs,
        publishedAt: latest.publishedAt,
        force: options.force
    })

    if (options.check) {
        printStatus(deps, binaryPath, installedTag, latest, decision)
        return 0
    }
    if (decision === 'up-to-date') {
        deps.log(`Already up to date: ${latest.tag}`)
        return 0
    }
    if (decision === 'refuse-downgrade') {
        deps.log(`Local binary is newer than ${latest.tag}; refusing to downgrade (use --force to install anyway).`)
        return 0
    }

    deps.log(`Installing ${latest.tag} for ${deps.platform}-${deps.arch}`)
    const downloaded = await downloadAndExtract(deps, target, latest.tag)
    try {
        const state = await deps.readRunnerState()
        const oldPid = state && deps.isProcessAlive(state.pid) ? state.pid : null
        warnOnBinaryDrift(deps, state, binaryMtimeMs)

        if (target.platform === 'win32') {
            const staged = `${binaryPath}.new-${latest.tag}`
            copyFileSync(downloaded.binaryPath, staged)
            deps.log(chalk.yellow(`Windows cannot replace a running executable. New binary: ${staged}`))
            deps.log(chalk.gray(`Close all hapi processes, then: move /Y "${staged}" "${binaryPath}"`))
            return 1
        }

        const backup = replaceBinary(binaryPath, downloaded.binaryPath, latest.tag, deps.now())
        try {
            writeUpdateMarker(markerPath, {
                tag: latest.tag,
                sha256: downloaded.checksum,
                binary: binaryPath,
                installedAt: deps.now().toISOString()
            })
        } catch (error) {
            deps.log(chalk.yellow(
                `Warning: installed the binary but could not write ${markerPath}: ${error instanceof Error ? error.message : String(error)}`
            ))
        }

        const removed = pruneBackups(binaryPath, options.keep)
        deps.log(chalk.green(`Installed ${latest.tag} -> ${binaryPath}`))
        deps.log(chalk.gray(`  backup: ${backup}`))
        if (removed.length > 0) {
            deps.log(chalk.gray(`  pruned: ${removed.length} old backup(s)`))
        }

        await waitForHandoffIfNeeded(deps, options, state, oldPid)
        return 0
    } finally {
        downloaded.cleanup()
    }
}
