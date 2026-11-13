import { isObject } from '@hapi/protocol'
import { extractAssistantPlainText, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { StoredMessage } from '../../store'
import { isDeliveredUserPrompt } from '../../sync/userPromptRows'

/** Bounds a single tool/step label so one huge prompt cannot bloat the card. */
const TOOL_LABEL_LIMIT = 120

export type FeishuTurnSummary = {
    /** All reasoning emitted after the turn's user prompt, in order. */
    thinking: string
    /** Human-readable tool calls, already de-duplicated by call id. */
    steps: string[]
    /** Last assistant prose in the turn; null when the turn ended on a tool call. */
    answer: string | null
    /** Stored id of the message the answer came from, for cross-ready de-duplication. */
    answerMessageId: string | null
    /** Sum of Claude's per-message output tokens, when the agent reports them. */
    outputTokens: number | null
    /** First and last stored message timestamps for the turn, when known. */
    startedAt: number | null
    endedAt: number | null
}

type IndexedText = {
    text: string
}

type TurnAccumulator = {
    thinking: IndexedText[]
    thinkingIds: Map<string, number>
    steps: string[]
    stepIds: Map<string, number>
    outputTokens: number
    usageIds: Set<string>
}

function normalizeInlineText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function truncateLabel(value: string): string {
    if (value.length <= TOOL_LABEL_LIMIT) {
        return value
    }
    return `${value.slice(0, TOOL_LABEL_LIMIT - 1).trimEnd()}…`
}

function upsertThinking(acc: TurnAccumulator, id: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) {
        return
    }
    const existing = acc.thinkingIds.get(id)
    if (existing === undefined) {
        acc.thinkingIds.set(id, acc.thinking.length)
        acc.thinking.push({ text: trimmed })
        return
    }
    // ACP/Codex reasoning arrives as growing snapshots under one stream id.
    if (trimmed.length > acc.thinking[existing]!.text.length) {
        acc.thinking[existing]!.text = trimmed
    }
}

function addStep(acc: TurnAccumulator, id: string, label: string): void {
    const normalized = truncateLabel(normalizeInlineText(label))
    if (!normalized) {
        return
    }
    const existing = acc.stepIds.get(id)
    if (existing === undefined) {
        acc.stepIds.set(id, acc.steps.length)
        acc.steps.push(normalized)
        return
    }
    // Later snapshots can carry a richer description for the same call.
    if (normalized.length > acc.steps[existing]!.length) {
        acc.steps[existing] = normalized
    }
}

function describeToolInput(input: unknown): string | null {
    if (!isObject(input)) {
        return null
    }
    const description = input.description
    if (typeof description === 'string' && description.trim()) {
        return description
    }
    for (const key of ['command', 'file_path', 'path', 'query', 'pattern', 'url']) {
        const value = input[key]
        if (typeof value === 'string' && value.trim()) {
            return value
        }
    }
    return null
}

function formatToolLabel(name: string, detail: string | null): string {
    const cleanName = normalizeInlineText(name).replace(/`/g, '')
    const label = cleanName || 'Tool'
    const cleanDetail = detail ? normalizeInlineText(detail).replace(/`/g, "'") : ''
    return cleanDetail ? `\`${label}\` — ${cleanDetail}` : `\`${label}\``
}

function recordOutputTokens(acc: TurnAccumulator, data: Record<string, unknown>, messageId: string): void {
    const message = isObject(data.message) ? data.message : null
    const usage = message && isObject(message.usage) ? message.usage : null
    const outputTokens = usage?.output_tokens
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) {
        return
    }
    const id = typeof data.uuid === 'string' && data.uuid ? data.uuid : messageId
    if (acc.usageIds.has(id)) {
        return
    }
    acc.usageIds.add(id)
    acc.outputTokens += outputTokens
}

function collectClaudeAssistant(
    acc: TurnAccumulator,
    data: Record<string, unknown>,
    messageId: string
): void {
    recordOutputTokens(acc, data, messageId)
    const message = isObject(data.message) ? data.message : null
    const blocks = message && Array.isArray(message.content) ? message.content : null
    if (!blocks) {
        return
    }

    const uuid = typeof data.uuid === 'string' && data.uuid ? data.uuid : messageId
    blocks.forEach((block, index) => {
        if (!isObject(block) || typeof block.type !== 'string') {
            return
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
            upsertThinking(acc, `${uuid}:thinking:${index}`, block.thinking)
            return
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
            const id = typeof block.id === 'string' && block.id
                ? block.id
                : `${uuid}:tool:${index}`
            addStep(acc, id, formatToolLabel(block.name, describeToolInput(block.input)))
        }
    })
}

