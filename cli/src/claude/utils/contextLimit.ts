import { CONTEXT_LIMIT_MAX_TOKENS, CONTEXT_LIMIT_MIN_TOKENS } from '@hapi/protocol'

/**
 * Claude Code reads its auto-compact ceiling from
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at process start (100k–1M tokens). HAPI
 * runs one agent process per session, so the env var is a safe per-session
 * channel. Capture the user's own value once so clearing a session limit
 * restores their configuration instead of deleting it.
 */
const ORIGINAL_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

export function normalizeClaudeContextLimit(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.min(CONTEXT_LIMIT_MAX_TOKENS, Math.max(CONTEXT_LIMIT_MIN_TOKENS, Math.floor(value)))
}

export function applyContextLimitEnv(limit: number | null | undefined): void {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.floor(limit))
        return
    }
    if (ORIGINAL_AUTO_COMPACT_WINDOW === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        return
    }
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ORIGINAL_AUTO_COMPACT_WINDOW
}
