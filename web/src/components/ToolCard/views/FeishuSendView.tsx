import { isObject } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import type { ToolPermission } from '@/chat/types'
import type { ToolViewProps } from './_all'

function readString(input: unknown, key: string): string | null {
    if (!isObject(input)) return null
    const value = input[key]
    return typeof value === 'string' && value.trim() ? value : null
}

function MetaPill(props: { label: string; value: string }) {
    return (
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
            {props.label ? <span className="font-medium text-[var(--app-fg)]">{props.label}</span> : null}
            <span className="truncate [overflow-wrap:anywhere]">{props.value}</span>
        </span>
    )
}

function statusBox(permission: ToolPermission | undefined): 'pending' | 'sent' | 'failed' | null {
    if (!permission) return null
    if (permission.status === 'pending') return 'pending'
    if (permission.status === 'approved') return 'sent'
    if (permission.status === 'denied' || permission.status === 'canceled') return 'failed'
    return null
}

/**
 * In-chat Feishu send card. The pending approval is synthesized from
 * `agentState.requests` (bare tool name); the executed MCP tool renders the
 * same view with its request-shaped input.
 */
export function FeishuSendView({ block }: ToolViewProps) {
    const { t } = useTranslation()
    const input = block.tool.input
    const kind = readString(input, 'kind')
    const target = readString(input, 'targetLabel')
        ?? readString(input, 'to')
        ?? readString(input, 'chat')
    const sender = readString(input, 'senderLabel')
    const rawText = readString(input, 'text') ?? readString(input, 'preview')
    // The wire text carries Feishu's <at> tag; the card shows the mention the
    // way the recipient will see it.
    const text = rawText && sender
        ? rawText.replace(/<at user_id="[^"]*"><\/at>/g, `@${sender}`)
        : rawText
    const permissionStatus = statusBox(block.tool.permission)
    const receipt = permissionStatus === 'sent' ? block.tool.permission?.reason : null

    return (
        <div className="flex min-w-0 flex-col gap-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
                <MetaPill
                    label=""
                    value={kind === 'group' ? t('tool.feishu.group') : t('tool.feishu.dm')}
                />
                {target ? <MetaPill label={t('tool.feishu.to')} value={target} /> : null}
                {sender ? <MetaPill label={t('tool.feishu.sender')} value={sender} /> : null}
            </div>

            {text ? (
                <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-[var(--app-fg)] [overflow-wrap:anywhere]">
                    {text}
                </div>
            ) : null}

            {receipt ? (
                <div className="rounded-xl border border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] px-3 py-2 text-xs text-[var(--app-badge-success-text)]">
                    {t('tool.feishu.receipt')}: {receipt}
                </div>
            ) : null}
        </div>
    )
}

export function FeishuSendResultView({ block }: ToolViewProps) {
    const result = block.tool.result
    const text = typeof result === 'string'
        ? result
        : result === undefined || result === null
            ? ''
            : JSON.stringify(result, null, 2)
    if (!text.trim()) {
        return <div className="text-sm text-[var(--app-hint)]">—</div>
    }
    const failed = block.tool.state === 'error'
    return (
        <div className={`whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere] ${
            failed ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-fg)]'
        }`}>
            {text}
        </div>
    )
}
