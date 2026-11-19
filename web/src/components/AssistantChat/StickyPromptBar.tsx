import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

/** Keep in sync with the `h-10` inner row. */
export const STICKY_PROMPT_BAR_HEIGHT_PX = 40
/** Breathing room between the bar and the first readable row. */
export const STICKY_PROMPT_READING_GAP_PX = 12

type PromptRect = {
    top: number
    bottom: number
}

/**
 * Pick the turn whose question the sticky bar should pin.
 *
 * The turn is the last prompt whose *top* crossed the reading line, not the
 * last whose bottom did: when the viewport lands in the gap above a prompt,
 * the visible content still belongs to the previous turn. The bar hides while
 * the pinned prompt itself is visible — the bubble is its own header.
 *
 * @internal Exported for unit testing.
 */
export function findPinnedPromptIndex(
    rects: readonly PromptRect[],
    viewportTop: number,
    readingOffsetPx: number = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX
): number | null {
    const readingLine = viewportTop + readingOffsetPx
    let turnIndex = -1
    for (let index = 0; index < rects.length; index += 1) {
        if (rects[index].top <= readingLine) {
            turnIndex = index
        }
    }
    if (turnIndex === -1) {
        return null
    }
    if (rects[turnIndex].bottom > readingLine) {
        return null
    }
    return turnIndex
}

type PinnedPrompt = {
    item: ConversationOutlineItem
    /** Index among the prompts currently rendered in the message window. */
    renderedIndex: number
    renderedTotal: number
    /** Index in the session-wide outline index. */
    position: number
    total: number
}

type StickyPromptBarProps = {
    viewportRef: RefObject<HTMLDivElement | null>
    contentRef: RefObject<HTMLDivElement | null>
    items: readonly ConversationOutlineItem[]
    /** Message/history revision; re-measure when the rendered window swaps. */
    revision: number | string
    /** Search jumps and the outline drawer own the top edge while open. */
    hidden?: boolean
    onLocate: (item: ConversationOutlineItem) => void
    onNavigate: (item: ConversationOutlineItem) => void
}

/**
 * Pins the question of the turn currently under the reading line to the top
 * of the thread. Kept out of the scroll container so the bar itself never
 * affects the message layout or the scroll anchors.
 */
