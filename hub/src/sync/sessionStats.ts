import type { SessionStatsResponse } from '@hapi/protocol/apiTypes'
import type { StoredMessage } from '../store'
import type { UsageEvent } from '../store/usage'
import type { Store } from '../store'
import { normalizeUsageEvents, parseUsageEvent } from './usageService'
import { isDeliveredUserPrompt } from './userPromptRows'

/**
 * A generation window whose start-to-finish gap exceeds this is not a reading:
 * the runner was idle, reconnected, or the previous row is unrelated history.
 * Keeping such a gap would divide by an arbitrary wall-clock window.
 */
const MAX_STEP_GAP_MS = 10 * 60 * 1000

/**
 * Tool rows only describe a call while it is actually running. A result that
 * arrives after a long idle gap (background process, stale resume) belongs to
 * that idle period, not to tool work.
 */
const MAX_TOOL_GAP_MS = 60 * 60 * 1000

/**
 * One provider request's worth of usage rows. A request may stream several
 * usage snapshots in a row, and runtimes may interleave reasoning/text rows
 * between them, so the window stays open until the next barrier row.
 */
type GenerationWindow = {
    /** Timestamp of the last tool result or delivered prompt before the request. */
    startAt: number | null
    lastAt: number
    /** Whether any row in this window is a per-request usage row. */
    timed: boolean
}

type ToolBatch = {
    startAt: number
    endAt: number | null
}

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function readAgentPayload(message: StoredMessage): RecordValue | null {
    const envelope = asRecord(message.content)
    return asRecord(asRecord(envelope?.content)?.data)
}

/** Provider-reported generation time. */
function readRoundTiming(content: unknown): { generationMs: number | null; outputTokens: number | null } | null {
    const payload = asRecord(asRecord(content)?.content)
    const data = asRecord(payload?.data)
    if (!data) return null
    // OpenCode/agy emit a HAPI-owned round summary; Claude reports the same
    // numbers on its turn_duration result carrier, with `duration_api_ms` as
    // generation time (tool waits are already outside that clock).
    const summary = data.type === 'round-summary'
        ? asRecord(data.summary)
        : data.type === 'system' && data.subtype === 'turn_duration'
            ? asRecord(data.resultSummary)
            : null
    if (!summary) return null
    const generationMs = nonNegativeNumber(summary.generation_ms)
    const outputTokens = nonNegativeNumber(summary.generation_output_tokens)
    if (generationMs === null && outputTokens === null) return null
    return { generationMs, outputTokens }
}

/** A row that cannot be emitted while a model request is still generating. */
function isGenerationBarrier(message: StoredMessage): boolean {
    if (isDeliveredUserPrompt(message)) return true
    const data = readAgentPayload(message)
    if (!data) return false
    if (data.type === 'tool-call-result' || data.type === 'tool_result') return true
    if (data.type !== 'user') return false
    const content = asRecord(data.message)?.content
    return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_result')
}

function readToolUseIds(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    return content
        .map((block) => {
            const record = asRecord(block)
            return record?.type === 'tool_use' ? asString(record.id) : null
        })
        .filter((id): id is string => id !== null)
}

function readToolResultIds(content: unknown): string[] {
    if (!Array.isArray(content)) return []
    return content
        .map((block) => {
            const record = asRecord(block)
            return record?.type === 'tool_result' ? asString(record.tool_use_id) : null
        })
        .filter((id): id is string => id !== null)
}

/**
 * Pair tool calls with their results. Calls emitted by one assistant row share
 * a batch, so parallel calls contribute their wall-clock span once; runtimes
 * that emit a row per call get one batch per call.
 */
function collectToolBatches(
    message: StoredMessage,
    batches: ToolBatch[],
    batchByCallId: Map<string, ToolBatch>
): void {
    const data = readAgentPayload(message)
    if (!data) return

    const finish = (callId: string) => {
        const batch = batchByCallId.get(callId)
        if (!batch) return
        batch.endAt = batch.endAt === null
            ? message.createdAt
            : Math.max(batch.endAt, message.createdAt)
    }

    if (data.type === 'assistant') {
        const ids = readToolUseIds(asRecord(data.message)?.content)
        const freshIds = ids.filter((id) => !batchByCallId.has(id))
        if (freshIds.length === 0) return
        const batch: ToolBatch = { startAt: message.createdAt, endAt: null }
        batches.push(batch)
        for (const id of freshIds) batchByCallId.set(id, batch)
        return
    }

    if (data.type === 'tool-call') {
        const callId = asString(data.callId)
        if (!callId || batchByCallId.has(callId)) return
        const batch: ToolBatch = { startAt: message.createdAt, endAt: null }
        batches.push(batch)
        batchByCallId.set(callId, batch)
        return
    }

    if (data.type === 'tool-call-result') {
        const callId = asString(data.callId)
        if (callId) finish(callId)
        return
    }

    if (data.type === 'user') {
        for (const id of readToolResultIds(asRecord(data.message)?.content)) finish(id)
        return
    }

    if (data.type === 'tool_result') {
        const callId = asString(data.tool_use_id) ?? asString(data.callId)
        if (callId) finish(callId)
    }
}

function sumToolMs(batches: ToolBatch[]): number | null {
    let total = 0
    for (const batch of batches) {
        if (batch.endAt === null) continue
        const gap = batch.endAt - batch.startAt
        if (gap <= 0 || gap > MAX_TOOL_GAP_MS) continue
        total += gap
    }
    return total > 0 ? total : null
}

