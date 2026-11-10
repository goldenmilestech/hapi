/**
 * Claude Code's native side-question channel (the `/btw` command).
 *
 * Side questions run against the active session through the SDK's
 * `side_question` control request: they see the current context, cannot call
 * tools, and never enter the main conversation. HAPI keeps a short exchange
 * history so follow-up questions keep their referents.
 */

export type SideQuestionHistoryEntry = {
    question: string
    response: string
}

export type SideQuestionAnswer = {
    response: string
    synthetic: boolean
}

export type SideQuestionHandler = (
    question: string,
    history: readonly SideQuestionHistoryEntry[]
) => Promise<SideQuestionAnswer | null>

/** Keep the same order of magnitude as Claude Code's own side-question panel. */
export const SIDE_QUESTION_HISTORY_LIMIT = 10

/**
 * The Claude SDK waits up to ~11 minutes for a side-question answer before it
 * reports a timeout. Use the same ceiling here so a wedged child cannot leave
 * the HAPI request pending forever.
 */
export const SIDE_QUESTION_TIMEOUT_MS = 10 * 60_000

export function parseSideQuestionAnswer(value: unknown): SideQuestionAnswer | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const payload = value as { response?: unknown; synthetic?: unknown }
    if (payload.response === null) {
        return null
    }
    if (typeof payload.response !== 'string') {
        return null
    }
    if (payload.response.trim().length === 0) {
        return null
    }

    return {
        response: payload.response,
        synthetic: payload.synthetic === true
    }
}