export function StickyPromptBar(props: StickyPromptBarProps) {
    const { t, locale } = useTranslation()
    const [pinned, setPinned] = useState<PinnedPrompt | null>(null)
    const pinnedRef = useRef<PinnedPrompt | null>(null)
    const renderedItemsRef = useRef<readonly ConversationOutlineItem[]>([])

    const itemByAnchorId = useMemo(() => {
        const map = new Map<string, ConversationOutlineItem>()
        for (const item of props.items) {
            map.set(getConversationMessageAnchorId(item.targetMessageId), item)
        }
        return map
    }, [props.items])

    const indexById = useMemo(() => {
        const map = new Map<string, number>()
        props.items.forEach((item, index) => {
            map.set(item.id, index)
        })
        return map
    }, [props.items])

    const publish = useCallback((next: PinnedPrompt | null) => {
        const current = pinnedRef.current
        const unchanged = current?.item === next?.item
            && current?.renderedIndex === next?.renderedIndex
            && current?.renderedTotal === next?.renderedTotal
            && current?.position === next?.position
            && current?.total === next?.total
        if (unchanged) {
            return
        }
        pinnedRef.current = next
        setPinned(next)
    }, [])

    const sync = useCallback(() => {
        const viewport = props.viewportRef.current
        const content = props.contentRef.current
        if (!viewport || !content) {
            renderedItemsRef.current = []
            publish(null)
            return
        }

        const viewportTop = viewport.getBoundingClientRect().top
        const items: ConversationOutlineItem[] = []
        const rects: PromptRect[] = []
        // Only prompts that are both rendered and indexed can be pinned; CLI
        // output and system notes share the user role attribute but miss the
        // outline anchor id, so the map lookup filters them out.
        content.querySelectorAll<HTMLElement>('[data-hapi-message-role="user"]').forEach((element) => {
            const item = itemByAnchorId.get(element.id)
            if (!item) {
                return
            }
            // Measure the bubble, not the message root: the root also owns the
            // hover action row, which would delay the bar by its full height.
            const measured = element.querySelector<HTMLElement>('.happy-user-bubble') ?? element
            const rect = measured.getBoundingClientRect()
            items.push(item)
            rects.push({ top: rect.top, bottom: rect.bottom })
        })
        renderedItemsRef.current = items

        const index = findPinnedPromptIndex(rects, viewportTop)
        if (index === null) {
            publish(null)
            return
        }
        const item = items[index]
        publish({
            item,
            renderedIndex: index,
            renderedTotal: items.length,
            position: (indexById.get(item.id) ?? index) + 1,
            total: Math.max(props.items.length, items.length)
        })
    }, [itemByAnchorId, indexById, props.contentRef, props.items.length, props.viewportRef, publish])

    useEffect(() => {
        const viewport = props.viewportRef.current
        if (!viewport) {
            return
        }
        let frame = 0
        const schedule = () => {
            if (frame !== 0) {
                return
            }
            frame = requestAnimationFrame(() => {
                frame = 0
                sync()
            })
        }
        viewport.addEventListener('scroll', schedule, { passive: true })
        window.addEventListener('resize', schedule)
        schedule()
        return () => {
            viewport.removeEventListener('scroll', schedule)
            window.removeEventListener('resize', schedule)
            if (frame !== 0) {
                cancelAnimationFrame(frame)
            }
        }
    }, [props.viewportRef, props.revision, props.hidden, sync])

    const step = useCallback((direction: -1 | 1) => {
        // Re-measure first so a click on a fast-scrolling viewport still steps
        // from the turn the reader actually sees.
        sync()
        const current = pinnedRef.current
        if (!current) {
            return
        }
        const target = renderedItemsRef.current[current.renderedIndex + direction]
        if (target) {
            props.onNavigate(target)
        }
    }, [props.onNavigate, sync])

    const visible = pinned !== null && props.hidden !== true
    const createdAt = pinned ? new Date(pinned.item.createdAt) : null
    const canGoPrevious = Boolean(pinned && pinned.renderedIndex > 0)
    const canGoNext = Boolean(pinned && pinned.renderedIndex + 1 < pinned.renderedTotal)
    const locateLabel = t('session.stickyPrompt.locate')

    return (
        <div
            role="region"
            aria-label={t('session.stickyPrompt.region')}
            aria-hidden={!visible}
            inert={!visible}
            data-testid="sticky-prompt-bar"
            data-visible={visible ? 'true' : 'false'}
            className={cn(
                'absolute inset-x-0 top-0 z-10 border-b border-[var(--app-border)] bg-[var(--app-bg)]/85 backdrop-blur-md',
                'transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none',
                visible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
            )}
        >
            <div className="mx-auto flex h-10 w-full max-w-content min-w-0 items-center gap-2 px-3">
                <button
                    type="button"
                    onClick={() => {
                        if (pinned) {
                            props.onLocate(pinned.item)
                        }
                    }}
                    disabled={pinned === null}
                    title={locateLabel}
                    aria-label={locateLabel}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <QuoteIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />
                    <span className="truncate text-[13px] leading-none text-[var(--app-fg)]/90">
                        {pinned?.item.label ?? ''}
                    </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 text-[var(--app-hint)]">
                    {pinned ? (
                        <span
                            className="mr-1 border-r border-[var(--app-border)] pr-2 text-[11px] leading-none tabular-nums"
                            aria-label={t('session.stickyPrompt.position', {
                                current: pinned.position,
                                total: pinned.total
                            })}
                        >
                            {pinned.position} / {pinned.total}
                        </span>
                    ) : null}
                    {createdAt ? (
                        <time
                            dateTime={createdAt.toISOString()}
                            title={formatMessageTimestampTitle(createdAt)}
                            className="px-1 text-xs leading-none tabular-nums"
                        >
                            {formatOutlineTimestamp(createdAt, locale)}
                        </time>
                    ) : null}
                    <BarButton
                        label={locateLabel}
                        disabled={pinned === null}
                        onClick={() => {
                            if (pinned) {
                                props.onLocate(pinned.item)
                            }
                        }}
                    >
                        <LocateIcon className="h-3.5 w-3.5" />
                    </BarButton>
                    <BarButton
                        label={t('session.stickyPrompt.previous')}
                        disabled={!canGoPrevious}
                        onClick={() => step(-1)}
                    >
                        <ChevronUpIcon className="h-3.5 w-3.5" />
                    </BarButton>
                    <BarButton
                        label={t('session.stickyPrompt.next')}
                        disabled={!canGoNext}
                        onClick={() => step(1)}
                    >
                        <ChevronDownIcon className="h-3.5 w-3.5" />
                    </BarButton>
                </div>
            </div>
        </div>
    )
}

function BarButton(props: {
    label: string
    disabled?: boolean
    onClick: () => void
    children: ReactNode
}) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            disabled={props.disabled}
            title={props.label}
            aria-label={props.label}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--app-hint)]"
        >
            {props.children}
        </button>
    )
}

function QuoteIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M10 6.5C7 8 5.2 10.6 5.2 14c0 3.2 1.8 5.4 4.4 5.4 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.4-3.2-3.4-.4 0-.8 0-1 .1.3-1.6 1.6-3.1 3.3-4.1L10 6.5Zm9.2 0C16.2 8 14.4 10.6 14.4 14c0 3.2 1.8 5.4 4.4 5.4 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.4-3.2-3.4-.4 0-.8 0-1 .1.3-1.6 1.6-3.1 3.3-4.1l-2.5-1.8Z" />
        </svg>
    )
}

function LocateIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
    )
}

function ChevronUpIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m18 15-6-6-6 6" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}
