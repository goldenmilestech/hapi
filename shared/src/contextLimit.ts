import type { AgentFlavor } from './modes'

/**
 * Per-session context ceilings.
 *
 * Claude Code's `autoCompactWindow` setting (and the
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var it reads) accepts 100k–1M tokens.
 * Keep every surface on the same range so a value that the UI accepts never
 * gets rejected by the agent process.
 */
export const CONTEXT_LIMIT_MIN_TOKENS = 100_000
export const CONTEXT_LIMIT_MAX_TOKENS = 1_000_000

/**
 * Hub-side watcher threshold for flavors without native auto-compaction.
 * Trigger slightly before the ceiling so the follow-up turn still fits in the
 * model window, mirroring Claude Code's own "window minus summary buffer"
 * behavior.
 */
export const AUTO_COMPACT_TRIGGER_RATIO = 0.9

/**
 * The command each flavor accepts to compact its context. Flavors absent here
 * have no known compaction command, so HAPI hides both the manual button and
 * hub-side auto-compaction for them.
 */
const COMPACT_COMMAND_BY_FLAVOR: Partial<Record<AgentFlavor, string>> = {
    claude: '/compact',
    codex: '/compact',
    gemini: '/compress',
    grok: '/compact',
    // OpenCode's launcher bridges /compact to its native REST compaction even
    // though the catalog does not advertise it.
    opencode: '/compact',
    pi: '/compact',
    cursor: '/compress'
}

export function getCompactCommandForFlavor(flavor: string | null | undefined): string | null {
    if (!flavor) return null
    return COMPACT_COMMAND_BY_FLAVOR[flavor as AgentFlavor] ?? null
}

/** Clamp a configured limit into the range every agent accepts. */
export function normalizeContextLimit(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.min(CONTEXT_LIMIT_MAX_TOKENS, Math.max(CONTEXT_LIMIT_MIN_TOKENS, Math.floor(value)))
}

/**
 * Effective ceiling shown in the UI: the configured limit, but never above the
 * model's own reported window. Null when neither is known.
 */
export function getEffectiveContextMax(
    contextWindow: number | null | undefined,
    contextLimit: number | null | undefined
): number | null {
    const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null
    const limit = typeof contextLimit === 'number' && contextLimit > 0 ? contextLimit : null
    if (window === null) return limit
    if (limit === null) return window
    return Math.min(window, limit)
}
