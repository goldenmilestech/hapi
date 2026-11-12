import { logger } from '@/ui/logger'
import { runUpdate } from './runUpdate'

const SUCCESS_INTERVAL_MS = 6 * 60 * 60_000
const RETRY_INTERVAL_MS = 60 * 60_000
const JITTER_RATIO = 0.1

export type AutoUpdateResult = 'success' | 'error'

export function autoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env.HAPI_AUTO_UPDATE ?? '').trim().toLowerCase()
    if (value !== '1' && value !== 'true' && value !== 'yes' && value !== 'on') {
        return false
    }
    // When the operator owns process supervision, replacing the binary behind
    // their back is surprising and the runner would not restart anyway.
    if ((env.HAPI_DISABLE_VERSION_HANDOFF ?? '').trim() === '1') {
        return false
    }
    return true
}

/**
 * A failed check retries sooner than a successful one, and every delay gets
 * up to 10% jitter so a fleet behind one NAT does not hit the anonymous
 * GitHub API limit in lockstep.
 */
export function nextAutoUpdateDelayMs(
    result: AutoUpdateResult,
    random: () => number = Math.random
): number {
    const base = result === 'success' ? SUCCESS_INTERVAL_MS : RETRY_INTERVAL_MS
    return base + Math.floor(base * JITTER_RATIO * random())
}

let nextAttemptAt = 0
let running = false

/** Test-only: reset module-level scheduling state. */
export function resetAutoUpdateStateForTests(): void {
    nextAttemptAt = 0
    running = false
}

async function defaultRun(): Promise<number> {
    return await runUpdate(
        { check: false, force: false, tag: null, keep: 3, wait: false, bin: null },
        { log: (message) => logger.debug(message) }
    )
}

/**
 * Opt-in background updater for the runner heartbeat. Never blocks the
 * heartbeat: the download runs detached and the resulting binary replacement
 * is picked up by the existing mtime handoff on a later tick.
 */
export async function maybeAutoUpdateNow(options: {
    now?: number
    run?: () => Promise<number>
} = {}): Promise<void> {
    if (!autoUpdateEnabled() || running) {
        return
    }

    const now = options.now ?? Date.now()
    if (now < nextAttemptAt) {
        return
    }

    running = true
    try {
        const exitCode = await (options.run ?? defaultRun)()
        const result: AutoUpdateResult = exitCode === 0 ? 'success' : 'error'
        nextAttemptAt = now + nextAutoUpdateDelayMs(result)
        logger.debug(`[AUTO UPDATE] check finished (${result}); next check in ${nextAttemptAt - now}ms`)
    } catch (error) {
        nextAttemptAt = now + nextAutoUpdateDelayMs('error')
        logger.debug('[AUTO UPDATE] check failed', error)
    } finally {
        running = false
    }
}
