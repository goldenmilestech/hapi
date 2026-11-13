import { isObject } from '@hapi/protocol'
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

export type FeishuInputOption = {
    /** Display text. */
    label: string
    /** Value sent back to the agent (Cursor uses stable option ids). */
    value: string
    description: string | null
}

export type FeishuInputQuestion = {
    /** Stable question id (request_user_input / CursorAskQuestion). */
    id: string | null
    header: string | null
    question: string
    multiSelect: boolean
    /** request_user_input optional questions may be left unanswered. */
    required: boolean
    options: FeishuInputOption[]
}

/** One answer list per question, in question order. */
export type FeishuInputSelection = string[][]

export type FeishuInputAnswers =
    | Record<string, string[]>
    | Record<string, { answers: string[] }>

function isCodexInputRequest(tool: string): boolean {
    return tool === 'request_user_input'
}

function isCursorAskQuestion(tool: string): boolean {
    return tool === 'CursorAskQuestion'
}

/** Parse the question payload of every supported input-request tool. */
export function parseInputRequestQuestions(tool: string, args: unknown): FeishuInputQuestion[] {
    if (!isObject(args) || !Array.isArray(args.questions)) {
        return []
    }
    const cursor = isCursorAskQuestion(tool)
    const fallbackHeader = cursor && typeof args.title === 'string' ? args.title.trim() : ''
    const questions: FeishuInputQuestion[] = []
    for (const raw of args.questions) {
        if (!isObject(raw)) continue
        const question = typeof raw.question === 'string'
            ? raw.question.trim()
            : cursor && typeof raw.prompt === 'string'
                ? raw.prompt.trim()
                : ''
        const header = typeof raw.header === 'string'
            ? raw.header.trim()
            : cursor && typeof raw.title === 'string'
                ? raw.title.trim()
                : ''
        const id = typeof raw.id === 'string' ? raw.id.trim() : ''
        const multiSelect = raw.multiSelect === true
            || (cursor && raw.allowMultiple === true)
            || (isCodexInputRequest(tool) && raw.multiple === true)
        const options = Array.isArray(raw.options)
            ? raw.options.flatMap((option) => {
                if (!isObject(option)) return []
                const label = typeof option.label === 'string'
                    ? option.label.trim()
                    : cursor && typeof option.id === 'string'
                        ? option.id.trim()
                        : ''
                if (!label) return []
                const value = cursor && typeof option.id === 'string' && option.id.trim()
                    ? option.id.trim()
                    : label
                const description = typeof option.description === 'string'
                    ? option.description.trim()
                    : ''
                return [{ label, value, description: description || null }]
            })
            : []
        if (!question && options.length === 0) continue
        questions.push({
            id: id || null,
            header: header || fallbackHeader || null,
            question,
            multiSelect,
            required: isCodexInputRequest(tool) ? raw.required !== false : true,
            options
        })
    }
    return questions
}

/**
 * Build the payload consumed by the CLI. AskUserQuestion answers are keyed by
 * question index; Cursor keys them by stable question id; request_user_input
 * uses the nested `{ answers: [...] }` shape keyed by question id.
 */
export function buildInputRequestAnswers(
    tool: string,
    questions: FeishuInputQuestion[],
    selection: FeishuInputSelection
): FeishuInputAnswers {
    if (isCodexInputRequest(tool)) {
        const nested: Record<string, { answers: string[] }> = {}
        questions.forEach((question, index) => {
            nested[question.id ?? String(index)] = { answers: selection[index] ?? [] }
        })
        return nested
    }
    const flat: Record<string, string[]> = {}
    questions.forEach((question, index) => {
        const key = isCursorAskQuestion(tool)
            ? question.id ?? String(index)
            : String(index)
        flat[key] = selection[index] ?? []
    })
    return flat
}

export type FeishuInputCardAction = {
    kind: 'hapi_input'
    action: 'toggle' | 'pick' | 'submit' | 'skip'
    sessionId: string
    requestId: string
    question?: number
    value?: string
}

function inputActionValue(
    action: FeishuInputCardAction['action'],
    sessionId: string,
    requestId: string,
    extra: { question?: number; value?: string } = {}
): FeishuInputCardAction {
    return { kind: 'hapi_input', action, sessionId, requestId, ...extra }
}

function callbackBehavior(value: FeishuInputCardAction): FeishuCard {
    return { type: 'callback', value }
}

