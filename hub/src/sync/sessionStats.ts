import type { SessionStatsResponse } from '@hapi/protocol/apiTypes'
import type { UsageEvent } from '../store/usage'
import type { Store } from '../store'
import { normalizeUsageEvents, parseUsageEvent } from './usageService'
import { isDeliveredUserPrompt } from './userPromptRows'

/**
 * A step whose start-to-finish gap exceeds this is not a generation reading:
 * the runner was idle, reconnected, or the previous row is unrelated history.
 * Keeping such a gap would divide by an arbitrary wall-clock window.
 */
const MAX_STEP_GAP_MS = 10 * 60 * 1000

type StepTiming = {
    /** Timestamp of the message immediately before this step's first row. */
    previousAt: number | null
    lastAt: number
}

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null
}

function nonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Provider-reported generation time from a stored `round-summary` row. */
function readRoundSummaryGeneration(content: unknown): { generationMs: number; outputTokens: number } | null {
    const payload = asRecord(asRecord(content)?.content)
    const data = asRecord(payload?.data)
    if (data?.type !== 'round-summary') return null
    const summary = asRecord(data.summary)
    if (!summary) return null
    const generationMs = nonNegativeNumber(summary.generation_ms)
    const outputTokens = nonNegativeNumber(summary.generation_output_tokens)
    if (generationMs === null || outputTokens === null || generationMs <= 0 || outputTokens <= 0) return null
    return { generationMs, outputTokens }
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
 * Whole-session activity and token totals. The web status bar shows these, so
 * they must describe the durable log rather than the client's paged window.
 *
 * Throughput uses the best available timing: provider-reported
 * `generation_ms` when a runtime emits round summaries (OpenCode, agy), else
 * the per-step request window implied by stored assistant rows (Claude emits
 * one row per provider request). Both include time-to-first-token and exclude
 * tool execution, so the figure reads lower than a pure decode rate.
 */
export function computeSessionStats(store: Store, sessionId: string): SessionStatsResponse {
    const session = store.sessions.getSession(sessionId)
    const messages = store.messages.getAllMessages(sessionId)

    let turns = 0
    let previousAt: number | null = null
    let roundSummaryGenerationMs = 0
    let roundSummaryOutputTokens = 0
    const scannedEvents: UsageEvent[] = []
    const stepTimings = new Map<string, StepTiming>()

    for (const message of messages) {
        if (isDeliveredUserPrompt(message)) {
            turns += 1
        }

        const event = session ? parseUsageEvent(session, message) : null
        if (event) {
            scannedEvents.push(event)
            if (event.agent === 'claude') {
                const timing = stepTimings.get(event.sourceKey)
                if (timing) {
                    timing.lastAt = message.createdAt
                } else {
                    stepTimings.set(event.sourceKey, { previousAt, lastAt: message.createdAt })
                }
            }
        } else {
            const generation = readRoundSummaryGeneration(message.content)
            if (generation) {
                roundSummaryGenerationMs += generation.generationMs
                roundSummaryOutputTokens += generation.outputTokens
            }
        }

        previousAt = message.createdAt
    }

    const events = dedupeUsageEvents(scannedEvents)
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    let stepGenerationMs = 0
    let stepGenerationOutputTokens = 0

    for (const entry of normalizeUsageEvents(events)) {
        inputTokens += entry.inputTokens
        outputTokens += entry.outputTokens
        cacheReadTokens += entry.cacheReadTokens
        cacheCreationTokens += entry.cacheCreationTokens

        const timing = stepTimings.get(entry.event.sourceKey)
        if (!timing || timing.previousAt === null) continue
        const gapMs = timing.lastAt - timing.previousAt
        if (gapMs <= 0 || gapMs > MAX_STEP_GAP_MS) continue
        stepGenerationMs += gapMs
        stepGenerationOutputTokens += entry.outputTokens
    }

    // Round summaries are authoritative when a runtime emits them; Claude
    // transcripts do not carry generation timing, so they fall back to step
    // windows. Mixing both would double-count the same output tokens.
    const generation = roundSummaryGenerationMs > 0 && roundSummaryOutputTokens > 0
        ? { generationMs: roundSummaryGenerationMs, generationOutputTokens: roundSummaryOutputTokens }
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
        updatedAt: Date.now()
    }
}
