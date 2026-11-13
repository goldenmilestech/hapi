import type { FeishuTurnSummary } from './turnSummary'

/**
 * Feishu rejects interactive cards above roughly 30 KB of JSON. Keep the
 * markdown well below that so the card envelope and escaping never push a
 * large answer over the limit.
 */
const CARD_CONTENT_MAX_BYTES = 18_000
const STEPS_MAX_BYTES = 4_000
const SESSION_TITLE_MAX_CHARS = 80

/** Agent Teams caps reasoning at 9,000 characters and keeps 8,000 (head+tail). */
const THINKING_MAX_CHARS = 9_000
const THINKING_KEEP_CHARS = 8_000

export type FeishuCard = Record<string, unknown>

/** Model output must not be able to turn into real @-mentions. */
function sanitizeCardMarkdown(text: string): string {
    return text.replace(/<\s*\/?\s*at\b[^>]*>/gi, '')
}

function truncationMarker(): string {
    return '\n\n…（内容过长，已截断）'
}

function sliceHeadByBytes(text: string, maxBytes: number): string {
    let used = 0
    let result = ''
    for (const char of text) {
        const bytes = Buffer.byteLength(char, 'utf8')
        if (used + bytes > maxBytes) {
            break
        }
        used += bytes
        result += char
    }
    return result
}

function sliceTailByBytes(text: string, maxBytes: number): string {
    const chars = Array.from(text)
    let used = 0
    const tail: string[] = []
    for (let index = chars.length - 1; index >= 0; index -= 1) {
        const char = chars[index]!
        const bytes = Buffer.byteLength(char, 'utf8')
        if (used + bytes > maxBytes) {
            break
        }
        used += bytes
        tail.push(char)
    }
    return tail.reverse().join('')
}

/**
 * Keep the head and tail of an oversized markdown block. Reasoning and tool
 * logs usually end with the conclusion, so a plain head cut loses the part
 * the operator most wants to read.
 */
export function truncateForCard(text: string, maxBytes = CARD_CONTENT_MAX_BYTES): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
        return text
    }
    const marker = truncationMarker()
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
    const headBudget = Math.floor(budget * 0.7)
    const tailBudget = budget - headBudget
    return `${sliceHeadByBytes(text, headBudget)}${marker}${sliceTailByBytes(text, tailBudget)}`
}

function truncateThinking(text: string): string {
    const chars = Array.from(text)
    if (chars.length <= THINKING_MAX_CHARS) {
        return text
    }
    const half = THINKING_KEEP_CHARS / 2
    const hidden = chars.length - THINKING_KEEP_CHARS
    return `${chars.slice(0, half).join('')}\n\n...（已省略 ${hidden} 字，卡片体积上限）...\n\n${chars.slice(-half).join('')}`
}

/** Agent Teams shows the tool name only, prefixed with a wrench. */
function stepToolName(step: string): string {
    const match = /^`([^`]+)`/.exec(step)
    return match ? match[1]! : step
}

function formatDuration(ms: number): string {
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} 秒`
    }
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms - minutes * 60_000) / 1000)
    return `${minutes} 分 ${seconds} 秒`
}

function formatTokens(count: number): string {
    return count >= 1000 ? `${(count / 1000).toFixed(1)}K tokens` : `${count} tokens`
}

/**
 * Header stats mirror Agent Teams: reasoning time only (never queue or tool
 * wall clock), then generated tokens, with no labels in front of the values.
 */
function buildStats(summary: FeishuTurnSummary): string[] {
    const parts: string[] = []
    if (summary.durationMs !== null && summary.durationMs > 0) {
        parts.push(formatDuration(summary.durationMs))
    }
    if (summary.outputTokens !== null && summary.outputTokens > 0) {
        parts.push(formatTokens(summary.outputTokens))
    }
    return parts
}

/**
 * Collapsed-by-default process card, matching the Agent Teams layout: the
 * header stays readable when collapsed and the full reasoning plus the
 * numbered tool calls (wrench + name) live inside. The same card is created
 * while the turn runs and rewritten in place at turn end.
 */
export function buildProgressCard(summary: FeishuTurnSummary): FeishuCard | null {
    const thinking = sanitizeCardMarkdown(summary.thinking).trim()
    const steps = summary.steps
        .map((step) => sanitizeCardMarkdown(step).trim())
        .filter((step) => step.length > 0)
    if (!thinking && steps.length === 0) {
        return null
    }

    const head = steps.length > 0
        ? `**执行过程** · ${steps.length} 步`
        : '**思考过程**'
    const stats = buildStats(summary)
    const title = stats.length > 0 ? `${head} · ${stats.join(' · ')}` : head

    const elements: FeishuCard[] = []
    if (thinking) {
        elements.push({
            tag: 'markdown',
            content: truncateThinking(thinking)
        })
    }
    if (steps.length > 0) {
        const stepText = steps
            .map((step, index) => `${index + 1}. 🔧 ${stepToolName(step)}`)
            .join('\n')
        elements.push({
            tag: 'markdown',
            content: truncateForCard(stepText, STEPS_MAX_BYTES)
        })
    }

    return {
        schema: '2.0',
        config: { streaming_mode: false },
        body: {
            elements: [
                {
                    tag: 'collapsible_panel',
                    expanded: false,
                    header: {
                        title: {
                            tag: 'markdown',
                            content: title
                        },
                        vertical_align: 'center',
                        icon: {
                            tag: 'standard_icon',
                            token: 'down-small-ccm_outlined',
                            size: '16px 16px'
                        },
                        icon_position: 'right',
                        icon_expanded_angle: -180
                    },
                    border: { color: 'grey', corner_radius: '5px' },
                    vertical_spacing: '8px',
                    padding: '8px 8px 8px 8px',
                    elements
                }
            ]
        }
    }
}

/** Final answer card: the mandatory "会话来自" header plus rendered markdown. */
export function buildAnswerCard(sessionTitle: string, answer: string): FeishuCard | null {
    const text = sanitizeCardMarkdown(answer).trim()
    if (!text) {
        return null
    }
    const title = sessionTitle.trim() || 'Hapi'
    const displayTitle = title.length > SESSION_TITLE_MAX_CHARS
        ? `${title.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : title

    return {
        schema: '2.0',
        config: { update_multi: true },
        header: {
            title: {
                tag: 'plain_text',
                content: `会话来自：${displayTitle}`
            },
            template: 'blue'
        },
        body: {
            elements: [
                {
                    tag: 'markdown',
                    content: truncateForCard(text)
                }
            ]
        }
    }
}