function displayTitle(sessionTitle: string): string {
    const title = sessionTitle.trim() || 'Hapi'
    return title.length > SESSION_TITLE_MAX_CHARS
        ? `${title.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : title
}

function questionHeading(question: FeishuInputQuestion, index: number): string {
    return question.header
        ? `**问题 ${index + 1}** · ${question.header}`
        : `**问题 ${index + 1}**`
}

function formatInputRequestFallback(args: unknown): string {
    if (typeof args === 'string') {
        return args.trim()
    }
    try {
        return JSON.stringify(args)
    } catch {
        return ''
    }
}

function sessionLink(input: { sessionId: string; publicUrl?: string | null }): string | null {
    const baseUrl = input.publicUrl?.trim().replace(/\/+$/, '')
    if (!baseUrl) return null
    return `${baseUrl}/sessions/${encodeURIComponent(input.sessionId)}`
}

/**
 * Forward an agent input request (AskUserQuestion / request_user_input) to the
 * bound Feishu chat. Options are interactive so the request can be answered
 * without leaving Feishu, mirroring the Agent Teams approval card. Cards stay
 * non-interactive when a question has no options (free-text answers only).
 */
export function buildInputRequestCard(input: {
    sessionId: string
    requestId: string
    sessionTitle: string
    tool: string
    args: unknown
    publicUrl?: string | null
    /** Current selections, used when re-rendering after a toggle/pick. */
    selection?: FeishuInputSelection
}): FeishuCard | null {
    const questions = parseInputRequestQuestions(input.tool, input.args)
    const selection = input.selection ?? questions.map(() => [])
    const link = sessionLink(input)
    const interactive = questions.length > 0
        && questions.every((question) => question.options.length > 0)
    const elements: FeishuCard[] = []

    if (interactive) {
        questions.forEach((question, index) => {
            const lines = [questionHeading(question, index)]
            if (question.question) {
                lines.push(question.question)
            }
            lines.push(question.multiSelect ? '_可多选_' : '_单选_')
            elements.push({
                tag: 'markdown',
                content: truncateForCard(sanitizeCardMarkdown(lines.join('\n')), STEPS_MAX_BYTES)
            })

            // Checkbox rows for every question: multi-select keeps them
            // independent, single-select unchecks the others on the server so
            // the card reads like a radio group.
            const chosen = selection[index] ?? []
            question.options.forEach((option, optionIndex) => {
                elements.push({
                    tag: 'checker',
                    name: `q${index}_o${optionIndex}`,
                    checked: chosen.includes(option.value),
                    text: {
                        tag: 'lark_md',
                        content: `**${option.label}**${option.description ? `：${option.description}` : ''}`
                    },
                    behaviors: [callbackBehavior(inputActionValue(
                        'toggle',
                        input.sessionId,
                        input.requestId,
                        { question: index, value: option.value }
                    ))]
                })
            })
        })

        // Selection is always confirmed explicitly, even for a single
        // single-select question: no accidental answer from a stray click.
        elements.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '提交回答' },
            type: 'primary_filled',
            width: 'fill',
            behaviors: [callbackBehavior(inputActionValue('submit', input.sessionId, input.requestId))]
        })
        elements.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '跳过' },
            type: 'default',
            width: 'fill',
            behaviors: [callbackBehavior(inputActionValue('skip', input.sessionId, input.requestId))]
        })
        if (link) {
            elements.push({
                tag: 'button',
                text: { tag: 'plain_text', content: '打开 Hapi 回答' },
                type: 'text',
                width: 'fill',
                behaviors: [{ type: 'open_url', default_url: link }]
            })
        }
    } else {
        const lines: string[] = []
        if (questions.length > 0) {
            questions.forEach((question, index) => {
                lines.push(questionHeading(question, index))
                if (question.question) {
                    lines.push(question.question)
                }
                for (const option of question.options) {
                    lines.push(`- **${option.label}**${option.description ? `：${option.description}` : ''}`)
                }
                if (question.multiSelect) {
                    lines.push('_可多选_')
                }
                lines.push('')
            })
        } else {
            const fallback = formatInputRequestFallback(input.args).trim()
            if (!fallback) {
                return null
            }
            lines.push(fallback, '')
        }
        if (link) {
            lines.push(`[打开 Hapi 回答](${link})`)
        } else {
            lines.push('请在 Hapi Web 中打开该会话回答。')
        }
        elements.push({
            tag: 'markdown',
            content: truncateForCard(sanitizeCardMarkdown(lines.join('\n')))
        })
    }

    return {
        schema: '2.0',
        config: {},
        header: {
            title: {
                tag: 'plain_text',
                content: `需要你回答：${displayTitle(input.sessionTitle)}`
            },
            template: 'orange'
        },
        body: { elements }
    }
}

/** Card that replaces the interactive one once the request is decided. */
export function buildInputRequestResolvedCard(input: {
    sessionTitle: string
    questions: FeishuInputQuestion[]
    selection: FeishuInputSelection
    status: 'answered' | 'expired' | 'skipped'
}): FeishuCard {
    const lines: string[] = []
    if (input.status === 'expired') {
        lines.push('该问题已在 Hapi 中回答或已失效。')
        lines.push('')
    }
    if (input.status === 'skipped') {
        lines.push('已跳过该问题，未向 agent 提交答案。')
        lines.push('')
    }
    input.questions.forEach((question, index) => {
        lines.push(questionHeading(question, index))
        if (question.question) {
            lines.push(question.question)
        }
        const chosen = input.selection[index] ?? []
        for (const option of question.options) {
            if (chosen.includes(option.value)) {
                lines.push(`- **${option.label}**`)
            }
        }
        lines.push('')
    })
    if (input.status === 'answered') {
        lines.push('已在 Hapi 中继续处理。')
    }
    const title = input.status === 'answered'
        ? `已回答：${displayTitle(input.sessionTitle)}`
        : input.status === 'skipped'
            ? `已跳过：${displayTitle(input.sessionTitle)}`
            : `问题已失效：${displayTitle(input.sessionTitle)}`
    return {
        schema: '2.0',
        config: {},
        header: {
            title: { tag: 'plain_text', content: title },
            template: input.status === 'answered' ? 'green' : 'grey'
        },
        body: {
            elements: [
                {
                    tag: 'markdown',
                    content: truncateForCard(sanitizeCardMarkdown(lines.join('\n').trim()))
                }
            ]
        }
    }
}