function collectGenericAgent(acc: TurnAccumulator, data: Record<string, unknown>, messageId: string): void {
    if (data.type === 'reasoning' && typeof data.message === 'string') {
        const id = typeof data.id === 'string' && data.id ? data.id : messageId
        upsertThinking(acc, id, data.message)
        return
    }
    if (data.type === 'tool-call') {
        const id = typeof data.callId === 'string' && data.callId
            ? data.callId
            : `${messageId}:tool`
        const name = typeof data.name === 'string' && data.name ? data.name : 'Tool'
        const detail = typeof data.description === 'string' && data.description.trim()
            ? data.description
            : typeof data.nativeTitle === 'string' && data.nativeTitle.trim()
                ? data.nativeTitle
                : describeToolInput(data.input)
        addStep(acc, id, formatToolLabel(name, detail))
    }
}

function readAssistantText(content: unknown): string | null {
    const text = extractAssistantPlainText(content)
    return text && text.trim() ? text : null
}

/** Assistant prose, or the SDK result envelope some Claude runs end with. */
function readAnswerText(content: unknown): string | null {
    const text = readAssistantText(content)
    if (text) {
        return text
    }
    if (isObject(content) && content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (data?.type === 'result' && typeof data.result === 'string' && data.result.trim()) {
            return data.result
        }
    }
    return null
}

function readRecordContent(message: StoredMessage): {
    role: string
    content: unknown
    isSidechain: boolean
} | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return null
    }
    const content = record.content
    const data = isObject(content) && isObject(content.data) ? content.data : null
    return {
        role: record.role,
        content,
        isSidechain: data?.isSidechain === true
    }
}

type AnswerHit = {
    index: number
    text: string
    messageId: string
}

function findAnswer(messages: StoredMessage[], endExclusive: number): AnswerHit | null {
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        const record = readRecordContent(message)
        if (!record || record.role !== 'agent' || record.isSidechain) {
            continue
        }
        const text = readAnswerText(record.content)
        if (text) {
            return { index, text, messageId: message.id }
        }
    }
    return null
}

function findPromptStart(messages: StoredMessage[], endExclusive: number): number {
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
        if (isDeliveredUserPrompt(messages[index]!)) {
            return index + 1
        }
    }
    return -1
}

function createAccumulator(): TurnAccumulator {
    return {
        thinking: [],
        thinkingIds: new Map(),
        steps: [],
        stepIds: new Map(),
        outputTokens: 0,
        usageIds: new Set()
    }
}

function collectRange(
    messages: StoredMessage[],
    start: number,
    endInclusive: number,
    acc: TurnAccumulator
): void {
    for (let index = start; index <= endInclusive && index < messages.length; index += 1) {
        const message = messages[index]!
        const record = readRecordContent(message)
        if (!record || record.role !== 'agent' || record.isSidechain) {
            continue
        }

        const content = record.content
        if (isObject(content)) {
            const data = isObject(content.data) ? content.data : null
            if (content.type === 'output' && data?.type === 'assistant') {
                collectClaudeAssistant(acc, data, message.id)
            } else if (content.type === 'codex' && data) {
                collectGenericAgent(acc, data, message.id)
            }
        }
    }
}

/**
 * Reconstruct the turn that produced the last assistant answer.
 *
 * Anchoring on the answer (rather than on the newest prompt) matters when a
 * queued prompt is already stored by the time the `ready` event fires: the
 * answer still belongs to the previous prompt, and the new prompt must not
 * hide it. Agent-internal subagent traffic (`isSidechain`) is skipped so
 * delegated work never shows up as the operator's answer.
 */
export function summarizeFeishuTurn(messages: StoredMessage[]): FeishuTurnSummary {
    const answer = findAnswer(messages, messages.length)
    const acc = createAccumulator()

    if (!answer) {
        const start = findPromptStart(messages, messages.length)
        if (start >= 0) {
            collectRange(messages, start, messages.length - 1, acc)
        }
        return {
            thinking: acc.thinking.map((entry) => entry.text).join('\n\n').trim(),
            steps: acc.steps,
            answer: null,
            answerMessageId: null,
            outputTokens: acc.outputTokens > 0 ? acc.outputTokens : null,
            startedAt: start >= 0 ? messages[start]?.createdAt ?? null : null,
            endedAt: start >= 0 ? messages[messages.length - 1]?.createdAt ?? null : null
        }
    }

    const start = findPromptStart(messages, answer.index)
    if (start >= 0) {
        collectRange(messages, start, answer.index, acc)
    }

    return {
        thinking: acc.thinking.map((entry) => entry.text).join('\n\n').trim(),
        steps: acc.steps,
        answer: answer.text,
        answerMessageId: answer.messageId,
        outputTokens: acc.outputTokens > 0 ? acc.outputTokens : null,
        startedAt: start >= 0 ? messages[start]?.createdAt ?? null : null,
        endedAt: start >= 0 ? messages[answer.index]?.createdAt ?? null : null
    }
}
