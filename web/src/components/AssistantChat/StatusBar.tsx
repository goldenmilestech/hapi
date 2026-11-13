import {
    CONTEXT_LIMIT_MAX_TOKENS,
    CONTEXT_LIMIT_MIN_TOKENS,
    getCodexCollaborationModeLabel,
    getCompactCommandForFlavor,
    getCopilotAgentModeLabel,
    getEffectiveContextMax,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useMemo, useState } from 'react'
import type { AgentState, CodexCollaborationMode, PermissionMode, SessionStatsResponse } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import {
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowReasoningStatusLabel
} from '@/lib/codexStatusLabels'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-blue-500',
    warning: 'text-amber-500',
    danger: 'text-red-500'
}

const CONTEXT_WARNING_THRESHOLD_PERCENT = 70
const CONTEXT_DANGER_THRESHOLD_PERCENT = 90

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    backgroundTaskCount: number,
    t: (key: string) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: t('misc.offline'),
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        const vibingMessage = VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)].toLowerCase() + '…'
        return {
            text: vibingMessage,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (backgroundTaskCount > 0) {
        return {
            text: `${backgroundTaskCount} background task${backgroundTaskCount > 1 ? 's' : ''} running`,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: t('misc.online'),
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

export function getContextWarning(contextSize: number, maxContextSize: number): { color: string } {
    const percentageUsed = (contextSize / maxContextSize) * 100

    if (percentageUsed >= CONTEXT_DANGER_THRESHOLD_PERCENT) {
        return { color: 'text-red-500' }
    } else if (percentageUsed >= CONTEXT_WARNING_THRESHOLD_PERCENT) {
        return { color: 'text-amber-500' }
    } else {
        return { color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

/** The limit editor works in thousands: 1000 means 1M tokens. */
export function formatContextLimitDraft(limit: number | null | undefined): string {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return ''
    return String(Math.round(limit / 1_000))
}

function getContextPercentages(contextSize: number, maxContextSize: number): {
    usedPercentage: number
    remainingPercentage: number
} {
    const usedPercentage = Math.min(100, Math.max(0, Math.round((contextSize / maxContextSize) * 100)))
    return { usedPercentage, remainingPercentage: 100 - usedPercentage }
}

export function formatContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `${formatTokenCount(contextSize)} used`
    const { usedPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `${usedPercentage}% · ${formatTokenCount(contextSize)} / ${formatTokenCount(maxContextSize)}`
}

export function formatCompactContextUsageLabel(contextSize: number, maxContextSize: number | null | undefined): string {
    if (!maxContextSize) return `ctx ${formatTokenCount(contextSize)}`
    const { remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return `ctx ${formatTokenCount(maxContextSize)} (${remainingPercentage}% left)`
}

export function getContextUsageDetails(
    contextSize: number,
    maxContextSize: number | null | undefined,
    contextCacheRead: number | null | undefined
): {
    cacheRead: string | null
    used: string
    usedPercentage: number | null
    remaining: string | null
    remainingPercentage: number | null
} {
    if (!maxContextSize) {
        return {
            cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
            used: formatTokenCount(contextSize),
            usedPercentage: null,
            remaining: null,
            remainingPercentage: null
        }
    }

    const { usedPercentage, remainingPercentage } = getContextPercentages(contextSize, maxContextSize)
    return {
        cacheRead: contextCacheRead && contextCacheRead > 0 ? formatTokenCount(contextCacheRead) : null,
        used: formatTokenCount(contextSize),
        usedPercentage,
        remaining: formatTokenCount(Math.max(0, maxContextSize - contextSize)),
        remainingPercentage
    }
}

export function shouldShowCodexFastBadge(
    agentFlavor: string | null | undefined,
    serviceTier: string | null | undefined
): boolean {
    return agentFlavor === 'codex' && isFastServiceTier(serviceTier)
}

function formatOneDecimal(value: number): string {
    return String(Math.round(value * 10) / 10)
}

/** Whole-session step counts: `3 rounds 31 steps`. */
export function formatSessionStatsCounts(turns: number, steps: number, t: (key: string, params?: Record<string, string | number>) => string): string {
    return steps > 0
        ? t('misc.statsCounts', { turns, steps })
        : t('misc.statsTurns', { turns })
}

/**
 * Average generation speed for the steps that carry timing. Ten tokens per
 * second and up are shown whole; slower averages keep one decimal.
 */
export function formatSessionStatsSpeed(
    generationMs: number | null | undefined,
    generationOutputTokens: number | null | undefined
): string | null {
    if (typeof generationMs !== 'number' || !Number.isSafeInteger(generationMs) || generationMs <= 0) return null
    if (typeof generationOutputTokens !== 'number' || !Number.isSafeInteger(generationOutputTokens) || generationOutputTokens <= 0) return null
    const tokensPerSecond = generationOutputTokens / (generationMs / 1_000)
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null
    const rounded = tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : formatOneDecimal(tokensPerSecond)
    return `${rounded} tok/s`
}

export function formatSessionStatsTokens(totalTokens: number): string | null {
    if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null
    return `${formatTokenCount(totalTokens)} tok`
}

/**
 * Cache reads as a share of billed prompt input. A partial hit never rounds up
 * to a misleading 100%: it keeps hundredths instead.
 */
export function formatSessionStatsCacheHit(
    cacheReadTokens: number | null | undefined,
    inputTokens: number | null | undefined
): string | null {
    if (typeof cacheReadTokens !== 'number' || !Number.isSafeInteger(cacheReadTokens) || cacheReadTokens <= 0) return null
    if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens <= 0) return null
    if (cacheReadTokens >= inputTokens) return '100'
    const percent = (cacheReadTokens / inputTokens) * 100
    if (!Number.isFinite(percent) || percent <= 0) return null
    const rounded = Math.round(percent)
    if (rounded < 100) return String(rounded)
    return (Math.floor(percent * 100) / 100).toFixed(2).replace(/\.?0+$/, '')
}

export function buildSessionStatsDetails(stats: SessionStatsResponse, t: (key: string, params?: Record<string, string | number>) => string): string {
    return t('misc.statsDetails', {
        total: formatTokenCount(stats.totalTokens),
        input: stats.inputTokens.toLocaleString(),
        cacheRead: stats.cacheReadTokens.toLocaleString(),
        cacheWrite: stats.cacheCreationTokens.toLocaleString(),
        output: stats.outputTokens.toLocaleString()
    })
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    /** Per-session context ceiling in tokens; null/undefined = native window. */
    contextLimit?: number | null
    /** Persist a new per-session ceiling; presence also enables the editor. */
    onContextLimitChange?: (contextLimit: number | null) => Promise<void> | void
    /** Send the flavor's compact command; presence enables the button. */
    onCompact?: () => void
    compactDisabled?: boolean
    /**
     * Model to use for the context-window fallback heuristic when
     * contextWindow is absent. Falls back to `model`. Callers pass the
     * usage-bearing message's own model here so local Claude sessions (whose
     * session.model is often null) still resolve a plausible window.
     */
    contextModel?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: import('@hapi/protocol').CopilotAgentMode
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
    /** Whole-session activity/token totals; see SessionStatsResponse. */
    sessionStats?: SessionStatsResponse | null
}) {
    const { t } = useTranslation()
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    const contextHeuristicModel = props.contextModel ?? props.model
    // The configured per-session ceiling wins over the model's native window,
    // but never extends it: a 1M limit on a 200k model still shows 200k.
    const maxContextSize = useMemo(
        () => getEffectiveContextMax(
            props.contextWindow ?? getContextBudgetTokens(contextHeuristicModel, props.agentFlavor),
            props.contextLimit
        ),
        [props.contextWindow, props.contextLimit, contextHeuristicModel, props.agentFlavor]
    )
    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined || !maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize)
        },
        [props.contextSize, maxContextSize]
    )
    const contextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        return formatContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, maxContextSize])
    const compactContextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        return formatCompactContextUsageLabel(props.contextSize, maxContextSize)
    }, [props.contextSize, maxContextSize])
    const contextUsageDetails = useMemo(() => {
        if (props.contextSize === undefined) return null
        return getContextUsageDetails(props.contextSize, maxContextSize, props.contextCacheRead)
    }, [props.contextSize, props.contextCacheRead, maxContextSize])
    const contextUsedPercentage = contextUsageDetails?.usedPercentage ?? null

    const sessionStatsSpeed = useMemo(
        () => formatSessionStatsSpeed(props.sessionStats?.generationMs, props.sessionStats?.generationOutputTokens),
        [props.sessionStats]
    )
    const sessionStatsCacheHit = useMemo(
        () => {
            const stats = props.sessionStats
            if (!stats) return null
            const cacheHit = formatSessionStatsCacheHit(stats.cacheReadTokens, stats.inputTokens)
            return cacheHit ? t('misc.statsCacheHit', { percent: cacheHit }) : null
        },
        [props.sessionStats, t]
    )
    const sessionStatsActivity = useMemo(() => {
        const stats = props.sessionStats
        if (!stats || (stats.steps <= 0 && stats.turns <= 0)) return null
        const counts = formatSessionStatsCounts(stats.turns, stats.steps, t)
        return sessionStatsSpeed ? `${counts} · ${sessionStatsSpeed}` : counts
    }, [props.sessionStats, sessionStatsSpeed, t])
    const sessionStatsUsage = useMemo(() => {
        const stats = props.sessionStats
        if (!stats) return null
        const total = formatSessionStatsTokens(stats.totalTokens)
        if (!total) return null
        return sessionStatsCacheHit ? `${total} · ${sessionStatsCacheHit}` : total
    }, [props.sessionStats, sessionStatsCacheHit])
    const sessionStatsDetails = useMemo(
        () => props.sessionStats ? buildSessionStatsDetails(props.sessionStats, t) : undefined,
        [props.sessionStats, t]
    )

    const compactCommand = getCompactCommandForFlavor(props.agentFlavor)
    const canConfigureContextLimit = Boolean(props.onContextLimitChange) && compactCommand !== null
    const contextLimit = props.contextLimit ?? null
    const [popoverOpen, setPopoverOpen] = useState(false)
    const [limitDraft, setLimitDraft] = useState(() => formatContextLimitDraft(contextLimit))
    const [savingLimit, setSavingLimit] = useState(false)

    useEffect(() => {
        setLimitDraft(formatContextLimitDraft(contextLimit))
    }, [contextLimit])

    const saveContextLimit = async (next: number | null) => {
        if (!props.onContextLimitChange || savingLimit) return
        setSavingLimit(true)
        try {
            await props.onContextLimitChange(next)
            setLimitDraft(formatContextLimitDraft(next))
        } catch {
            // The caller already reports the failure (haptics + console); keep
            // the popover open so the operator can retry the same value.
        } finally {
            setSavingLimit(false)
        }
    }

    const saveContextLimitFromDraft = () => {
        const parsed = Number.parseFloat(limitDraft)
        if (!Number.isFinite(parsed)) return
        const tokens = Math.round(parsed * 1_000)
        void saveContextLimit(Math.min(CONTEXT_LIMIT_MAX_TOKENS, Math.max(CONTEXT_LIMIT_MIN_TOKENS, tokens)))
    }

    const permissionMode = props.permissionMode
    // Copilot always shows permission (including Default) so model=auto sessions
    // still surface the bottom-right mode chip. Other flavors keep Codex-style
    // "hide default" parity.
    const displayPermissionMode = permissionMode
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        && (permissionMode !== 'default' || props.agentFlavor === 'copilot')
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode ? getPermissionModeLabel(displayPermissionMode) : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const displayCopilotAgentMode = props.agentFlavor === 'copilot'
        && props.copilotAgentMode
        && props.copilotAgentMode !== 'interactive'
        ? props.copilotAgentMode
        : null
    const copilotAgentModeLabel = displayCopilotAgentMode
        ? getCopilotAgentModeLabel(displayCopilotAgentMode)
        : null
    const reasoningEffort = getReasoningEffortForFlavor(
        props.agentFlavor,
        props.modelReasoningEffort,
        props.effort
    )
    const displaysReasoning = shouldShowReasoningStatusLabel(props.agentFlavor, reasoningEffort)
    const reasoningLabel = displaysReasoning
        ? formatReasoningLabel(reasoningEffort, headerMetadata.showLabels)
        : null
    const compactReasoningLabel = displaysReasoning
        ? formatCompactReasoningLabel(reasoningEffort)
        : null
    const codexFastMode = shouldShowCodexFastBadge(props.agentFlavor, props.serviceTier)

    return (
        <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-baseline gap-2">
                <div className="relative top-px sm:top-0.5 flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {contextUsageLabel ? (
                    <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
                        <Popover.Trigger asChild>
                            <button
                                type="button"
                                aria-label={t('misc.contextDetails')}
                                className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}
                            >
                                <span className="sm:hidden">{compactContextUsageLabel}</span>
                                <span className="hidden items-center gap-2 sm:inline-flex">
                                    {contextUsedPercentage !== null ? (
                                        <span
                                            aria-hidden="true"
                                            className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-[var(--app-link-muted)]"
                                        >
                                            <span
                                                className="block h-full rounded-full bg-current"
                                                style={{ width: `${contextUsedPercentage}%` }}
                                            />
                                        </span>
                                    ) : null}
                                    <span>{contextUsageLabel}</span>
                                </span>
                            </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Content
                                side="top"
                                align="start"
                                sideOffset={6}
                                collisionPadding={8}
                                className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                            >
                                <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
                                    {contextUsageDetails?.cacheRead ? (
                                        <span className="break-words">
                                            {t('misc.contextCache', { value: contextUsageDetails.cacheRead })}
                                        </span>
                                    ) : null}
                                    <span className="break-words">
                                        {contextUsageDetails?.usedPercentage === null
                                            ? t('misc.contextUsedTokens', { value: contextUsageDetails.used })
                                            : t('misc.contextUsed', {
                                                value: contextUsageDetails?.used ?? '',
                                                percent: contextUsageDetails?.usedPercentage ?? 0
                                            })}
                                    </span>
                                    {contextUsageDetails?.remaining && contextUsageDetails.remainingPercentage !== null ? (
                                        <span className="break-words">
                                            {t('misc.contextRemaining', {
                                                value: contextUsageDetails.remaining,
                                                percent: contextUsageDetails.remainingPercentage
                                            })}
                                        </span>
                                    ) : null}
                                    {canConfigureContextLimit ? (
                                        <div className="mt-1 flex flex-col gap-1 border-t border-[var(--app-border)] pt-2">
                                            <div className="flex items-center gap-1.5">
                                                <span className="shrink-0 text-[var(--app-hint)]">
                                                    {t('misc.contextLimit')}
                                                </span>
                                                <input
                                                    type="number"
                                                    inputMode="numeric"
                                                    min={CONTEXT_LIMIT_MIN_TOKENS / 1_000}
                                                    max={CONTEXT_LIMIT_MAX_TOKENS / 1_000}
                                                    step={10}
                                                    value={limitDraft}
                                                    placeholder={t('misc.contextLimitAuto')}
                                                    aria-label={t('misc.contextLimit')}
                                                    onChange={(event) => setLimitDraft(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key !== 'Enter') return
                                                        event.preventDefault()
                                                        saveContextLimitFromDraft()
                                                    }}
                                                    className="w-16 rounded-sm border border-[var(--app-border)] bg-transparent px-1.5 py-0.5 text-right text-xs text-[var(--app-fg)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)]"
                                                />
                                                <span className="text-[var(--app-hint)]">k</span>
                                                <button
                                                    type="button"
                                                    onClick={saveContextLimitFromDraft}
                                                    disabled={savingLimit}
                                                    className="rounded-sm px-1.5 py-0.5 text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                                >
                                                    {t('misc.contextLimitSave')}
                                                </button>
                                                {contextLimit !== null ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => void saveContextLimit(null)}
                                                        disabled={savingLimit}
                                                        className="rounded-sm px-1.5 py-0.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                                    >
                                                        {t('misc.contextLimitAuto')}
                                                    </button>
                                                ) : null}
                                            </div>
                                            {contextLimit !== null ? (
                                                <span className="text-[10px] text-[var(--app-hint)]">
                                                    {t('misc.contextAutoCompactHint')}
                                                </span>
                                            ) : null}
                                        </div>
                                    ) : null}
                                    {props.onCompact && compactCommand ? (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setPopoverOpen(false)
                                                props.onCompact?.()
                                            }}
                                            disabled={props.compactDisabled}
                                            className="mt-1 w-full rounded-sm border border-[var(--app-border)] px-2 py-1 text-left text-xs text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                        >
                                            {t('misc.compactContext')}
                                        </button>
                                    ) : null}
                                </div>
                            </Popover.Content>
                        </Popover.Portal>
                    </Popover.Root>
                ) : null}
                {sessionStatsActivity || sessionStatsUsage ? (
                    <div
                        data-testid="session-stats"
                        title={sessionStatsDetails}
                        className="hidden min-w-0 items-baseline gap-2 sm:flex"
                    >
                        {/* Compact below md keeps the row from overflowing on phones:
                            DSH's compact mode shows only speed and cache hit. */}
                        {sessionStatsActivity ? (
                            <span className="hidden whitespace-nowrap text-[10px] leading-4 text-[var(--app-hint)] md:inline">
                                {sessionStatsActivity}
                            </span>
                        ) : null}
                        {sessionStatsSpeed ? (
                            <span className="whitespace-nowrap text-[10px] leading-4 text-[var(--app-hint)] md:hidden">
                                {sessionStatsSpeed}
                            </span>
                        ) : null}
                        {sessionStatsUsage ? (
                            <span className="hidden whitespace-nowrap text-[10px] leading-4 text-[var(--app-hint)] md:inline">
                                {sessionStatsUsage}
                            </span>
                        ) : null}
                        {sessionStatsCacheHit ? (
                            <span className="whitespace-nowrap text-[10px] leading-4 text-[var(--app-hint)] md:hidden">
                                {sessionStatsCacheHit}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <div className="flex min-w-0 shrink-0 items-baseline gap-2">
                {reasoningLabel ? (
                    <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                        <span className="sm:hidden">{compactReasoningLabel}</span>
                        <span className="hidden sm:inline">{reasoningLabel}</span>
                    </span>
                ) : null}
                {codexFastMode ? (
                    <span className="whitespace-nowrap text-xs text-[#34C759]">
                        fast
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {copilotAgentModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {copilotAgentModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
            </div>
        </div>
    )
}