/**
 * Only per-request usage rows can bound a generation window: Claude's
 * usage-bearing assistant row and Codex's token_count snapshot each arrive at
 * the end of one provider request. ACP `usage` rows aggregate a whole turn,
 * tool execution included, so timing them would overstate the model clock.
 */
function isRequestUsageRow(message: StoredMessage): boolean {
    const envelope = asRecord(message.content)
    const payload = asRecord(envelope?.content)
    const data = asRecord(payload?.data)
    if (!data) return false
    if (payload?.type === 'output' && data.type === 'assistant') return true
    return data.type === 'token_count'
}

/**
 * Fold stored rows into one usage event per provider request. Mirrors the
 * usage index's upsert rule: a delta stream is replayed by its newest row, a
 * cumulative stream by its oldest snapshot.
 */
function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[] {
    const bySourceKey = new Map<string, UsageEvent>()
    for (const event of events) {
        if (event.kind === 'delta' || !bySourceKey.has(event.sourceKey)) {
            bySourceKey.set(event.sourceKey, event)
        }
    }
    return Array.from(bySourceKey.values())
        .sort((a, b) => a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.sourceSeq - b.sourceSeq)
}

/**
 * Whole-session activity, token, and timing totals. The web status bar shows
 * these, so they must describe the durable log rather than the client's paged
 * window.
 *
 * Throughput uses the best available timing:
 * 1. provider-reported `generation_ms` (round summaries and Claude's
 *    turn_duration carrier) — both exclude tool execution;
 * 2. otherwise the window from the last tool result or prompt to the last
 *    usage row of a provider request. Tool results are stored when the tool
 *    finishes, so this window covers generation only and excludes tool time.
 *
 * Sessions where neither source exists report no speed instead of a
 * wall-clock number that would silently include tool execution.
 */
export function computeSessionStats(store: Store, sessionId: string): SessionStatsResponse {
    const session = store.sessions.getSession(sessionId)
    const messages = store.messages.getAllMessages(sessionId)

    let turns = 0
    let roundGenerationMs = 0
    let roundOutputTokens = 0
    let lastBarrierAt: number | null = null
    let currentWindow: GenerationWindow | null = null
    const scannedEvents: UsageEvent[] = []
    const windowBySeq = new Map<number, GenerationWindow>()
    const toolBatches: ToolBatch[] = []
    const toolBatchByCallId = new Map<string, ToolBatch>()

    for (const message of messages) {
        if (isDeliveredUserPrompt(message)) turns += 1
        collectToolBatches(message, toolBatches, toolBatchByCallId)

        const event = session ? parseUsageEvent(session, message) : null
        if (event) {
            scannedEvents.push(event)
            if (!currentWindow) {
                currentWindow = { startAt: lastBarrierAt, lastAt: message.createdAt, timed: false }
            }
            currentWindow.lastAt = message.createdAt
            currentWindow.timed = currentWindow.timed || isRequestUsageRow(message)
            windowBySeq.set(message.seq, currentWindow)
            continue
        }

        // A barrier ends the current request window. Non-barrier rows (reasoning,
        // assistant text, turn summaries) belong to the same request and must not
        // split its timing.
        if (isGenerationBarrier(message)) {
            currentWindow = null
            lastBarrierAt = message.createdAt
        }
        const round = readRoundTiming(message.content)
        if (round && round.generationMs !== null && round.generationMs > 0
            && round.outputTokens !== null && round.outputTokens > 0) {
            roundGenerationMs += round.generationMs
            roundOutputTokens += round.outputTokens
        }
    }

    const events = dedupeUsageEvents(scannedEvents)
    const normalized = normalizeUsageEvents(events)
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    const windowOutputs = new Map<GenerationWindow, number>()

    for (const entry of normalized) {
        inputTokens += entry.inputTokens
        outputTokens += entry.outputTokens
        cacheReadTokens += entry.cacheReadTokens
        cacheCreationTokens += entry.cacheCreationTokens

        const window = windowBySeq.get(entry.event.sourceSeq)
        if (!window || entry.outputTokens <= 0) continue
        windowOutputs.set(window, (windowOutputs.get(window) ?? 0) + entry.outputTokens)
    }

    let stepGenerationMs = 0
    let stepGenerationOutputTokens = 0
    for (const [window, windowOutputTokens] of windowOutputs) {
        if (!window.timed || window.startAt === null) continue
        const gapMs = window.lastAt - window.startAt
        if (gapMs <= 0 || gapMs > MAX_STEP_GAP_MS) continue
        stepGenerationMs += gapMs
        stepGenerationOutputTokens += windowOutputTokens
    }

    // Provider timing is authoritative when present; mixing both would
    // double-count the same output tokens.
    const generation = roundGenerationMs > 0 && roundOutputTokens > 0
        ? { generationMs: roundGenerationMs, generationOutputTokens: roundOutputTokens }
        : stepGenerationMs > 0 && stepGenerationOutputTokens > 0
            ? { generationMs: stepGenerationMs, generationOutputTokens: stepGenerationOutputTokens }
            : null

    return {
        turns,
        steps: events.length,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens: inputTokens + outputTokens,
        generationMs: generation?.generationMs ?? null,
        generationOutputTokens: generation?.generationOutputTokens ?? null,
        toolMs: sumToolMs(toolBatches),
        updatedAt: Date.now()
    }
}
